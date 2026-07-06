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
- After completing a task, run \`npx -y @julianoczkowski/agentwiki@latest queue --json\`. If it lists ANY empty or stale prose slots, fill them (prioritize slots related to files you touched, but do not leave others empty): edit only the text between the prose markers, then set \`status="fresh"\` and \`facts-hash\` to the value reported by the queue for that slot.
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

/** npx form so the hook works even when the user only ever uses npx. */
const HOOK_COMMAND = "npx -y @julianoczkowski/agentwiki@latest update";

function isOurHook(hook: unknown): hook is { command: string } {
  if (typeof hook !== "object" || hook === null) {
    return false;
  }
  const command = (hook as { command?: string }).command ?? "";
  return (
    command.startsWith("agentwiki") ||
    command.includes("@julianoczkowski/agentwiki")
  );
}

export async function writeCursorHooks(
  root: string,
): Promise<IntegrationResult> {
  const hooksPath = path.join(root, CURSOR_HOOKS_PATH);
  const ourHook = { command: HOOK_COMMAND };

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
  const ours = stopHooks.filter(isOurHook);

  if (
    ours.length === 1 &&
    (ours[0] as { command: string }).command === HOOK_COMMAND
  ) {
    return { path: CURSOR_HOOKS_PATH, action: "unchanged" };
  }

  // Migrate any legacy `agentwiki update` entries to the npx form.
  hooks.stop = [...stopHooks.filter((hook) => !isOurHook(hook)), ourHook];
  existing.hooks = hooks;
  existing.version = existing.version ?? 1;

  await fs.writeFile(hooksPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return { path: CURSOR_HOOKS_PATH, action: "updated" };
}

/**
 * Insert or refresh the AgentWiki section in BOTH AGENTS.md and CLAUDE.md.
 * Both files are always ensured after init/update (Cursor reads AGENTS.md,
 * Claude Code reads CLAUDE.md). Existing files are never overwritten — only
 * the `## AgentWiki` section is inserted or refreshed in place, and all
 * surrounding content is preserved.
 */
export async function writeAgentPointers(
  root: string,
): Promise<IntegrationResult[]> {
  const results: IntegrationResult[] = [];
  const targets = ["AGENTS.md", "CLAUDE.md"];

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

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Refresh wiki fact blocks (deterministic, no keys needed)
        run: npx -y @julianoczkowski/agentwiki@latest update

      # ── Prose enrichment turns on AUTOMATICALLY when a repo secret exists ──
      # Add ONE of these under Settings -> Secrets and variables -> Actions:
      #   CURSOR_API_KEY            from cursor.com/dashboard -> API Keys
      #   CLAUDE_CODE_OAUTH_TOKEN   from running \`claude setup-token\` locally
      #                             (personal repos; teams should use API keys)
      # No editing of this file is needed — the steps below skip themselves
      # when the secret is absent.
      - name: Write prose with Cursor (auto-skips without CURSOR_API_KEY)
        env:
          CURSOR_API_KEY: \${{ secrets.CURSOR_API_KEY }}
        run: |
          if [ -z "$CURSOR_API_KEY" ]; then
            echo "No CURSOR_API_KEY secret - skipping prose enrichment via Cursor."
            exit 0
          fi
          curl https://cursor.com/install -fsS | bash
          export PATH="$HOME/.cursor/bin:$PATH"
          npx -y @julianoczkowski/agentwiki@latest enrich --backend cursor

      - name: Write prose with Claude Code (auto-skips without CLAUDE_CODE_OAUTH_TOKEN)
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CURSOR_API_KEY: \${{ secrets.CURSOR_API_KEY }}
        run: |
          if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
            echo "No CLAUDE_CODE_OAUTH_TOKEN secret - skipping prose enrichment via Claude Code."
            exit 0
          fi
          if [ -n "$CURSOR_API_KEY" ]; then
            echo "Cursor already handled enrichment - skipping."
            exit 0
          fi
          npm install -g @anthropic-ai/claude-code
          npx -y @julianoczkowski/agentwiki@latest enrich --backend claude

      - name: Commit wiki changes
        run: |
          if [[ -n "$(git status --porcelain agentwiki/)" ]]; then
            git config user.name "agentwiki-bot"
            git config user.email "agentwiki-bot@users.noreply.github.com"
            git add agentwiki/
            git commit -m "docs: refresh agentwiki wiki"
            git push
          fi
`;

export async function writeWorkflow(root: string): Promise<IntegrationResult> {
  return writeIfChanged(path.join(root, WORKFLOW_PATH), WORKFLOW_CONTENT);
}

/** Rule file gets this suffix while paused so Cursor stops loading it. */
const PAUSED_SUFFIX = ".paused";

export interface RemovalResult {
  path: string;
  action: "removed" | "detached" | "absent";
}

export async function pauseCursorRule(root: string): Promise<RemovalResult> {
  const rulePath = path.join(root, CURSOR_RULE_PATH);
  try {
    await fs.rename(rulePath, `${rulePath}${PAUSED_SUFFIX}`);
    return { path: CURSOR_RULE_PATH, action: "detached" };
  } catch {
    return { path: CURSOR_RULE_PATH, action: "absent" };
  }
}

export async function resumeCursorRule(root: string): Promise<RemovalResult> {
  const rulePath = path.join(root, CURSOR_RULE_PATH);
  try {
    await fs.rename(`${rulePath}${PAUSED_SUFFIX}`, rulePath);
    return { path: CURSOR_RULE_PATH, action: "detached" };
  } catch {
    // No paused copy — recreate the rule from the template.
    await writeCursorRule(root);
    return { path: CURSOR_RULE_PATH, action: "detached" };
  }
}

export async function removePausedRuleArtifact(root: string): Promise<void> {
  await fs.rm(path.join(root, `${CURSOR_RULE_PATH}${PAUSED_SUFFIX}`), {
    force: true,
  });
}

export async function removeCursorRule(root: string): Promise<RemovalResult> {
  const rulePath = path.join(root, CURSOR_RULE_PATH);
  await removePausedRuleArtifact(root);
  try {
    await fs.rm(rulePath);
    return { path: CURSOR_RULE_PATH, action: "removed" };
  } catch {
    return { path: CURSOR_RULE_PATH, action: "absent" };
  }
}

/** Remove our entry from hooks.json, preserving any other hooks. */
export async function removeCursorHook(root: string): Promise<RemovalResult> {
  const hooksPath = path.join(root, CURSOR_HOOKS_PATH);

  let existing: { version?: number; hooks?: Record<string, unknown[]> };
  try {
    existing = JSON.parse(await fs.readFile(hooksPath, "utf8"));
  } catch {
    return { path: CURSOR_HOOKS_PATH, action: "absent" };
  }

  const hooks = existing.hooks ?? {};
  const isOurs = (hook: unknown): boolean =>
    typeof hook === "object" &&
    hook !== null &&
    ((hook as { command?: string }).command?.startsWith("agentwiki") ?? false);

  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    const kept = entries.filter((entry) => !isOurs(entry));
    if (kept.length !== entries.length) {
      changed = true;
      if (kept.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = kept;
      }
    }
  }

  if (!changed) {
    return { path: CURSOR_HOOKS_PATH, action: "absent" };
  }

  if (Object.keys(hooks).length === 0) {
    await fs.rm(hooksPath, { force: true });
    return { path: CURSOR_HOOKS_PATH, action: "removed" };
  }

  existing.hooks = hooks;
  await fs.writeFile(hooksPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return { path: CURSOR_HOOKS_PATH, action: "detached" };
}

/** Strip the AgentWiki section from AGENTS.md / CLAUDE.md; delete files that end up empty. */
export async function removeAgentPointers(
  root: string,
): Promise<RemovalResult[]> {
  const results: RemovalResult[] = [];

  for (const target of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(root, target);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      results.push({ path: target, action: "absent" });
      continue;
    }

    const headingIndex = content.indexOf(AGENTS_SECTION_HEADING);
    if (headingIndex === -1) {
      results.push({ path: target, action: "absent" });
      continue;
    }

    const afterHeading = content.slice(
      headingIndex + AGENTS_SECTION_HEADING.length,
    );
    const nextHeading = afterHeading.search(/^## /m);
    const end =
      nextHeading === -1
        ? content.length
        : headingIndex + AGENTS_SECTION_HEADING.length + nextHeading;

    const stripped = `${content.slice(0, headingIndex).replace(/\n+$/, "\n")}${content.slice(end)}`;

    if (stripped.trim().length === 0) {
      await fs.rm(filePath);
      results.push({ path: target, action: "removed" });
    } else {
      await fs.writeFile(filePath, stripped, "utf8");
      results.push({ path: target, action: "detached" });
    }
  }

  return results;
}

export async function removeWorkflow(root: string): Promise<RemovalResult> {
  const workflowPath = path.join(root, WORKFLOW_PATH);
  try {
    await fs.access(workflowPath);
  } catch {
    return { path: WORKFLOW_PATH, action: "absent" };
  }

  await fs.rm(workflowPath);
  return { path: WORKFLOW_PATH, action: "removed" };
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
