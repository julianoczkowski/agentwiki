import type { BackendId } from "./backends/types.js";
import { isBackendId } from "./backends/index.js";
import { VERSION } from "./constants.js";

export type Command =
  | { kind: "init" }
  | { kind: "update" }
  | { kind: "status" }
  | { kind: "doctor" }
  | { kind: "queue"; json: boolean }
  | {
      kind: "enrich";
      backend: BackendId | null;
      dryRun: boolean;
      verbose: boolean;
    }
  | { kind: "backend"; backend: BackendId | null }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "remove"; docs: boolean; yes: boolean }
  | { kind: "uninstall"; yes: boolean }
  | { kind: "setup-action" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export function parseArgs(argv: string[]): Command {
  const [first, ...rest] = argv;

  if (!first || first === "help" || first === "--help" || first === "-h") {
    return { kind: "help" };
  }

  if (first === "version" || first === "--version" || first === "-v") {
    return { kind: "version" };
  }

  switch (first) {
    case "init":
      return { kind: "init" };
    case "update":
      return { kind: "update" };
    case "status":
      return { kind: "status" };
    case "doctor":
      return { kind: "doctor" };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "remove":
      return {
        kind: "remove",
        docs: rest.includes("--docs"),
        yes: rest.includes("--yes") || rest.includes("-y"),
      };
    case "uninstall":
      return {
        kind: "uninstall",
        yes: rest.includes("--yes") || rest.includes("-y"),
      };
    case "setup-action":
      return { kind: "setup-action" };
    case "queue":
      return { kind: "queue", json: rest.includes("--json") };
    case "backend": {
      const value = rest.find((argument) => !argument.startsWith("-")) ?? null;
      if (value !== null && !isBackendId(value)) {
        return {
          kind: "error",
          message: `Unknown backend "${value}". Use: cursor | claude`,
        };
      }
      return { kind: "backend", backend: value };
    }
    case "enrich": {
      let backend: BackendId | null = null;
      const flagIndex = rest.indexOf("--backend");
      if (flagIndex !== -1) {
        const value = rest[flagIndex + 1];
        if (!value || !isBackendId(value)) {
          return {
            kind: "error",
            message: `--backend requires a value: cursor | claude`,
          };
        }
        backend = value;
      }
      return {
        kind: "enrich",
        backend,
        dryRun: rest.includes("--dry-run"),
        verbose: rest.includes("--verbose"),
      };
    }
    default:
      return { kind: "error", message: `Unknown command: ${first}` };
  }
}

export interface HelpRow {
  command: string;
  description: string;
}

export interface HelpGroup {
  title: string;
  rows: HelpRow[];
}

export const HELP_GROUPS: HelpGroup[] = [
  {
    title: "Create & Maintain",
    rows: [
      { command: "init", description: "Generate the wiki and wire agent integrations" },
      { command: "update", description: "Refresh fact blocks; flag prose whose facts changed" },
      { command: "status", description: "Wiki freshness per page/slot + backend readiness" },
      { command: "queue [--json]", description: "List prose slots that need writing" },
    ],
  },
  {
    title: "Prose — Your Agent Writes It",
    rows: [
      { command: "enrich", description: "Have your coding agent write the queued slots" },
      { command: "  --backend <cursor|claude>", description: "Override the saved choice for one run" },
      { command: "  --dry-run", description: "Print the prompt, run nothing" },
      {
        command: "  --verbose",
        description: "Stream the agent's raw output while it works",
      },
      { command: "backend", description: "Pick your prose writer interactively" },
      { command: "backend <cursor|claude>", description: "Save the choice directly" },
    ],
  },
  {
    title: "Lifecycle",
    rows: [
      { command: "pause / resume", description: "Pause automation (docs kept) and re-enable" },
      { command: "remove [--docs] [-y]", description: "Remove integrations; docs KEPT unless --docs" },
      { command: "setup-action", description: "(Re)write the GitHub Actions workflow" },
      { command: "uninstall [-y]", description: "Remove the CLI itself (projects untouched)" },
    ],
  },
  {
    title: "System",
    rows: [
      { command: "doctor", description: "Check node, git, backend install + auth state" },
      { command: "help / version", description: "This screen / version number" },
    ],
  },
];

export const HELP_EXAMPLES = [
  "npx @julianoczkowski/agentwiki init",
  "agentwiki enrich",
  "agentwiki backend",
  "agentwiki status",
];

export const HELP_INTRO =
  "Wiki pages mix machine-owned fact blocks (regenerated, never hand-edited) with prose written by the coding agent you already have — Cursor CLI or Claude Code, on your existing subscription. No API keys.";

export const HELP_TEXT = [
  `agentwiki v${VERSION} — deterministic codebase wiki, prose by the agent you already have`,
  "",
  "Usage: agentwiki <command> [options]",
  "",
  ...HELP_GROUPS.flatMap((group) => [
    `${group.title}`,
    ...group.rows.map(
      (row) => `  ${row.command.padEnd(28)}${row.description}`,
    ),
    "",
  ]),
  "Examples",
  ...HELP_EXAMPLES.map((example) => `  ${example}`),
  "",
].join("\n");
