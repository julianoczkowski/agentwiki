#!/usr/bin/env node
import { render } from "ink";
import { getBackend, pickBackend } from "./backends/index.js";
import type { BackendId } from "./backends/types.js";
import { HELP_TEXT, parseArgs } from "./commands.js";
import { VERSION, WIKI_DIR } from "./constants.js";
import { buildEnrichPrompt, scanQueue } from "./engine/queue.js";
import { readMeta, saveBackendPreference, wikiExists } from "./engine/wiki.js";
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

      if (!status.installed) {
        process.stdout.write(
          `note: ${backend.label} is not installed yet.\n  install: ${backend.installHint}\n  login:   ${backend.loginHint}\n`,
        );
      } else if (status.auth === "missing") {
        process.stdout.write(
          `note: ${backend.label} is installed but ${status.authDetail}.\n  login: ${backend.loginHint}\n`,
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

    case "enrich":
      await runEnrich(command.backend, command.dryRun);
      return;
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
      "No usable coding agent found. agentwiki does not call any LLM itself —\nit borrows the agent you already have a subscription for:\n\n",
    );
    for (const { backend, status } of all) {
      if (!status.installed) {
        process.stderr.write(
          `  ${backend.label}: not installed\n    install: ${backend.installHint}\n    login:   ${backend.loginHint}\n\n`,
        );
      } else if (status.auth === "missing") {
        process.stderr.write(
          `  ${backend.label}: ${status.authDetail}\n    login: ${backend.loginHint}\n\n`,
        );
      }
    }
    process.exitCode = 1;
    return;
  }

  const { backend, status } = choice;

  if (!status.installed) {
    process.stderr.write(
      `${backend.label} is not installed.\n  install: ${backend.installHint}\n  login:   ${backend.loginHint}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (status.auth === "missing") {
    process.stderr.write(
      `${backend.label}: ${status.authDetail}\n  Fix it with: ${backend.loginHint}\n`,
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
