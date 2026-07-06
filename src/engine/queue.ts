import fs from "node:fs/promises";
import path from "node:path";
import { WIKI_DIR } from "../constants.js";
import {
  effectiveSlotStatus,
  pageFactsHash,
  parsePage,
  type ProseSlot,
  type SlotStatus,
} from "./blocks.js";
import { wikiDir } from "./wiki.js";

export interface QueueItem {
  file: string;
  slot: string;
  status: Exclude<SlotStatus, "fresh">;
  hint: string;
  /** The facts-hash value the agent must record when it writes the slot. */
  currentFactsHash: string;
}

export interface SlotOverview {
  file: string;
  slots: { slot: string; status: SlotStatus }[];
}

export async function scanWiki(root: string): Promise<SlotOverview[]> {
  const dir = wikiDir(root);
  const pages: SlotOverview[] = [];

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
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await fs.readFile(fullPath, "utf8");
        const segments = parsePage(content);
        const currentHash = pageFactsHash(segments);
        const slots = segments
          .filter((segment): segment is ProseSlot => segment.kind === "prose")
          .map((segment) => ({
            slot: segment.slot,
            status: effectiveSlotStatus(segment, currentHash),
          }));

        if (slots.length > 0) {
          pages.push({
            file: `${WIKI_DIR}/${path.relative(dir, fullPath).split(path.sep).join("/")}`,
            slots,
          });
        }
      }
    }
  }

  await visit(dir);
  return pages;
}

export async function scanQueue(root: string): Promise<QueueItem[]> {
  const dir = wikiDir(root);
  const items: QueueItem[] = [];

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
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await fs.readFile(fullPath, "utf8");
        const segments = parsePage(content);
        const currentHash = pageFactsHash(segments);

        for (const segment of segments) {
          if (segment.kind !== "prose") {
            continue;
          }

          const status = effectiveSlotStatus(segment, currentHash);
          if (status === "fresh") {
            continue;
          }

          items.push({
            file: `${WIKI_DIR}/${path.relative(dir, fullPath).split(path.sep).join("/")}`,
            slot: segment.slot,
            status,
            hint: segment.hint,
            currentFactsHash: currentHash,
          });
        }
      }
    }
  }

  await visit(dir);
  return items;
}

export function buildEnrichPrompt(items: QueueItem[]): string {
  const list = items
    .map(
      (item) =>
        `- file: ${item.file}\n  slot: "${item.slot}" (${item.status})\n  facts-hash to record: ${item.currentFactsHash}\n  what to write: ${item.hint}`,
    )
    .join("\n");

  return `You are maintaining this repository's agentwiki — a documentation wiki where machine-generated fact blocks are combined with agent-written prose.

Read ${WIKI_DIR}/quickstart.md first for context, then write the following prose slots. Explore the codebase as needed to write accurately; never invent behavior.

Prose slots to write:
${list}

Strict rules:
1. Only edit text BETWEEN a slot's markers: <!-- agentwiki:prose ... --> and <!-- /agentwiki:prose -->. Replace the placeholder text with your prose.
2. Never edit anything inside <!-- agentwiki:facts ... --> blocks, and never edit text outside the prose markers.
3. In each opening prose marker you edit, set status="fresh" and set facts-hash="<the value listed above for that slot>". Keep the slot and hint attributes unchanged.
4. For slots marked (stale), prose already exists but the underlying facts changed — revise it to match the current facts rather than rewriting from scratch.
5. Write 1-3 tight paragraphs per slot (tables/bullets allowed where clearer). Ground every claim in code you inspected.
6. Do not create, delete, or rename any files. Do not modify anything outside the ${WIKI_DIR}/ directory.

When done, reply with ONLY the list of wiki file paths you edited, one per line — no descriptions, no summaries.`;
}
