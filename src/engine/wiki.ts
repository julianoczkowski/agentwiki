import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { META_FILE, VERSION, WIKI_DIR } from "../constants.js";
import { mergePage, type SlotStatus } from "./blocks.js";
import type { PageTemplate } from "./emit.js";

export interface WikiMeta {
  version: string;
  updatedAt: string;
  command: "init" | "update";
  gitHead: string | null;
  pages: number;
  backend?: "cursor" | "claude";
  paused?: boolean;
  /**
   * Monorepo scope: repo-relative dir the wiki documents. "" means the user
   * explicitly chose the whole repository; absent means never asked — an
   * interactive init in a monorepo re-asks until an answer is recorded.
   */
  scope?: string;
}

export interface PageResult {
  relPath: string;
  action: "created" | "updated" | "unchanged" | "removed";
  slots: { slot: string; status: SlotStatus }[];
}

export interface WriteResult {
  pages: PageResult[];
  slotCounts: Record<SlotStatus, number>;
  contentChanged: boolean;
  metaWritten: boolean;
}

export function wikiDir(root: string): string {
  return path.join(root, WIKI_DIR);
}

export async function wikiExists(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(wikiDir(root), "quickstart.md"));
    return true;
  } catch {
    return false;
  }
}

export async function readMeta(root: string): Promise<WikiMeta | null> {
  try {
    const content = await fs.readFile(
      path.join(wikiDir(root), META_FILE),
      "utf8",
    );
    return JSON.parse(content) as WikiMeta;
  } catch {
    return null;
  }
}

export async function patchMeta(
  root: string,
  patch: Partial<Pick<WikiMeta, "backend" | "paused" | "scope">>,
): Promise<void> {
  const meta = (await readMeta(root)) ?? {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    command: "init" as const,
    gitHead: null,
    pages: 0,
  };

  Object.assign(meta, patch);
  if (patch.paused === false) {
    delete meta.paused;
  }

  await fs.mkdir(wikiDir(root), { recursive: true });
  await fs.writeFile(
    path.join(wikiDir(root), META_FILE),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Normalize a user-supplied scope value to a repo-relative posix path.
 * "" means whole repository; null means rejected (absolute or escaping).
 */
export function normalizeScope(input: string): string | null {
  const cleaned = input
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (cleaned === "" || cleaned === ".") {
    return "";
  }
  if (
    path.isAbsolute(cleaned) ||
    cleaned.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return cleaned;
}

export async function saveBackendPreference(
  root: string,
  backend: "cursor" | "claude",
): Promise<void> {
  await patchMeta(root, { backend });
}

/**
 * Content snapshot of the wiki (excluding metadata). Used the same way
 * openwiki uses it: a no-op run must not churn the metadata file.
 */
export async function snapshotWiki(root: string): Promise<string> {
  const dir = wikiDir(root);
  const hash = createHash("sha256");

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name !== META_FILE) {
        hash.update(path.relative(dir, fullPath));
        hash.update(await fs.readFile(fullPath));
      }
    }
  }

  await visit(dir);
  return hash.digest("hex");
}

export async function writeWiki(
  root: string,
  templates: PageTemplate[],
  command: "init" | "update",
  gitHead: string | null,
): Promise<WriteResult> {
  const dir = wikiDir(root);
  const before = await snapshotWiki(root);
  const pages: PageResult[] = [];
  const slotCounts: Record<SlotStatus, number> = {
    empty: 0,
    stale: 0,
    fresh: 0,
  };

  for (const template of templates) {
    const filePath = path.join(dir, template.relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let existing: string | null = null;
    try {
      existing = await fs.readFile(filePath, "utf8");
    } catch {
      existing = null;
    }

    const merged = mergePage(existing, template.segments);

    for (const slot of merged.slots) {
      slotCounts[slot.status] += 1;
    }

    if (existing === null) {
      await fs.writeFile(filePath, merged.content, "utf8");
      pages.push({ relPath: template.relPath, action: "created", slots: merged.slots });
    } else if (merged.changed) {
      await fs.writeFile(filePath, merged.content, "utf8");
      pages.push({ relPath: template.relPath, action: "updated", slots: merged.slots });
    } else {
      pages.push({ relPath: template.relPath, action: "unchanged", slots: merged.slots });
    }
  }

  // Remove module pages whose module disappeared from the codebase.
  const expected = new Set(templates.map((template) => template.relPath));
  const modulesDir = path.join(dir, "modules");
  try {
    for (const entry of await fs.readdir(modulesDir)) {
      const relPath = `modules/${entry}`;
      if (entry.endsWith(".md") && !expected.has(relPath)) {
        await fs.rm(path.join(modulesDir, entry));
        pages.push({ relPath, action: "removed", slots: [] });
      }
    }
  } catch {
    // No modules dir yet.
  }

  const after = await snapshotWiki(root);
  const contentChanged = before !== after;
  let metaWritten = false;

  if (contentChanged) {
    const previous = await readMeta(root);
    const meta: WikiMeta = {
      version: VERSION,
      updatedAt: new Date().toISOString(),
      command,
      gitHead,
      pages: templates.length,
      ...(previous?.backend ? { backend: previous.backend } : {}),
      ...(previous?.scope !== undefined ? { scope: previous.scope } : {}),
    };
    await fs.writeFile(
      path.join(dir, META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8",
    );
    metaWritten = true;
  }

  return { pages, slotCounts, contentChanged, metaWritten };
}
