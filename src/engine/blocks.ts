import { createHash } from "node:crypto";

/**
 * Wiki pages interleave three kinds of segments:
 *
 * - fact blocks: machine-owned, regenerated on every run, never hand-edited
 * - prose slots: agent/human-owned narrative; the engine only flags staleness
 * - raw segments: static scaffolding (headings, links) owned by the template
 *
 * Freshness is derived, not trusted: a prose slot is fresh when its recorded
 * facts-hash matches the hash of the page's current fact content.
 */

export type SlotStatus = "empty" | "stale" | "fresh";

export interface FactBlock {
  kind: "facts";
  id: string;
  body: string;
}

export interface ProseSlot {
  kind: "prose";
  slot: string;
  status: SlotStatus;
  factsHash: string;
  hint: string;
  body: string;
}

export interface RawSegment {
  kind: "raw";
  body: string;
}

export type PageSegment = FactBlock | ProseSlot | RawSegment;

export const PROSE_PLACEHOLDER =
  "_Not written yet — run `agentwiki enrich`, or ask your coding agent to fill this section (see `agentwiki queue`)._";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Hash of all fact content on a page; prose slots record this at write time. */
export function pageFactsHash(segments: PageSegment[]): string {
  const facts = segments
    .filter((segment): segment is FactBlock => segment.kind === "facts")
    .map((segment) => `${segment.id}\n${segment.body.trim()}`)
    .join("\n---\n");

  return hashText(facts);
}

const OPEN_MARKER = /<!--\s*agentwiki:(facts|prose)\b([^>]*?)-->/g;

function closeMarkerFor(kind: "facts" | "prose"): RegExp {
  return new RegExp(`<!--\\s*/agentwiki:${kind}\\s*-->`);
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([\w-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(raw)) !== null) {
    attributes[match[1]] = match[2];
  }

  return attributes;
}

export function parsePage(content: string): PageSegment[] {
  const segments: PageSegment[] = [];
  let cursor = 0;

  OPEN_MARKER.lastIndex = 0;
  let open: RegExpExecArray | null;

  while ((open = OPEN_MARKER.exec(content)) !== null) {
    const kind = open[1] as "facts" | "prose";
    const attributes = parseAttributes(open[2] ?? "");
    const bodyStart = open.index + open[0].length;
    const closeMatch = closeMarkerFor(kind).exec(content.slice(bodyStart));

    if (!closeMatch) {
      // Unterminated block: treat the rest of the page as raw to avoid data loss.
      break;
    }

    if (open.index > cursor) {
      segments.push({ kind: "raw", body: content.slice(cursor, open.index) });
    }

    const body = content.slice(bodyStart, bodyStart + closeMatch.index);

    if (kind === "facts") {
      segments.push({ kind: "facts", id: attributes.id ?? "facts", body });
    } else {
      const status = attributes.status;
      segments.push({
        kind: "prose",
        slot: attributes.slot ?? "prose",
        status:
          status === "fresh" || status === "stale" || status === "empty"
            ? status
            : "empty",
        factsHash: attributes["facts-hash"] ?? "",
        hint: attributes.hint ?? "",
        body,
      });
    }

    cursor = bodyStart + closeMatch.index + closeMatch[0].length;
    OPEN_MARKER.lastIndex = cursor;
  }

  if (cursor < content.length) {
    segments.push({ kind: "raw", body: content.slice(cursor) });
  }

  return segments;
}

export function renderPage(segments: PageSegment[]): string {
  const currentHash = pageFactsHash(segments);

  return segments
    .map((segment) => {
      if (segment.kind === "raw") {
        return segment.body;
      }

      if (segment.kind === "facts") {
        return [
          `<!-- agentwiki:facts id="${segment.id}" hash="${currentHash}" -->`,
          segment.body.replace(/^\n+|\n+$/g, ""),
          `<!-- /agentwiki:facts -->`,
        ].join("\n");
      }

      return [
        `<!-- agentwiki:prose slot="${segment.slot}" status="${segment.status}" facts-hash="${segment.factsHash}" hint="${escapeAttribute(segment.hint)}" -->`,
        segment.body.replace(/^\n+|\n+$/g, ""),
        `<!-- /agentwiki:prose -->`,
      ].join("\n");
    })
    .join("");
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "'");
}

export function isPlaceholderProse(body: string): boolean {
  const trimmed = body.trim();

  return trimmed.length === 0 || trimmed === PROSE_PLACEHOLDER;
}

/** Derive the true status of a slot from its content and the current facts. */
export function effectiveSlotStatus(
  slot: ProseSlot,
  currentFactsHash: string,
): SlotStatus {
  if (isPlaceholderProse(slot.body)) {
    return "empty";
  }

  return slot.factsHash === currentFactsHash ? "fresh" : "stale";
}

export interface MergeResult {
  content: string;
  slots: { slot: string; status: SlotStatus }[];
  changed: boolean;
}

/**
 * Merge a freshly generated template into the existing page: fact blocks are
 * replaced wholesale, prose written by agents/humans is preserved and only
 * re-flagged when the facts underneath it changed.
 */
export function mergePage(
  existing: string | null,
  template: PageSegment[],
): MergeResult {
  const currentHash = pageFactsHash(template);
  const existingSlots = new Map<string, ProseSlot>();

  if (existing !== null) {
    for (const segment of parsePage(existing)) {
      if (segment.kind === "prose") {
        existingSlots.set(segment.slot, segment);
      }
    }
  }

  const merged: PageSegment[] = template.map((segment) => {
    if (segment.kind !== "prose") {
      return segment;
    }

    const previous = existingSlots.get(segment.slot);

    if (!previous || isPlaceholderProse(previous.body)) {
      return {
        ...segment,
        status: "empty" as const,
        factsHash: currentHash,
        body: `\n${PROSE_PLACEHOLDER}\n`,
      };
    }

    const status = effectiveSlotStatus(previous, currentHash);

    return {
      ...segment,
      status,
      factsHash: previous.factsHash,
      body: previous.body,
    };
  });

  const content = renderPage(merged);

  return {
    content,
    slots: merged
      .filter((segment): segment is ProseSlot => segment.kind === "prose")
      .map((segment) => ({ slot: segment.slot, status: segment.status })),
    changed: existing === null || normalize(existing) !== normalize(content),
  };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}
