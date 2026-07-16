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
const SWEEP_DEPTH = 4; // reaches nested-workspace apps like clients/apps/<name>
const MAX_NESTED_WORKSPACES = 8;

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

/** Test-runner projects (foo-e2e, foo-integration-tests) are not documentation targets. */
const TEST_APP_SUFFIX = /(^|[-_.])(e2e|integration-tests?)$/;

/** Dirs where NX versions have kept their project-graph cache. */
const NX_GRAPH_CACHE_DIRS = [
  ".nx/workspace-data",
  ".nx/cache",
  "node_modules/.cache/nx",
];

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
 * pnpm-workspace.yaml, and nx.json, plus a filesystem sweep for nested
 * manifests (covers Go/Rust/Python monorepos with no JS workspace config).
 * A subdirectory that is itself a workspace root — e.g. repo-root/clients
 * holding the actual NX workspace — is descended into with its own config,
 * never listed as an app. Fewer than two hits means "not a monorepo" —
 * callers should skip the scope question. Apps sort before shared packages
 * so the picker shows applications first and the cap never drops an app.
 */
export async function detectWorkspaceApps(root: string): Promise<WorkspaceApp[]> {
  const dirs = new Set<string>();
  const nestedRoots: string[] = [];

  await sweepForManifestDirs(root, "", 1, dirs, nestedRoots);

  // Apply workspace configs of the repo root and every nested workspace
  // root, prefixing their members with the nested root's path. NX's own
  // project-graph cache is authoritative where present — it knows projects
  // that plugins infer from build configs with no manifest on disk at all
  // (e.g. a legacy webpack app that only NX can see).
  const workspaceRoots = ["", ...nestedRoots.slice(0, MAX_NESTED_WORKSPACES)];
  const layouts: { prefix: string; nx: NxLayout }[] = [];
  const graphKinds = new Map<string, "app" | "package">();
  const graphNames = new Map<string, string>();

  for (const prefix of workspaceRoots) {
    const base = prefix ? path.join(root, prefix) : root;
    const nx = await readNxLayout(base);
    if (nx.appsDir || nx.libsDir) {
      layouts.push({ prefix, nx });
    }

    const patterns = await readWorkspacePatterns(base);
    if (nx.appsDir) {
      patterns.push(`${nx.appsDir}/*`);
    }
    if (nx.libsDir) {
      patterns.push(`${nx.libsDir}/*`);
    }

    for (const pattern of patterns) {
      for (const dir of await expandPattern(base, pattern)) {
        dirs.add(prefix ? `${prefix}/${dir}` : dir);
      }
    }

    for (const [projectDir, project] of await readNxGraphProjects(base)) {
      const full = prefix ? `${prefix}/${projectDir}` : projectDir;
      // The cache can be stale — only offer dirs that still exist.
      if (await isUsableDir(root, full)) {
        dirs.add(full);
        graphKinds.set(full, project.kind);
        graphNames.set(full, project.name);
      }
    }
  }

  // A workspace root is a container, not an app someone documents.
  for (const prefix of nestedRoots) {
    dirs.delete(prefix);
  }

  // The sweep may have wandered inside a graph-known project (vendored
  // subfolders with their own package.json) — the project boundary wins.
  for (const dir of [...dirs]) {
    for (const boundary of graphKinds.keys()) {
      if (dir !== boundary && dir.startsWith(`${boundary}/`)) {
        dirs.delete(dir);
        break;
      }
    }
  }

  const members = await Promise.all(
    [...dirs].sort().map(
      async (dir): Promise<WorkspaceApp> => ({
        dir,
        name: (await readAppName(root, dir)) ?? graphNames.get(dir) ?? null,
        kind: await classify(root, dir, layouts, graphKinds),
      }),
    ),
  );

  const sorted = members.sort((a, b) => a.dir.localeCompare(b.dir));
  return [
    ...sorted.filter((member) => member.kind === "app").slice(0, MAX_APPS),
    ...sorted.filter((member) => member.kind === "package").slice(0, MAX_APPS),
  ];
}

/**
 * Projects from NX's project-graph cache: dir (relative to the workspace
 * root) → { kind, name }. NX "app" nodes are apps; "e2e" and "lib" nodes
 * are shared/support projects.
 */
async function readNxGraphProjects(
  base: string,
): Promise<Map<string, { kind: "app" | "package"; name: string }>> {
  // Filenames vary across NX versions (project-graph.json, hash-prefixed
  // variants) — scan the known cache dirs for anything that looks right.
  const candidates: string[] = [];
  for (const dir of NX_GRAPH_CACHE_DIRS) {
    try {
      for (const entry of await fs.readdir(path.join(base, dir))) {
        if (entry.includes("project-graph") && entry.endsWith(".json")) {
          candidates.push(path.join(base, dir, entry));
        }
      }
    } catch {
      // Cache dir absent.
    }
  }

  for (const cache of candidates) {
    let nodes: Record<string, { type?: unknown; data?: { root?: unknown } }>;
    try {
      const parsed = JSON.parse(await fs.readFile(cache, "utf8")) as {
        graph?: { nodes?: typeof nodes };
        nodes?: typeof nodes;
      };
      const found = parsed.graph?.nodes ?? parsed.nodes;
      if (!found) {
        continue;
      }
      nodes = found;
    } catch {
      continue;
    }

    const projects = new Map<string, { kind: "app" | "package"; name: string }>();
    for (const [name, node] of Object.entries(nodes)) {
      const dir =
        typeof node.data?.root === "string"
          ? node.data.root.replace(/\\/g, "/").replace(/^\.\/|\/+$/g, "")
          : "";
      if (dir === "" || dir === ".") {
        continue;
      }
      projects.set(dir, {
        kind: node.type === "app" ? "app" : "package",
        name,
      });
    }
    if (projects.size > 0) {
      return projects;
    }
  }
  return new Map();
}

/**
 * App vs shared package, strongest signal first: test-runner naming
 * (foo-e2e is never a documentation target), the NX project graph, the
 * member's own project.json, each workspace root's nx.json layout, then
 * path-name heuristics. Unknown shapes default to "app" — better to offer
 * than hide.
 */
async function classify(
  root: string,
  dir: string,
  layouts: { prefix: string; nx: NxLayout }[],
  graphKinds: Map<string, "app" | "package">,
): Promise<"app" | "package"> {
  const basename = dir.split("/").pop() ?? dir;
  if (TEST_APP_SUFFIX.test(basename)) {
    return "package";
  }

  const fromGraph = graphKinds.get(dir);
  if (fromGraph === "package") {
    return "package";
  }
  if (fromGraph === "app") {
    // Demo/example apps living inside libs/ or tools/ are support code,
    // not products — the container placement outranks the NX node type.
    return dir.split("/").some((segment) => PACKAGE_SEGMENTS.has(segment))
      ? "package"
      : "app";
  }

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

  for (const { prefix, nx } of layouts) {
    const appsDir = nx.appsDir && (prefix ? `${prefix}/${nx.appsDir}` : nx.appsDir);
    const libsDir = nx.libsDir && (prefix ? `${prefix}/${nx.libsDir}` : nx.libsDir);
    if (appsDir && dir.startsWith(`${appsDir}/`)) {
      return "app";
    }
    if (libsDir && dir.startsWith(`${libsDir}/`)) {
      return "package";
    }
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
 * Manifest sweep: walk up to SWEEP_DEPTH levels. A dir that is itself a
 * workspace root (nested monorepo, e.g. clients/ holding the NX workspace)
 * is recorded as such and descended into; a dir carrying a plain manifest
 * is recorded as a member and not descended into (apps don't nest apps).
 */
async function sweepForManifestDirs(
  root: string,
  relative: string,
  depth: number,
  dirs: Set<string>,
  nestedRoots: string[],
): Promise<void> {
  for (const child of await listSubdirs(path.join(root, relative))) {
    const dir = relative ? `${relative}/${child}` : child;
    const absolute = path.join(root, dir);
    // A workspace-config dir inside an apps/ container is a legacy app
    // dragging its old monorepo files along (lerna.json, a stale
    // workspaces field) — a member, not a workspace to recurse into.
    const insideAppsContainer = dir
      .split("/")
      .slice(0, -1)
      .some((segment) => APP_SEGMENTS.has(segment));
    if (!insideAppsContainer && (await isWorkspaceRootDir(absolute))) {
      nestedRoots.push(dir);
      if (depth < SWEEP_DEPTH) {
        await sweepForManifestDirs(root, dir, depth + 1, dirs, nestedRoots);
      }
    } else if (await hasManifest(absolute)) {
      dirs.add(dir);
    } else if (depth < SWEEP_DEPTH) {
      await sweepForManifestDirs(root, dir, depth + 1, dirs, nestedRoots);
    }
  }
}

/** A dir that hosts a whole workspace: nx/pnpm/lerna/turbo config, or npm workspaces. */
async function isWorkspaceRootDir(absolute: string): Promise<boolean> {
  for (const marker of ["nx.json", "pnpm-workspace.yaml", "lerna.json", "turbo.json"]) {
    try {
      await fs.access(path.join(absolute, marker));
      return true;
    } catch {
      // Try the next marker.
    }
  }

  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(absolute, "package.json"), "utf8"),
    ) as { workspaces?: unknown };
    return parsed.workspaces !== undefined;
  } catch {
    return false;
  }
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
