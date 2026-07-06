import { describe, expect, it } from "vitest";
import {
  effectiveSlotStatus,
  mergePage,
  pageFactsHash,
  parsePage,
  renderPage,
  PROSE_PLACEHOLDER,
  type PageSegment,
  type ProseSlot,
} from "../src/engine/blocks.js";

function template(factsBody: string): PageSegment[] {
  return [
    { kind: "raw", body: "# Title\n\n" },
    { kind: "facts", id: "identity", body: `\n${factsBody}\n` },
    { kind: "raw", body: "\n\n## Section\n\n" },
    {
      kind: "prose",
      slot: "overview",
      status: "empty",
      factsHash: "",
      hint: "Explain the thing.",
      body: "\n",
    },
    { kind: "raw", body: "\n" },
  ];
}

describe("parse/render round trip", () => {
  it("preserves structure and attributes", () => {
    const { content } = mergePage(null, template("- fact A"));
    const segments = parsePage(content);

    expect(segments.filter((segment) => segment.kind === "facts")).toHaveLength(1);
    const slot = segments.find(
      (segment): segment is ProseSlot => segment.kind === "prose",
    );
    expect(slot?.slot).toBe("overview");
    expect(slot?.status).toBe("empty");
    expect(slot?.hint).toBe("Explain the thing.");
    expect(renderPage(segments)).toBe(content);
  });

  it("treats an unterminated block as raw without losing content", () => {
    const broken = `intro\n<!-- agentwiki:facts id="x" -->\nno close marker`;
    const segments = parsePage(broken);
    expect(segments.some((segment) => segment.kind === "facts")).toBe(false);
    expect(renderPage(segments)).toContain("intro");
  });
});

describe("mergePage", () => {
  it("initializes prose slots empty with the current facts hash", () => {
    const { content, slots } = mergePage(null, template("- fact A"));
    expect(slots).toEqual([{ slot: "overview", status: "empty" }]);
    expect(content).toContain(PROSE_PLACEHOLDER);
    expect(content).toContain(`facts-hash="${pageFactsHash(template("- fact A"))}"`);
  });

  it("keeps agent prose fresh while facts are unchanged", () => {
    const first = mergePage(null, template("- fact A"));
    const written = first.content.replace(
      PROSE_PLACEHOLDER,
      "Real prose written by an agent.",
    );

    const second = mergePage(written, template("- fact A"));
    expect(second.slots).toEqual([{ slot: "overview", status: "fresh" }]);
    expect(second.content).toContain("Real prose written by an agent.");
  });

  it("flags prose stale (but preserves it) when facts change", () => {
    const first = mergePage(null, template("- fact A"));
    const written = first.content.replace(
      PROSE_PLACEHOLDER,
      "Real prose written by an agent.",
    );

    const changed = mergePage(written, template("- fact B (changed)"));
    expect(changed.slots).toEqual([{ slot: "overview", status: "stale" }]);
    expect(changed.content).toContain("Real prose written by an agent.");
    expect(changed.content).toContain("- fact B (changed)");
    expect(changed.content).not.toContain("- fact A");
  });

  it("reports unchanged content as not changed", () => {
    const first = mergePage(null, template("- fact A"));
    const second = mergePage(first.content, template("- fact A"));
    expect(second.changed).toBe(false);
  });

  it("heals status attributes that agents forgot to update", () => {
    const currentHash = pageFactsHash(template("- fact A"));
    // Agent wrote prose and correct facts-hash but left status="empty".
    const page = mergePage(null, template("- fact A")).content.replace(
      PROSE_PLACEHOLDER,
      "Prose without status update.",
    );
    const merged = mergePage(page, template("- fact A"));
    expect(merged.slots).toEqual([{ slot: "overview", status: "fresh" }]);
    expect(merged.content).toContain(`status="fresh"`);
    expect(merged.content).toContain(`facts-hash="${currentHash}"`);
  });
});

describe("volatile fact blocks", () => {
  const withVolatile = (structural: string, volatileBody: string): PageSegment[] => [
    { kind: "raw", body: "# Title\n\n" },
    { kind: "facts", id: "structure", body: `\n${structural}\n` },
    { kind: "facts", id: "git-state", body: `\n${volatileBody}\n`, volatile: true },
    {
      kind: "prose",
      slot: "overview",
      status: "empty",
      factsHash: "",
      hint: "",
      body: "\n",
    },
  ];

  it("volatile changes do not stale prose", () => {
    const first = mergePage(null, withVolatile("- exports: a, b", "- HEAD abc123"));
    const written = first.content.replace(PROSE_PLACEHOLDER, "Agent prose.");

    const afterCommit = mergePage(
      written,
      withVolatile("- exports: a, b", "- HEAD def456"),
    );
    expect(afterCommit.slots).toEqual([{ slot: "overview", status: "fresh" }]);
    expect(afterCommit.content).toContain("- HEAD def456");
  });

  it("structural changes still stale prose", () => {
    const first = mergePage(null, withVolatile("- exports: a, b", "- HEAD abc123"));
    const written = first.content.replace(PROSE_PLACEHOLDER, "Agent prose.");

    const afterExportChange = mergePage(
      written,
      withVolatile("- exports: a, b, NEW", "- HEAD def456"),
    );
    expect(afterExportChange.slots).toEqual([{ slot: "overview", status: "stale" }]);
  });

  it("volatile attribute survives a parse/render round trip", () => {
    const { content } = mergePage(null, withVolatile("- x", "- HEAD abc"));
    expect(content).toContain('id="git-state" hash="');
    expect(content).toContain('volatile="true"');
    const reparsed = parsePage(content);
    const block = reparsed.find(
      (segment) => segment.kind === "facts" && segment.id === "git-state",
    );
    expect(block && "volatile" in block && block.volatile).toBe(true);
  });
});

describe("effectiveSlotStatus", () => {
  const slot = (body: string, factsHash: string): ProseSlot => ({
    kind: "prose",
    slot: "s",
    status: "empty",
    factsHash,
    hint: "",
    body,
  });

  it("empty for placeholder or whitespace bodies", () => {
    expect(effectiveSlotStatus(slot(`\n${PROSE_PLACEHOLDER}\n`, "abc"), "abc")).toBe("empty");
    expect(effectiveSlotStatus(slot("  \n ", "abc"), "abc")).toBe("empty");
  });

  it("fresh when hashes match, stale otherwise", () => {
    expect(effectiveSlotStatus(slot("text", "abc"), "abc")).toBe("fresh");
    expect(effectiveSlotStatus(slot("text", "old"), "abc")).toBe("stale");
  });
});
