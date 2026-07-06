# NPM Deployment Guide

This package deploys to npm with **Trusted Publishers (OIDC)** — the same token-free setup as [`@julianoczkowski/create-trimble-app`](https://www.npmjs.com/package/@julianoczkowski/create-trimble-app).

| Item | Value |
|------|-------|
| Package name | `@julianoczkowski/agentwiki` |
| npm URL | https://www.npmjs.com/package/@julianoczkowski/agentwiki |
| GitHub repo | https://github.com/julianoczkowski/agentwiki |
| Workflow file | `.github/workflows/publish.yml` |
| Authentication | OIDC Trusted Publishers (no tokens) |

## How it works

1. A GitHub Actions run generates a temporary OIDC token (`id-token: write`).
2. The npm CLI (≥ 11.5.1, Node ≥ 22.14 — the workflow upgrades npm and pins Node 22) exchanges it for short-lived, job-specific publish credentials.
3. No static npm tokens are stored anywhere; nothing to rotate or leak.

Reference: [npm docs — Trusted Publishers](https://docs.npmjs.com/trusted-publishers).

## One-time setup on npmjs.com

If the trusted-publisher form is not available for the unpublished name, do a
single manual first publish, then configure it:

```bash
npm login                     # as julianoczkowski
npm publish --access public   # first version only
```

Then configure the trusted publisher (mirrors create-trimble-app):

1. Go to https://www.npmjs.com/package/@julianoczkowski/agentwiki/access
2. "Trusted Publisher" → **GitHub Actions**
3. Fill in:
   - **Organization or user:** `julianoczkowski`
   - **Repository:** `agentwiki`
   - **Workflow filename:** `publish.yml` (filename only, not the path)
   - **Environment:** leave empty
   - **Allowed actions:** npm publish
4. Under "Publishing access", pick *Require two-factor authentication and disallow tokens* — trusted publishers keep working regardless (most restrictive, recommended by npm).

Every release after that is fully automated.

## Publishing a new version

```bash
npm version patch   # bug fixes    (0.1.0 -> 0.1.1)
npm version minor   # new features (0.1.0 -> 0.2.0)
npm version major   # breaking     (0.1.0 -> 1.0.0)

git push origin main --follow-tags
```

The tag push triggers `publish.yml`, which:

1. Typechecks and runs the test suite on Node 20 / 22 / 24
2. Builds and smoke-tests the CLI (`version`, `help`, real `init` + `queue`)
3. Runs `npm audit`
4. Publishes to npm via OIDC with provenance
5. Creates the GitHub release with install instructions

Manual re-run: Actions tab → "Publish to NPM" → *Run workflow*.
