#!/usr/bin/env node
import { render } from "ink";
import { getBackend, pickBackend, setupGuideText } from "./backends/index.js";
import type { BackendId } from "./backends/types.js";
import readline from "node:readline/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { HELP_TEXT, parseArgs } from "./commands.js";
import { VERSION, WIKI_DIR, WORKFLOW_PATH } from "./constants.js";
import { buildEnrichPrompt, scanQueue } from "./engine/queue.js";
import {
  patchMeta,
  readMeta,
  saveBackendPreference,
  wikiDir,
  wikiExists,
} from "./engine/wiki.js";
import {
  pauseCursorRule,
  removeAgentPointers,
  removeCursorHook,
  removeCursorRule,
  removeWorkflow,
  removePausedRuleArtifact,
  resumeCursorRule,
  writeCursorHooks,
  writeWorkflow,
} from "./emitters/integrations.js";
import { DoctorApp, GenerateApp, StatusApp } from "./ui/App.js";

const command = parseArgs(process.argv.slice(2));
const root = process.cwd();

async function main(): Promise<void> {
  switch (command.kind) {
    case "help":
      process.stdout.write(HELP_TEXT);
      return;

    case "version":
      process.stdout.write(`agentwiki v${VERSION}\n`);
      return;

    case "error":
      process.stderr.write(`error: ${command.message}\n\n${HELP_TEXT}`);
      process.exitCode = 2;
      return;

    case "init":
    case "update": {
      if (command.kind === "update" && !(await wikiExists(root))) {
        process.stderr.write(
          `No wiki found in ${WIKI_DIR}/ — run \`agentwiki init\` first.\n`,
        );
        process.exitCode = 1;
        return;
      }

      const meta = await readMeta(root);
      if (meta?.paused) {
        if (command.kind === "update") {
          // No-op so stray hooks/CI can't churn a paused setup.
          process.stdout.write(
            "agentwiki is paused — update skipped. Run `agentwiki resume` to re-enable.\n",
          );
          return;
        }
        // init while paused implies resume.
        await removePausedRuleArtifact(root);
        await patchMeta(root, { paused: false });
      }

      render(<GenerateApp mode={command.kind} root={root} />);
      return;
    }

    case "doctor":
      render(<DoctorApp root={root} />);
      return;

    case "status":
      render(<StatusApp root={root} />);
      return;

    case "backend": {
      if (command.backend === null) {
        const meta = await readMeta(root);
        process.stdout.write(
          meta?.backend
            ? `Preferred backend: ${meta.backend}\n`
            : "No preferred backend saved. Set one with: agentwiki backend <cursor|claude>\n",
        );
        return;
      }

      const backend = getBackend(command.backend);
      const status = await backend.detect();
      await saveBackendPreference(root, command.backend);
      process.stdout.write(`Preferred backend saved: ${backend.label}\n`);

      const guide = setupGuideText(backend, status);
      if (guide.length > 0) {
        process.stdout.write(
          `note: ${backend.label} is not ready yet (${status.installed ? status.authDetail : "not installed"}).\n${guide.join("\n")}\n`,
        );
      }
      return;
    }

    case "queue": {
      const items = await scanQueue(root);

      if (command.json) {
        process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
        return;
      }

      if (items.length === 0) {
        process.stdout.write("✔ No prose slots need writing — wiki is fresh.\n");
        return;
      }

      process.stdout.write(
        `${items.length} prose slot${items.length === 1 ? "" : "s"} need writing:\n\n`,
      );
      for (const item of items) {
        process.stdout.write(
          `  ${item.status === "stale" ? "▲ stale" : "○ empty"}  ${item.file} → ${item.slot}\n`,
        );
      }
      process.stdout.write(
        "\nRun `agentwiki enrich` to have your coding agent write them.\n",
      );
      return;
    }

    case "pause": {
      if (!(await wikiExists(root))) {
        process.stderr.write(`No wiki found in ${WIKI_DIR}/ — nothing to pause.\n`);
        process.exitCode = 1;
        return;
      }
      const meta = await readMeta(root);
      if (meta?.paused) {
        process.stdout.write("agentwiki is already paused.\n");
        return;
      }

      await pauseCursorRule(root);
      const hook = await removeCursorHook(root);
      await patchMeta(root, { paused: true });

      process.stdout.write(
        [
          "⏸ agentwiki paused. Your docs in " + WIKI_DIR + "/ are untouched.",
          "  - Cursor rule disabled (renamed to agentwiki.mdc.paused)",
          hook.action !== "absent"
            ? "  - Cursor stop-hook detached from .cursor/hooks.json"
            : "  - No Cursor hook found (already detached)",
          "  - `agentwiki update` is now a no-op until you run `agentwiki resume`",
          "",
        ].join("\n"),
      );
      return;
    }

    case "resume": {
      const meta = await readMeta(root);
      if (!meta?.paused) {
        process.stdout.write("agentwiki is not paused.\n");
        return;
      }

      await resumeCursorRule(root);
      await writeCursorHooks(root);
      await patchMeta(root, { paused: false });

      process.stdout.write(
        "▶ agentwiki resumed — Cursor rule and hook are re-attached.\n  Consider running `agentwiki update` to refresh facts now.\n",
      );
      return;
    }

    case "remove":
      await runRemove(command.docs, command.yes);
      return;

    case "uninstall":
      await runUninstall(command.yes);
      return;

    case "setup-action": {
      const result = await writeWorkflow(root);
      process.stdout.write(
        result.action === "unchanged"
          ? `${WORKFLOW_PATH} already up to date.\n`
          : `${result.action === "created" ? "Created" : "Updated"} ${WORKFLOW_PATH}.\nThe default job refreshes fact blocks with no secrets. To enable prose\nenrichment on your existing subscription, uncomment one block inside the\nfile and add the matching repository secret (CURSOR_API_KEY or\nCLAUDE_CODE_OAUTH_TOKEN).\n`,
      );
      return;
    }

    case "enrich":
      await runEnrich(command.backend, command.dryRun);
      return;
  }
}

async function runRemove(docs: boolean, yes: boolean): Promise<void> {
  const planned = [
    ".cursor/rules/agentwiki.mdc (and any .paused copy)",
    ".cursor/hooks.json — agentwiki entries only (file deleted if nothing else remains)",
    "AGENTS.md / CLAUDE.md — the '## AgentWiki' section only (file deleted if it becomes empty)",
    `${WORKFLOW_PATH} (if present)`,
    docs
      ? `${WIKI_DIR}/ — ALL generated docs AND agent-written prose (--docs)`
      : `${WIKI_DIR}/.agentwiki.json metadata only — your docs and prose are KEPT`,
  ];

  process.stdout.write(
    `This will remove the agentwiki setup from ${root}:\n\n${planned
      .map((line) => `  - ${line}`)
      .join("\n")}\n\n`,
  );

  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Refusing to remove without confirmation in a non-interactive shell. Re-run with --yes.\n",
      );
      process.exitCode = 1;
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
    rl.close();

    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("Aborted — nothing was changed.\n");
      return;
    }
  }

  const results = [
    await removeCursorRule(root),
    await removeCursorHook(root),
    ...(await removeAgentPointers(root)),
    await removeWorkflow(root),
  ];

  for (const result of results) {
    if (result.action !== "absent") {
      process.stdout.write(
        `  ${result.action === "removed" ? "removed " : "detached"} ${result.path}\n`,
      );
    }
  }

  if (docs) {
    await fs.rm(wikiDir(root), { recursive: true, force: true });
    process.stdout.write(`  removed  ${WIKI_DIR}/\n`);
  } else {
    await fs.rm(path.join(wikiDir(root), ".agentwiki.json"), { force: true });
    process.stdout.write(
      `\n✔ Integrations removed. Your documentation is still in ${WIKI_DIR}/ —\n  it is plain markdown and stays useful (the agentwiki HTML comments are\n  invisible when rendered). Run \`agentwiki init\` any time to re-wire.\n`,
    );
    return;
  }

  process.stdout.write("\n✔ agentwiki fully removed.\n");
}

async function runUninstall(yes: boolean): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  // npm is npm.cmd on Windows; shell resolves it on every platform.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  let installedGlobally = false;
  try {
    await execFileAsync(npm, ["ls", "-g", "agentwiki", "--depth=0"], {
      timeout: 30_000,
    });
    installedGlobally = true;
  } catch {
    installedGlobally = false;
  }

  if (!installedGlobally) {
    process.stdout.write(
      "agentwiki is not installed globally on this computer (you may be\nrunning it via npx or directly from a source folder), so there is\nnothing to uninstall. If you run it from a source folder, just delete\nthat folder.\n",
    );
    return;
  }

  process.stdout.write(
    [
      "This removes the `agentwiki` command from this computer.",
      "",
      "It does NOT touch any of your projects: documentation, Cursor rules,",
      "and hooks stay exactly as they are. If you also want those gone, run",
      "`agentwiki remove` inside each project FIRST (you can't run it after",
      "the command is uninstalled).",
      "",
    ].join("\n"),
  );

  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Refusing to uninstall without confirmation in a non-interactive shell. Re-run with --yes.\n",
      );
      process.exitCode = 1;
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = (await rl.question("Uninstall agentwiki? [y/N] "))
      .trim()
      .toLowerCase();
    rl.close();

    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("Aborted — nothing was changed.\n");
      return;
    }
  }

  try {
    await execFileAsync(npm, ["rm", "-g", "agentwiki"], { timeout: 120_000 });
    process.stdout.write(
      "✔ agentwiki has been uninstalled from this computer. Goodbye!\n",
    );
  } catch (error) {
    process.stderr.write(
      `✖ Could not uninstall automatically (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).\n  Your computer may require administrator rights for this — try:\n    sudo npm rm -g agentwiki\n`,
    );
    process.exitCode = 1;
  }
}

async function runEnrich(
  explicit: BackendId | null,
  dryRun: boolean,
): Promise<void> {
  if (!(await wikiExists(root))) {
    process.stderr.write(
      `No wiki found in ${WIKI_DIR}/ — run \`agentwiki init\` first.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const items = await scanQueue(root);

  if (items.length === 0) {
    process.stdout.write("✔ Nothing to enrich — all prose slots are fresh.\n");
    return;
  }

  const prompt = buildEnrichPrompt(items);

  if (dryRun) {
    process.stdout.write(
      `Would enrich ${items.length} slot(s) with this prompt:\n\n${prompt}\n`,
    );
    return;
  }

  const meta = await readMeta(root);
  const { choice, all } = await pickBackend(explicit, meta?.backend);

  if (!choice) {
    process.stderr.write(
      "No usable coding agent found. agentwiki does not call any LLM itself —\nit borrows the agent you already have a subscription for. Pick ONE of\nthese to set up (Cursor if you use the Cursor editor, Claude Code if you\nhave a Claude subscription):\n\n",
    );
    for (const { backend, status } of all) {
      const guide = setupGuideText(backend, status);
      if (guide.length > 0) {
        process.stderr.write(`${guide.join("\n")}\n\n`);
      }
    }
    process.exitCode = 1;
    return;
  }

  const { backend, status } = choice;

  if (!status.installed || status.auth === "missing") {
    process.stderr.write(
      `${backend.label} is not ready: ${status.installed ? status.authDetail : "not installed"}.\n${setupGuideText(backend, status).join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Enriching ${items.length} prose slot(s) with ${backend.label} (${status.authDetail})…\n\n`,
  );

  const result = await backend.enrich(prompt, root, (chunk) => {
    process.stdout.write(chunk);
  });

  process.stdout.write("\n");

  if (result.authFailed) {
    process.stderr.write(
      `\n✖ ${backend.label} authentication failed — your login/token has likely expired.\n  Fix it with: ${backend.loginHint}\n  Then re-run: agentwiki enrich\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    process.stderr.write(
      `\n✖ ${backend.label} exited with code ${result.exitCode ?? "?"} — see output above.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const remaining = await scanQueue(root);
  const written = items.length - remaining.length;

  if (remaining.length === 0) {
    process.stdout.write(
      `✔ All ${items.length} slot(s) written — wiki is fully fresh.\n`,
    );
  } else {
    process.stdout.write(
      `✔ ${written} slot(s) written, ${remaining.length} still pending (re-run \`agentwiki enrich\` or see \`agentwiki queue\`).\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
