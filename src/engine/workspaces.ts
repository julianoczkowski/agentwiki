import fs from "node:fs/promises";
import path from "node:path";
import { IGNORED_DIRS, WIKI_DIR } from "../constants.js";

export interface WorkspaceApp {
  /** Repo-relative posix path, e.g. "apps/web" or "clients/apps/web". */
  dir: string;
  /** Name declared in the app's own manifest, if any. */
  name: string | null;
  /** Runnable application vs shared package/library — drives picker grouping. */
  kind: "app" | "package";
}

const MANIFEST_FILES = [
  "package.json",
  "project.json", // NX integrated repos: apps may have no package.json at all
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
];
const MAX_APPS = 24;
const SWEEP_DEPTH = 3; // reaches NX-style clients/apps/<name>

/** Path segments that mark a workspace member as a shared package, not an app. */
const PACKAGE_SEGMENTS = new Set([
  "packages",
  "libs",
  "libraries",
  "tools",
  "shared",
  "common",
  "internal",
  "config",
  "configs",
]);

/** Path segments that mark a workspace member as an application. */
const APP_SEGMENTS = new Set(["apps", "applications", "services"]);

interface NxLayout {
  appsDir: string | null;
  libsDir: string | null;
}

/**
 * The workspace member whose directory contains `relPath` (a repo-relative
 * posix path, e.g. where the user invoked the CLI from). Longest match wins;
 * "" or no match → null. Used to pre-select "the app you're standing in".
 */
export function matchAppForPath(
  apps: WorkspaceApp[],
  relPath: string | null | undefined,
): WorkspaceApp | null {
  if (!relPath) {
    return null;
  }
  const normalized = relPath.replace(/\\/g, "/");

  let best: WorkspaceApp | null = null;
  for (const app of apps) {
    if (normalized === app.dir || normalized.startsWith(`${app.dir}/`)) {
      if (!best || app.dir.length > best.dir.length) {
        best = app;
      }
    }
  }
  return best;
}

/**
 * Find the apps/packages of a monorepo: workspace globs from package.json,
 * pnpm-workspace.yaml, and nx.json, plus a shallow filesystem sweep for
 * nested manifests (covers Go/Rust/Python monorepos with no JS workspace
 * config). Fewer than two hits means "not a monorepo" — callers should skip
 * the scope question. Apps sort before shared packages so the picker can
 * show applications first and the cap never drops an app for a library.
 */
export async function detectWorkspaceApps(root: string): Promise<WorkspaceApp[]> {
  const nx = await readNxLayout(root);
  const dirs = new Set<string>();

  const patterns = await readWorkspacePatterns(root);
  if (nx.appsDir) {
    patterns.push(`${nx.appsDir}/*`);
  }
  if (nx.libsDir) {
    patterns.push(`${nx.libsDir}/*`);
  }

  for (const pattern of patterns) {
    for (const dir of await expandPattern(root, pattern)) {
      dirs.add(dir);
    }
  }

  for (const dir of await sweepForManifestDirs(root)) {
    dirs.add(dir);
  }

  const apps = await Promise.all(
    [...dirs].sort().map(
      async (dir): Promise<WorkspaceApp> => ({
        dir,
        name: await readAppName(root, dir),
        kind: await classify(root, dir, nx),
      }),
    ),
  );

  return apps
    .sort((a, b) =>
      a.kind === b.kind ? a.dir.localeCompare(b.dir) : a.kind === "app" ? -1 : 1,
    )
    .slice(0, MAX_APPS);
}

/**
 * App vs shared package, strongest signal first: the member's own NX
 * project.json, the nx.json workspace layout, then path-name heuristics.
 * Unknown shapes default to "app" — better to offer it than hide it.
 */
async function classify(
  root: string,
  dir: string,
  nx: NxLayout,
): Promise<"app" | "package"> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, dir, "project.json"), "utf8"),
    ) as { projectType?: unknown };
    if (parsed.projectType === "application") {
      return "app";
    }
    if (parsed.projectType === "library") {
      return "package";
    }
  } catch {
    // No project.json — fall through to layout/path signals.
  }

  if (nx.appsDir && dir.startsWith(`${nx.appsDir}/`)) {
    return "app";
  }
  if (nx.libsDir && dir.startsWith(`${nx.libsDir}/`)) {
    return "package";
  }

  const segments = dir.split("/");
  if (segments.some((segment) => APP_SEGMENTS.has(segment))) {
    return "app";
  }
  if (segments.some((segment) => PACKAGE_SEGMENTS.has(segment))) {
    return "package";
  }

  return "app";
}

async function readNxLayout(root: string): Promise<NxLayout> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, "nx.json"), "utf8"),
    ) as { workspaceLayout?: { appsDir?: unknown; libsDir?: unknown } };
    return {
      appsDir:
        typeof parsed.workspaceLayout?.appsDir === "string"
          ? parsed.workspaceLayout.appsDir.replace(/\/+$/, "")
          : null,
      libsDir:
        typeof parsed.workspaceLayout?.libsDir === "string"
          ? parsed.workspaceLayout.libsDir.replace(/\/+$/, "")
          : null,
    };
  } catch {
    return { appsDir: null, libsDir: null };
  }
}

async function readWorkspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];

  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as { workspaces?: string[] | { packages?: string[] } };
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
      : parsed.workspaces?.packages;
    for (const pattern of workspaces ?? []) {
      if (typeof pattern === "string") {
        patterns.push(pattern);
      }
    }
  } catch {
    // No package.json or unparseable — the sweep still runs.
  }

  try {
    const yaml = await fs.readFile(
      path.join(root, "pnpm-workspace.yaml"),
      "utf8",
    );
    for (const match of yaml.matchAll(/^\s*-\s*["']?([^"'#\s]+)["']?\s*$/gm)) {
      patterns.push(match[1]);
    }
  } catch {
    // No pnpm workspace file.
  }

  return patterns;
}

/** Expand "apps/*"-style globs one level deep; "**" is treated as "*". */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const cleaned = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (cleaned.startsWith("!") || cleaned.startsWith("/") || cleaned.includes("..")) {
    return [];
  }

  const starIndex = cleaned.indexOf("*");
  if (starIndex === -1) {
    return (await isUsableDir(root, cleaned)) ? [cleaned] : [];
  }

  const base = cleaned.slice(0, starIndex).replace(/\/+$/, "");
  if (base.includes("*")) {
    return [];
  }

  const expanded: string[] = [];
  for (const child of await listSubdirs(path.join(root, base))) {
    const dir = base ? `${base}/${child}` : child;
    if (await isUsableDir(root, dir)) {
      expanded.push(dir);
    }
  }
  return expanded;
}

/**
 * Manifest sweep: walk up to SWEEP_DEPTH levels; a dir that carries its own
 * manifest is recorded and not descended into (apps don't nest apps).
 */
async function sweepForManifestDirs(root: string): Promise<string[]> {
  const found: string[] = [];

  async function visit(relative: string, depth: number): Promise<void> {
    for (const child of await listSubdirs(path.join(root, relative))) {
      const dir = relative ? `${relative}/${child}` : child;
      if (await hasManifest(path.join(root, dir))) {
        found.push(dir);
      } else if (depth < SWEEP_DEPTH) {
        await visit(dir, depth + 1);
      }
    }
  }

  await visit("", 1);
  return found;
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !IGNORED_DIRS.has(entry.name) &&
          entry.name !== WIKI_DIR,
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function isUsableDir(root: string, dir: string): Promise<boolean> {
  const segments = dir.split("/");
  if (
    segments.some(
      (segment) =>
        segment.startsWith(".") ||
        IGNORED_DIRS.has(segment) ||
        segment === WIKI_DIR,
    )
  ) {
    return false;
  }

  try {
    return (await fs.stat(path.join(root, dir))).isDirectory();
  } catch {
    return false;
  }
}

async function hasManifest(dir: string): Promise<boolean> {
  for (const manifest of MANIFEST_FILES) {
    try {
      await fs.access(path.join(dir, manifest));
      return true;
    } catch {
      // Try the next manifest kind.
    }
  }
  return false;
}

async function readAppName(root: string, dir: string): Promise<string | null> {
  for (const file of ["package.json", "project.json"]) {
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(root, dir, file), "utf8"),
      ) as { name?: unknown };
      if (typeof parsed.name === "string") {
        return parsed.name;
      }
    } catch {
      // Fall through to the other manifest kinds.
    }
  }

  for (const file of ["pyproject.toml", "Cargo.toml"]) {
    try {
      const content = await fs.readFile(path.join(root, dir, file), "utf8");
      const name = content.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
      if (name) {
        return name;
      }
    } catch {
      // Keep trying.
    }
  }

  try {
    const content = await fs.readFile(path.join(root, dir, "go.mod"), "utf8");
    const module = content.match(/^module\s+(\S+)/m)?.[1];
    if (module) {
      return module;
    }
  } catch {
    // No manifest with a name — the dir path is label enough.
  }

  return null;
}
