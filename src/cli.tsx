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
  detectWorkspaceApps,
  type WorkspaceApp,
} from "./engine/workspaces.js";
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
  removeClaudeHook,
  removeCursorHook,
  removeCursorRule,
  removeWorkflow,
  removePausedRuleArtifact,
  resumeCursorRule,
  writeClaudeHooks,
  writeCursorHooks,
  writeWorkflow,
} from "./emitters/integrations.js";
import {
  BackendApp,
  DoctorApp,
  GenerateApp,
  HelpApp,
  StatusApp,
} from "./ui/App.js";
import * as plain from "./ui/plain.js";
import { paint } from "./ui/plain.js";

const command = parseArgs(process.argv.slice(2));
const root = process.cwd();

async function main(): Promise<void> {
  switch (command.kind) {
    case "help":
      render(<HelpApp />);
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

      let meta = await readMeta(root);

      // Explicit monorepo scope: validate, save, skip the interactive question.
      if (command.kind === "init" && command.scope !== null) {
        const scope = normalizeScope(command.scope);
        if (scope === null) {
          process.stderr.write(
            `error: --scope must be a directory inside this repository (got "${command.scope}").\n`,
          );
          process.exitCode = 2;
          return;
        }
        if (scope !== "") {
          const isDir = await fs
            .stat(path.join(root, scope))
            .then((stat) => stat.isDirectory())
            .catch(() => false);
          if (!isDir) {
            process.stderr.write(
              `error: --scope "${scope}" is not a directory in ${root}.\n`,
            );
            process.exitCode = 2;
            return;
          }
        }
        await patchMeta(root, { scope });
        meta = await readMeta(root);
      }

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

      // Very first step of a brand-new interactive init: in a monorepo, ask
      // which app the wiki should document. Never asked again once meta
      // exists — `update` and hooks must stay prompt-free.
      const detectedApps =
        command.kind === "init" &&
        command.scope === null &&
        Boolean(process.stdin.isTTY) &&
        meta === null
          ? await detectWorkspaceApps(root)
          : [];
      const scopeApps: WorkspaceApp[] =
        detectedApps.length >= 2 ? detectedApps : [];

      // Next step of an interactive init: pick which agent writes the prose.
      const askBackend =
        command.kind === "init" &&
        Boolean(process.stdin.isTTY) &&
        !meta?.backend;

      // Last step of an interactive init: offer to write the prose right away
      // (most users never come back for a second command).
      let enrichAfter = false;
      const instance = render(
        <GenerateApp
          askBackend={askBackend}
          scopeApps={scopeApps}
          mode={command.kind}
          onEnrichChosen={() => {
            enrichAfter = true;
          }}
          root={root}
        />,
      );
      await instance.waitUntilExit();

      if (enrichAfter) {
        process.stdout.write("\n");
        await runEnrich(null, false, false);
      }
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
        if (process.stdin.isTTY) {
          // Interactive re-pick, same select as the init first step.
          render(<BackendApp root={root} />);
          return;
        }

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
      const claudeHook = await removeClaudeHook(root);
      await patchMeta(root, { paused: true });

      process.stdout.write(
        [
          "⏸ agentwiki paused. Your docs in " + WIKI_DIR + "/ are untouched.",
          "  - Cursor rule disabled (renamed to agentwiki.mdc.paused)",
          hook.action !== "absent"
            ? "  - Cursor stop-hook detached from .cursor/hooks.json"
            : "  - No Cursor hook found (already detached)",
          claudeHook.action !== "absent"
            ? "  - Claude Code stop-hook detached from .claude/settings.json"
            : "  - No Claude Code hook found (already detached)",
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
      await writeClaudeHooks(root);
      await patchMeta(root, { paused: false });

      process.stdout.write(
        "▶ agentwiki resumed — Cursor rule and hook plus the Claude Code hook are re-attached.\n  Consider running `agentwiki update` to refresh facts now.\n",
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
      await runEnrich(command.backend, command.dryRun, command.verbose);
      return;
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);

  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/**
 * Live progress for enrich runs: an in-place spinner with elapsed time on a
 * TTY, periodic heartbeat lines otherwise. Backend output interrupts the
 * spinner cleanly and the spinner resumes underneath.
 */
function createEnrichProgress(
  label: string,
  slotCount: number,
): { interrupt: (text: string) => void; stop: () => void } {
  const startedAt = Date.now();
  const isTTY = Boolean(process.stdout.isTTY);
  let frame = 0;

  const spinnerLine = (): string =>
    `${paint.accent(SPINNER_FRAMES[frame])} ${paint.bold(label)} is working on ${slotCount} section(s)… ${formatElapsed(startedAt)}`;
  const clearLine = (): void => {
    if (isTTY) {
      process.stdout.write("\r\u001b[2K");
    }
  };

  const timer = isTTY
    ? setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        clearLine();
        process.stdout.write(spinnerLine());
      }, 120)
    : setInterval(() => {
        process.stdout.write(
          `… ${label} is still working (${formatElapsed(startedAt)})\n`,
        );
      }, 30_000);

  if (isTTY) {
    process.stdout.write(spinnerLine());
  }

  return {
    interrupt(text: string): void {
      clearLine();
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      if (isTTY) {
        process.stdout.write(spinnerLine());
      }
    },
    stop(): void {
      clearInterval(timer);
      clearLine();
    },
  };
}

/** Shown when zsh's compaudit warning leaks through the agent's shell. */
function insecureDirsHint(): string {
  return plain.thread(
    "About That zsh Warning",
    [
      plain.glyph.warn(
        `The "insecure directories" question comes from ${paint.bold("zsh on this Mac")}, not agentwiki — it appears inside your agent's shell and the run continues on its own.`,
      ),
      plain.line(
        `Permanent fix — run this once in your terminal, then it never appears again:`,
      ),
      plain.line(`  ${paint.accent("compaudit | xargs chmod g-w,o-w")}`),
    ],
    "that command removes group/other write access from zsh's completion folders",
  );
}

/**
 * Normalize a user-supplied --scope value to a repo-relative posix path.
 * "" means whole repository (clears a saved scope); null means rejected.
 */
function normalizeScope(input: string): string | null {
  const cleaned = input
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (cleaned === "" || cleaned === ".") {
    return "";
  }
  if (
    path.isAbsolute(cleaned) ||
    cleaned.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return cleaned;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  rl.close();

  return answer === "y" || answer === "yes";
}

async function runRemove(docs: boolean, yes: boolean): Promise<void> {
  const rows = [
    plain.line(`This removes the agentwiki setup from ${paint.bold(root)}:`),
    plain.glyph.pending(".cursor/rules/agentwiki.mdc (and any .paused copy)"),
    plain.glyph.pending(
      `.cursor/hooks.json — agentwiki entries only ${paint.gray("(other tools' hooks survive)")}`,
    ),
    plain.glyph.pending(
      `.claude/settings.json — agentwiki Stop hook only ${paint.gray("(your other settings survive)")}`,
    ),
    plain.glyph.pending(
      `AGENTS.md / CLAUDE.md — the AgentWiki section only ${paint.gray("(your other content survives)")}`,
    ),
    plain.glyph.pending(`${WORKFLOW_PATH} ${paint.gray("(if present)")}`),
    docs
      ? plain.glyph.warn(
          paint.yellow(
            `${WIKI_DIR}/ — ALL generated docs AND agent-written prose (--docs)`,
          ),
        )
      : plain.glyph.done(
          `${paint.green(`${WIKI_DIR}/ docs and prose are KEPT`)} ${paint.gray("— only the metadata file goes")}`,
        ),
  ];

  process.stdout.write(
    `${plain.thread("Remove AgentWiki From This Project", rows, "nothing is changed until you confirm")}\n\n`,
  );

  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Refusing to remove without confirmation in a non-interactive shell. Re-run with --yes.\n",
      );
      process.exitCode = 1;
      return;
    }

    if (!(await confirm(`${paint.accent("Proceed?")} [y/N] `))) {
      process.stdout.write(
        `${plain.glyph.done("Aborted — nothing was changed.")}\n`,
      );
      return;
    }
  }

  const results = [
    await removeCursorRule(root),
    await removeCursorHook(root),
    await removeClaudeHook(root),
    ...(await removeAgentPointers(root)),
    await removeWorkflow(root),
  ];

  const doneRows = results
    .filter((result) => result.action !== "absent")
    .map((result) =>
      plain.glyph.done(
        `${paint.gray(result.action === "removed" ? "removed " : "detached")} ${result.path}`,
      ),
    );

  if (docs) {
    await fs.rm(wikiDir(root), { recursive: true, force: true });
    doneRows.push(plain.glyph.done(`${paint.gray("removed ")} ${WIKI_DIR}/`));
    process.stdout.write(
      `\n${plain.thread("AgentWiki Fully Removed", doneRows, "thanks for trying it — npx @julianoczkowski/agentwiki init brings it back")}\n`,
    );
    return;
  }

  await fs.rm(path.join(wikiDir(root), ".agentwiki.json"), { force: true });
  doneRows.push(
    plain.glyph.done(
      `Your documentation is still in ${paint.bold(`${WIKI_DIR}/`)} — plain markdown, readable anywhere`,
    ),
  );
  process.stdout.write(
    `\n${plain.thread("Integrations Removed", doneRows, "run `agentwiki init` any time to re-wire")}\n`,
  );
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
      `${plain.thread(
        "Nothing To Uninstall",
        [
          plain.line(
            "agentwiki is not installed globally on this computer — you may be running it via npx or from a source folder.",
          ),
          plain.line(
            paint.gray("If you run it from a source folder, just delete that folder."),
          ),
        ],
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `${plain.thread(
      "Uninstall AgentWiki From This Computer",
      [
        plain.line("This removes the `agentwiki` command itself."),
        plain.glyph.done(
          `${paint.green("Your projects are NOT touched")} — docs, Cursor rules and hooks all stay as they are.`,
        ),
        plain.glyph.warn(
          `Want those gone too? Run ${paint.accent("agentwiki remove")} inside each project ${paint.bold("first")} — you can't run it after the command is uninstalled.`,
        ),
      ],
      "nothing is changed until you confirm",
    )}\n\n`,
  );

  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Refusing to uninstall without confirmation in a non-interactive shell. Re-run with --yes.\n",
      );
      process.exitCode = 1;
      return;
    }

    if (!(await confirm(`${paint.accent("Uninstall agentwiki?")} [y/N] `))) {
      process.stdout.write(
        `${plain.glyph.done("Aborted — nothing was changed.")}\n`,
      );
      return;
    }
  }

  try {
    await execFileAsync(npm, ["rm", "-g", "agentwiki"], { timeout: 120_000 });
    process.stdout.write(
      `${plain.glyph.done("agentwiki has been uninstalled from this computer. Goodbye!")}\n${plain.line(paint.gray(plain.link("https://www.youtube.com/@aiforwork_app", "youtube.com/@aiforwork_app")))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${plain.glyph.fail(`Could not uninstall automatically (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`)}\n  Your computer may require administrator rights for this — try:\n    ${paint.accent("sudo npm rm -g agentwiki")}\n`,
    );
    process.exitCode = 1;
  }
}

async function runEnrich(
  explicit: BackendId | null,
  dryRun: boolean,
  verbose: boolean,
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

  const meta = await readMeta(root);
  const prompt = buildEnrichPrompt(items, meta?.scope);

  if (dryRun) {
    process.stdout.write(
      `Would enrich ${items.length} slot(s) with this prompt:\n\n${prompt}\n`,
    );
    return;
  }
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
    `${plain.thread(
      `Writing Prose with ${backend.label}`,
      [
        plain.line(
          `${paint.bold(String(items.length))} slot(s) queued · ${status.authDetail}`,
        ),
        plain.line(
          "your agent explores the repo and writes each section — this can take a few minutes",
        ),
      ],
      "keep this terminal open — live progress below",
    )}\n\n`,
  );

  const progress = createEnrichProgress(backend.label, items.length);
  let sawInsecureDirs = false;
  let capturedOutput = "";

  const result = await backend.enrich(prompt, root, (chunk) => {
    capturedOutput += chunk;

    // The agent's prose lands in the wiki files; its chatter stays out of
    // the terminal unless the user asked for it.
    if (verbose) {
      progress.interrupt(chunk);
    }

    if (!sawInsecureDirs && /insecure directories/i.test(chunk)) {
      sawInsecureDirs = true;
      progress.interrupt(`\n${insecureDirsHint()}\n\n`);
    }
  });

  progress.stop();
  process.stdout.write("\n");

  if (result.authFailed || !result.ok) {
    if (!verbose && capturedOutput.trim().length > 0) {
      const tail = capturedOutput.trim().split("\n").slice(-15).join("\n");
      process.stderr.write(`${tail}\n\n`);
    }

    process.stderr.write(
      result.authFailed
        ? `${plain.glyph.fail(`${backend.label} authentication failed — your login/token has likely expired.`)}\n  Fix it with: ${paint.accent(backend.loginHint)}\n  Then re-run: ${paint.accent("agentwiki enrich")}\n`
        : `${plain.glyph.fail(`${backend.label} exited with code ${result.exitCode ?? "?"} — output above.`)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Deterministic summary: which files got which slots written, computed
  // from the queue diff — never from the agent's own claims.
  const remaining = await scanQueue(root);
  const remainingKeys = new Set(
    remaining.map((item) => `${item.file}#${item.slot}`),
  );
  const writtenByFile = new Map<string, string[]>();
  const pendingByFile = new Map<string, string[]>();

  for (const item of items) {
    const target = remainingKeys.has(`${item.file}#${item.slot}`)
      ? pendingByFile
      : writtenByFile;
    target.set(item.file, [...(target.get(item.file) ?? []), item.slot]);
  }

  const written = items.length - remaining.length;
  const rows = [
    ...[...writtenByFile.entries()].map(([file, slots]) =>
      plain.glyph.done(`${paint.bold(file.padEnd(36))} ${slots.join(" · ")}`),
    ),
    ...[...pendingByFile.entries()].map(([file, slots]) =>
      plain.glyph.warn(
        `${file.padEnd(36)} ${slots.join(" · ")} ${paint.yellow("(still pending)")}`,
      ),
    ),
  ];

  if (rows.length === 0) {
    rows.push(plain.line("No slots changed."));
  }

  process.stdout.write(
    `${plain.thread(
      "Prose Written",
      rows,
      remaining.length === 0
        ? `all ${items.length} slots written — wiki is fully fresh`
        : `${written} of ${items.length} slots written — re-run \`agentwiki enrich\` for the rest`,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
