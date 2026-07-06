# AgentWiki

**A self-maintaining wiki for your codebase — without your wiki tool ever calling an LLM.**

```sh
npx @julianoczkowski/agentwiki init
```

That's it. No API keys, no configuration, no new subscription.

```
  ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀ █░█░█ █ █▄▀ █
  █▀█ █▄█ ██▄ █░▀█ ░█░ ▀▄▀▄▀ █ █░█ █
```

## What is it?

AgentWiki generates and maintains a documentation wiki (`agentwiki/` in your repo) out of two kinds of content:

- **Fact blocks** — machine-owned. Generated deterministically from your code: files, exported symbols, import graphs (with a Mermaid diagram), manifests, and git history. Regenerated on every run, they can never hallucinate and never go stale silently.
- **Prose sections** — narrative explanations ("what is this module for", "what are we working on"). AgentWiki doesn't write these itself and never calls an LLM. Instead it hands them to **the coding agent you already pay for** — Cursor CLI or Claude Code, running on your existing subscription.

When your code changes, fact blocks update automatically and any prose whose facts changed is flagged **stale** — never overwritten. Your agent (or CI) rewrites just those sections.

## Quick start

One command — nothing to install:

```sh
cd your-project
npx @julianoczkowski/agentwiki init
```

`init` asks two questions (which agent writes your prose, and whether to write it right now) and produces a **complete** wiki. From then on the GitHub Action and the Cursor rule maintain it — most users never need a second command.

For manual control: `enrich` rewrites pending prose, `status` shows freshness.

`init` creates:

| Output | Purpose |
| --- | --- |
| `agentwiki/quickstart.md` | Identity facts, run scripts, module map |
| `agentwiki/architecture.md` | Layout, entrypoints, Mermaid module-dependency graph |
| `agentwiki/activity.md` | Hot files, recent commits, contributors (90-day window) |
| `agentwiki/modules/*.md` | Per-module pages: files, exports, imports/imported-by, activity |
| `.cursor/rules/agentwiki.mdc` | Always-on rule: Cursor's agent reads the wiki first and maintains prose as a side effect of normal work |
| `.cursor/hooks.json` | `stop` hook: refresh facts after each Cursor agent session |
| `AGENTS.md` / `CLAUDE.md` | Pointer section for any coding agent (surrounding content preserved) |
| `.github/workflows/agentwiki.yml` | CI: keyless fact refresh on push, optional prose enrichment |

Prefer a permanent command? `npm install -g @julianoczkowski/agentwiki` gives you a global `agentwiki`.

## Commands

```
agentwiki init                 Generate the wiki and wire agent integrations
agentwiki update               Refresh fact blocks; flag prose whose facts changed
agentwiki status               Freshness overview per page/slot + backend readiness
agentwiki queue [--json]       List prose slots that need writing
agentwiki enrich               Have your coding agent write the queued slots
        --backend cursor|claude    override the saved preference
        --dry-run                  print the prompt, run nothing
agentwiki backend              Pick your prose writer interactively (also the
                               first step of init); or pass cursor|claude directly
agentwiki pause / resume       Pause automation (docs kept) and re-enable
agentwiki remove [--docs] [-y] Remove integrations with confirmation; docs KEPT
                               unless --docs is passed
agentwiki setup-action         (Re)write the GitHub Actions workflow
agentwiki uninstall            Remove the CLI from this computer (projects untouched)
agentwiki doctor               Check node, git, backend install + auth state
```

## The agents that write the prose

AgentWiki detects what you have, checks its login state before every run, and shows exact terminal steps when something is missing or a token expired:

| | Local auth | CI auth |
| --- | --- | --- |
| **Cursor CLI** | `cursor-agent login` (browser sign-in, no API key) | `CURSOR_API_KEY` repo secret — same subscription, dashboard token |
| **Claude Code** | logged-in `claude` | `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token` (personal), or `ANTHROPIC_API_KEY` (team pipelines) |

Without any backend you still get a complete, always-accurate structural wiki — prose sections simply wait in the queue, and Cursor fills them organically from inside the editor via the emitted rule.

## How pages stay honest

```markdown
<!-- agentwiki:facts id="dependencies" hash="1992f504c371" -->
- **Imports from:** `src (root)` (4)      ← regenerated every run, never edited
<!-- /agentwiki:facts -->

<!-- agentwiki:prose slot="purpose" status="fresh" facts-hash="1992f504c371" -->
This module owns the agent session lifecycle…   ← written by YOUR agent
<!-- /agentwiki:prose -->
```

A prose slot is **fresh** while its recorded `facts-hash` matches the page's current facts; a code change flips it to **stale** (flagged, preserved). A content snapshot guarantees no-op runs leave metadata untouched — safe for hooks and scheduled CI. Markers are invisible when the markdown renders, so the wiki reads clean everywhere.

## Full automation

Everything except the very first `init` can run hands-free:

- **Facts**: refreshed automatically on every push (GitHub Action, zero secrets) and after every Cursor agent session (`stop` hook, runs via npx — no global install needed).
- **Prose**: add ONE repo secret and CI enrichment turns itself on — no YAML editing: `CURSOR_API_KEY` (cursor.com dashboard) or `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, personal repos). The Action then writes stale/new prose on every push and commits it.
- **Ambient**: the emitted Cursor rule has Cursor's agent fill prose slots related to files it touched during normal work.

## Leaving is easy

`pause` detaches the automation reversibly. `remove` strips every integration surgically (foreign hooks and your other AGENTS.md content survive) and **keeps your docs** unless you pass `--docs`. `uninstall` removes the command itself, in plain language a non-developer can follow. Nothing global is ever stored on your machine.

## Development

```sh
git clone https://github.com/julianoczkowski/agentwiki
cd agentwiki
npm install
npm run dev -- doctor     # run from source (tsx)
npm test                  # vitest unit suite
npm run build             # tsc -> dist/, then npm link for a global command
```

Releases are automated via [npm Trusted Publishers (OIDC)](docs/npm-deployment.md): `npm version patch && git push --follow-tags` — no tokens anywhere.

---
## Author

<img width="236" height="236" alt="avatar2" src="https://github.com/user-attachments/assets/5677ddb5-6b0b-4054-a70b-a143761dd307" />

Built by **Julian Oczkowski** — I build AI tools for knowledge work.

- 🎥 **[YouTube · @aiforwork_app](https://www.youtube.com/@aiforwork_app)** — walkthroughs and AI-for-work tutorials
- ✍️ **[Medium](https://medium.com/@julian.oczkowski)** — deep dives on product and AI workflows
- 💼 **[LinkedIn](https://www.linkedin.com/in/julianoczkowski/)** — connect and follow along

MIT © Julian Oczkowski · 📺 [youtube.com/@aiforwork_app](https://www.youtube.com/@aiforwork_app)
