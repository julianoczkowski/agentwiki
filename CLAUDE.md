# CLAUDE.md

Guidance for coding agents working in this repository.

## What this project is

`@julianoczkowski/agentwiki` is a CLI (bin name: `agentwiki`) that generates and maintains a documentation wiki inside a target repository. Its core rule: **this tool never calls an LLM itself — no API clients, no keys, no model dependencies.** It produces deterministic "fact blocks" from code/git analysis, and delegates narrative prose to an external coding agent the user already has (Cursor CLI via `cursor-agent -p`, or Claude Code via `claude -p`), invoked as a child process on the user's own subscription. Do not add LLM SDKs or API calls to this codebase.

## Architecture map

```
src/
├── cli.tsx              Entry point: arg routing; plain-stdout commands (queue,
│                        enrich, backend, pause/resume/remove/uninstall,
│                        setup-action) vs Ink views (init, update, status, doctor)
├── commands.ts          Argv parser + HELP_TEXT
├── constants.ts         WIKI_DIR ("agentwiki"), ignored dirs, language map
├── runner.ts            Orchestration: runGenerate (7 phases), runDoctor, gatherStatus
├── engine/
│   ├── scan.ts          File listing (git ls-files, fs fallback), manifests, entrypoints
│   ├── symbols.ts       Regex-based export/import extraction (TS/JS, Python, Go, Rust)
│   ├── graph.ts         Module dependency graph + Mermaid rendering
│   ├── git.ts           simple-git: head, hot files, contributors (90-day window)
│   ├── blocks.ts        THE CORE: fact-block/prose-slot parse, render, merge, staleness
│   ├── emit.ts          Page templates (quickstart, architecture, activity, modules/*)
│   ├── wiki.ts          Write pages, content snapshot, .agentwiki.json metadata
│   └── queue.ts         Stale/empty slot scan + the enrich prompt builder
├── backends/            cursor.ts / claude.ts adapters: detect(), auth check, enrich()
├── emitters/            .cursor rule + hooks, AGENTS.md/CLAUDE.md sections, GitHub
│                        workflow — each has a matching remove/pause function
└── ui/                  Ink components: hero box (brand #0063a3, block logo,
                         youtube.com/@aiforwork_app), Section/Item/Line/Hint thread style
```

## Invariants — do not break these

1. **Fact blocks are machine-owned; prose slots are agent/human-owned.** `mergePage` in `engine/blocks.ts` must never lose prose. Staleness is *derived* (slot's `facts-hash` vs current page facts hash), never trusted from the attribute.
2. **No-op discipline:** a run that changes no wiki content must leave `agentwiki/.agentwiki.json` byte-identical (see `snapshotWiki`). Hooks and CI depend on this.
3. **`update` must stay safe to run from hooks:** fast, no prompts, no-op when paused, and it never re-creates the GitHub workflow if the user deleted it (only `init`/`setup-action` do).
4. **Removal is surgical:** `remove`/`pause` only touch agentwiki-owned artifacts — foreign entries in `.cursor/hooks.json` and non-AgentWiki content in AGENTS.md/CLAUDE.md must survive.
5. **Destructive commands confirm:** `remove` and `uninstall` prompt y/N, accept `--yes`, and refuse in non-TTY without it.
6. **Zero runtime deps beyond** `ink`, `react`, `simple-git`. Symbol extraction is deliberately regex-based to stay dependency-free.

## How to run and test

```sh
npm install
npm run dev -- doctor        # run any command from source (tsx)
npm run typecheck            # tsc --noEmit (strict, noUnusedLocals)
npm test                     # vitest — test/blocks.test.ts covers the merge core
npm run build                # tsc -> dist/ + chmod +x dist/cli.js (postbuild)
```

End-to-end testing: run the built CLI against a scratch clone of any real repo
(`node dist/cli.js init` etc.), never against this repo's own checkout. Verify at
minimum: repeated `update` is a no-op, prose survives regeneration, a code change
flips affected slots to stale, and `remove --yes` preserves foreign hooks.
Testing `enrich` for real invokes the user's Cursor/Claude subscription — prefer
`enrich --dry-run` unless the user asked for a live run.

## Conventions

- TypeScript ESM with NodeNext resolution — **imports need `.js` extensions**.
- Ink 5 / React 18; `jsx: react-jsx` (do not import React just for JSX; `noUnusedLocals` fails the build).
- UI style matches julianoczkowski/create-trimble-app: brand blue `#0063a3`, double-border hero, clack-style `┌ │ ◆ ◇ ▲ └` threads (`src/ui/components.tsx`). Machine-readable output (`queue --json`) bypasses Ink entirely.
- User-facing onboarding text is written for non-developers: numbered "type this in your terminal" steps (see `setupSteps`/`setupGuideText` in `src/backends/`).

## Publishing to npm

Automated via **npm Trusted Publishers (OIDC)** — no tokens, see `docs/npm-deployment.md`:

```sh
npm version patch|minor|major   # bumps + commits + tags
git push origin main --follow-tags
```

The `v*` tag triggers `.github/workflows/publish.yml`: typecheck + tests on Node 20/22/24 → build + CLI smoke tests → `npm publish --access public` via OIDC (`id-token: write`, npm ≥ 11.5.1, Node 22) → auto GitHub release. The workflow filename `publish.yml` is registered as the trusted publisher on npmjs.com for `julianoczkowski/agentwiki` — renaming the file breaks publishing. `prepublishOnly` (typecheck + test + build) guards manual publishes.

## Related

- Product docs: `README.md` (npx-first) · deployment: `docs/npm-deployment.md`
- Sibling project sharing the UI style & publish pipeline: [create-trimble-app](https://github.com/julianoczkowski/create-trimble-app)
- Author channel (shown in the CLI hero): https://www.youtube.com/@aiforwork_app
