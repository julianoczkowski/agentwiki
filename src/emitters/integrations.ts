import fs from "node:fs/promises";
import path from "node:path";
import {
  CURSOR_HOOKS_PATH,
  CURSOR_RULE_PATH,
  WIKI_DIR,
  WORKFLOW_PATH,
} from "../constants.js";

export interface IntegrationResult {
  path: string;
  action: "created" | "updated" | "unchanged";
}

const CURSOR_RULE_CONTENT = `---
description: AgentWiki — repository documentation maintenance
alwaysApply: true
---

This repository has an agent-maintained wiki in \`${WIKI_DIR}/\`.

- Before exploring the codebase, read \`${WIKI_DIR}/quickstart.md\` and follow its links for context. Prefer the wiki over cold exploration.
- Wiki pages contain machine-owned fact blocks (\`<!-- agentwiki:facts ... -->\`) and agent-owned prose slots (\`<!-- agentwiki:prose ... -->\`). NEVER edit fact blocks — they are regenerated deterministically by the \`agentwiki\` CLI.
- After completing a task that changed code, run \`agentwiki queue --json\`. If it lists empty or stale prose slots related to files you touched, fill them: edit only the text between the prose markers, then set \`status="fresh"\` and \`facts-hash\` to the value reported by the queue for that slot.
- Keep prose slots to 1-3 tight paragraphs, grounded in code you actually inspected.
`;

const AGENTS_SECTION_HEADING = "## AgentWiki";

const AGENTS_SECTION = `${AGENTS_SECTION_HEADING}

This repository has documentation located in the \`${WIKI_DIR}/\` directory, maintained by the \`agentwiki\` CLI.

Start here:
- [Quickstart](${WIKI_DIR}/quickstart.md)
- [Architecture](${WIKI_DIR}/architecture.md)
- [Recent activity](${WIKI_DIR}/activity.md)

When working in this repository, read the quickstart first, then follow its links to module pages. Pages mix machine-generated fact blocks (never edit these) with prose sections you may be asked to write via \`agentwiki queue\`.
`;

export async function writeCursorRule(root: string): Promise<IntegrationResult> {
  return writeIfChanged(path.join(root, CURSOR_RULE_PATH), CURSOR_RULE_CONTENT);
}

export async function writeCursorHooks(
  root: string,
): Promise<IntegrationResult> {
  const hooksPath = path.join(root, CURSOR_HOOKS_PATH);
  const ourHook = { command: "agentwiki update" };

  let existing: { version?: number; hooks?: Record<string, unknown[]> } | null =
    null;
  try {
    existing = JSON.parse(await fs.readFile(hooksPath, "utf8"));
  } catch {
    existing = null;
  }

  if (existing === null) {
    const content = `${JSON.stringify(
      { version: 1, hooks: { stop: [ourHook] } },
      null,
      2,
    )}\n`;
    return writeIfChanged(hooksPath, content);
  }

  const hooks = existing.hooks ?? {};
  const stopHooks = Array.isArray(hooks.stop) ? hooks.stop : [];
  const alreadyWired = stopHooks.some(
    (hook) =>
      typeof hook === "object" &&
      hook !== null &&
      (hook as { command?: string }).command?.startsWith("agentwiki"),
  );

  if (alreadyWired) {
    return { path: CURSOR_HOOKS_PATH, action: "unchanged" };
  }

  hooks.stop = [...stopHooks, ourHook];
  existing.hooks = hooks;
  existing.version = existing.version ?? 1;

  await fs.writeFile(hooksPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return { path: CURSOR_HOOKS_PATH, action: "updated" };
}

/**
 * Insert or refresh the AgentWiki section in AGENTS.md / CLAUDE.md.
 * Mirrors openwiki's behavior: update both if both exist, create AGENTS.md
 * if neither does, and preserve all surrounding content.
 */
export async function writeAgentPointers(
  root: string,
): Promise<IntegrationResult[]> {
  const results: IntegrationResult[] = [];
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  const existing: string[] = [];

  for (const candidate of candidates) {
    try {
      await fs.access(path.join(root, candidate));
      existing.push(candidate);
    } catch {
      // absent
    }
  }

  const targets = existing.length > 0 ? existing : ["AGENTS.md"];

  for (const target of targets) {
    const filePath = path.join(root, target);
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      content = "";
    }

    const updated = upsertSection(content, AGENTS_SECTION);

    if (updated === content) {
      results.push({ path: target, action: "unchanged" });
    } else {
      await fs.writeFile(filePath, updated, "utf8");
      results.push({
        path: target,
        action: content === "" ? "created" : "updated",
      });
    }
  }

  return results;
}

function upsertSection(content: string, section: string): string {
  const trimmedSection = `${section.trim()}\n`;

  if (content.trim().length === 0) {
    return trimmedSection;
  }

  const headingIndex = content.indexOf(AGENTS_SECTION_HEADING);

  if (headingIndex === -1) {
    return `${content.replace(/\n+$/, "")}\n\n${trimmedSection}`;
  }

  // Replace from our heading to the next same-level heading (or EOF).
  const afterHeading = content.slice(headingIndex + AGENTS_SECTION_HEADING.length);
  const nextHeading = afterHeading.search(/^## /m);
  const end =
    nextHeading === -1
      ? content.length
      : headingIndex + AGENTS_SECTION_HEADING.length + nextHeading;

  const before = content.slice(0, headingIndex).replace(/\n+$/, "\n\n");
  const after = content.slice(end);

  return `${before}${trimmedSection}${after ? `\n${after}` : ""}`;
}

const WORKFLOW_CONTENT = `name: agentwiki
on:
  push:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  refresh-facts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Refresh wiki fact blocks (deterministic, no keys needed)
        run: npx agentwiki update
      - name: Commit refreshed facts
        run: |
          if [[ -n "$(git status --porcelain agentwiki/)" ]]; then
            git config user.name "agentwiki-bot"
            git config user.email "agentwiki-bot@users.noreply.github.com"
            git add agentwiki/
            git commit -m "docs: refresh agentwiki fact blocks"
            git push
          fi

      # OPTIONAL prose enrichment using your existing agent subscription.
      # Uncomment ONE of the blocks below and add the secret to enable it.
      #
      # Cursor (add CURSOR_API_KEY from cursor.com/dashboard -> API Keys):
      # - name: Install Cursor CLI
      #   run: |
      #     curl https://cursor.com/install -fsS | bash
      #     echo "$HOME/.cursor/bin" >> $GITHUB_PATH
      # - name: Write stale prose
      #   env:
      #     CURSOR_API_KEY: \${{ secrets.CURSOR_API_KEY }}
      #   run: npx agentwiki enrich --backend cursor
      #
      # Claude Code (run \`claude setup-token\` locally, save as CLAUDE_CODE_OAUTH_TOKEN;
      # note: Anthropic points team-owned pipelines to API keys instead):
      # - name: Install Claude Code
      #   run: npm install -g @anthropic-ai/claude-code
      # - name: Write stale prose
      #   env:
      #     CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      #   run: npx agentwiki enrich --backend claude
`;

export async function writeWorkflow(root: string): Promise<IntegrationResult> {
  return writeIfChanged(path.join(root, WORKFLOW_PATH), WORKFLOW_CONTENT);
}

async function writeIfChanged(
  filePath: string,
  content: string,
): Promise<IntegrationResult> {
  const relPath = filePath;
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    existing = null;
  }

  if (existing === content) {
    return { path: relPath, action: "unchanged" };
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return { path: relPath, action: existing === null ? "created" : "updated" };
}
