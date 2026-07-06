# agentwiki

A CLI that generates and maintains a wiki for your codebase — **without calling any LLM itself**.

agentwiki is a deterministic facts engine: it scans your repository (files, symbols, imports, manifests, git history) and generates wiki pages whose **fact blocks** are machine-owned, regenerated on every run, and can never hallucinate. The narrative **prose sections** are written by the coding agent you already pay for — Cursor CLI or Claude Code, on your existing subscription. No new API keys, no local models.

```
  ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀ █░█░█ █ █▄▀ █
  █▀█ █▄█ ██▄ █░▀█ ░█░ ▀▄▀▄▀ █ █░█ █
```

## How it works

Every generated page interleaves two kinds of regions:

```markdown
<!-- agentwiki:facts id="dependencies" hash="1992f504c371" -->
- **Imports from:** `src (root)` (4)
- **Imported by:** `src (root)` (3), `test` (1)
<!-- /agentwiki:facts -->

<!-- agentwiki:prose slot="purpose" status="fresh" facts-hash="1992f504c371" hint="..." -->
This module owns the DeepAgents session lifecycle…   ← written by YOUR agent
<!-- /agentwiki:prose -->
```

- `agentwiki init`/`update` regenerate fact blocks deterministically and **never touch prose**.
- A prose slot is **fresh** when its recorded `facts-hash` matches the hash of the page's current facts. When the code changes underneath it, it becomes **stale** — flagged, not overwritten.
- `agentwiki queue` lists every empty/stale slot; `agentwiki enrich` hands that queue to Cursor CLI (`cursor-agent -p`) or Claude Code (`claude -p`) running headlessly on your machine, on your existing login.

## Install & first run

```sh
npm install            # (or: npm install -g agentwiki once published)
npm run build
cd /path/to/your/repo
agentwiki init         # generates agentwiki/, wires integrations, checks backends
agentwiki doctor       # environment check: git, backends, auth state
```

`init` produces:

| Output | Purpose |
| --- | --- |
| `agentwiki/quickstart.md` | Identity facts, run scripts, module map |
| `agentwiki/architecture.md` | Layout, entrypoints, Mermaid module-dependency graph |
| `agentwiki/activity.md` | Hot files, recent commits, contributors (90-day window) |
| `agentwiki/modules/*.md` | Per-module pages: files, exports, imports/imported-by, activity |
| `.cursor/rules/agentwiki.mdc` | Always-on rule: Cursor's agent reads the wiki first and maintains prose slots as a side effect of normal work |
| `.cursor/hooks.json` | `stop` hook: refresh fact blocks after each Cursor agent session |
| `AGENTS.md` / `CLAUDE.md` | AgentWiki pointer section (inserted or refreshed, surrounding content preserved) |

## Commands

```
agentwiki init                 Generate the wiki and wire agent integrations
agentwiki update               Refresh fact blocks; flags prose whose facts changed
agentwiki status               Freshness overview per page/slot + backend readiness
agentwiki queue [--json]       List prose slots that need writing
agentwiki enrich               Have your coding agent write the queued slots
        --backend cursor|claude    override the saved preference
        --dry-run                  print the prompt, run nothing
agentwiki backend [cursor|claude]  Show or save preferred backend
agentwiki doctor               Check node, git, backend install + auth state
```

## Backends

| | Local auth | CI auth | Notes |
| --- | --- | --- | --- |
| **Cursor CLI** | `cursor-agent login` (checked via `cursor-agent status`) | `CURSOR_API_KEY` repo secret (same subscription, dashboard token) | install: `curl https://cursor.com/install -fsS \| bash` |
| **Claude Code** | logged-in `claude` (verified at run time) | `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token` (personal) or `ANTHROPIC_API_KEY` (team pipelines) | install: `npm install -g @anthropic-ai/claude-code` |

agentwiki detects installed backends automatically, checks auth before every enrich run, and prints the exact install/login command when something is missing or a token has expired. Without any backend you still get a complete, always-accurate structural wiki — prose sections simply stay listed in the queue (your agent can also fill them organically from inside the editor via the emitted Cursor rule).

## Keeping it current

- **In Cursor:** the emitted rule + `stop` hook maintain the wiki as a side effect of normal agent use.
- **On commit:** add `agentwiki update` to a pre-commit hook (it's sub-second and deterministic).
- **On push:** `.github/workflows/agentwiki.yml` (see `src/emitters/integrations.ts`) refreshes fact blocks in CI with zero secrets, and optionally runs `agentwiki enrich` with your `CURSOR_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`.

## Design notes

- **No LLM in the loop for facts.** Symbols and imports come from line-anchored extraction (TS/JS, Python, Go, Rust), the module graph from resolved relative imports, history from git. Facts can be regenerated forever at zero cost.
- **No-op discipline.** A content snapshot (SHA-256 over the wiki tree, metadata excluded) guarantees that runs which change nothing leave `agentwiki/.agentwiki.json` untouched — safe for hooks and scheduled CI.
- **Prose safety.** The engine merges by slot name: agent/human prose survives every regeneration; only its freshness flag changes.
