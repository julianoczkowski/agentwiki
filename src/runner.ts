import fs from "node:fs/promises";
import path from "node:path";
import { detectBackends, type DetectedBackend } from "./backends/index.js";
import { WORKFLOW_PATH } from "./constants.js";
import { buildPages } from "./engine/emit.js";
import { collectGitFacts } from "./engine/git.js";
import { buildModuleGraph } from "./engine/graph.js";
import { scanRepository } from "./engine/scan.js";
import { extractSymbols } from "./engine/symbols.js";
import { scanWiki, type SlotOverview } from "./engine/queue.js";
import {
  readMeta,
  wikiExists,
  writeWiki,
  type WikiMeta,
  type WriteResult,
} from "./engine/wiki.js";
import {
  writeAgentPointers,
  writeCursorHooks,
  writeCursorRule,
  writeWorkflow,
  type IntegrationResult,
} from "./emitters/integrations.js";

export type PhaseStatus = "pending" | "running" | "done" | "warn";

export interface PhaseEvent {
  id: string;
  status: PhaseStatus;
  detail?: string;
}

export type EmitPhase = (event: PhaseEvent) => void;

export interface GenerateSummary {
  mode: "init" | "update";
  write: WriteResult;
  integrations: IntegrationResult[];
  backends: DetectedBackend[];
  totalFiles: number;
  modules: number;
  gitHead: string | null;
  workflowPresent: boolean;
}

export const GENERATE_PHASES = [
  { id: "scan", title: "Scan repository" },
  { id: "git", title: "Mine git history" },
  { id: "symbols", title: "Extract symbols & imports" },
  { id: "graph", title: "Build module graph" },
  { id: "emit", title: "Generate wiki pages" },
  { id: "wire", title: "Wire agent integrations" },
  { id: "backends", title: "Check agent backends" },
] as const;

export async function runGenerate(
  root: string,
  mode: "init" | "update",
  emitPhase: EmitPhase,
): Promise<GenerateSummary> {
  emitPhase({ id: "scan", status: "running" });
  const scan = await scanRepository(root);
  emitPhase({
    id: "scan",
    status: "done",
    detail: `${scan.totalFiles} files, ${scan.languages
      .slice(0, 3)
      .map((language) => language.name)
      .join("/")}`,
  });

  emitPhase({ id: "git", status: "running" });
  const git = await collectGitFacts(root);
  emitPhase({
    id: "git",
    status: git ? "done" : "warn",
    detail: git
      ? `${git.commitsRecent} commits in 90d, HEAD ${git.head}`
      : "not a git repository — history pages will be thin",
  });

  emitPhase({ id: "symbols", status: "running" });
  const symbols = await extractSymbols(root, scan.codeFiles);
  emitPhase({
    id: "symbols",
    status: "done",
    detail: `${symbols.size} source files parsed`,
  });

  emitPhase({ id: "graph", status: "running" });
  const graph = buildModuleGraph(scan, symbols);
  emitPhase({
    id: "graph",
    status: "done",
    detail: `${graph.modules.size} modules`,
  });

  emitPhase({ id: "emit", status: "running" });
  const pages = buildPages({ scan, git, symbols, graph });
  const write = await writeWiki(root, pages, mode, git?.head ?? null);
  emitPhase({
    id: "emit",
    status: "done",
    detail: `${pages.length} pages (${write.pages.filter((page) => page.action === "created").length} new, ${write.pages.filter((page) => page.action === "updated").length} updated)`,
  });

  emitPhase({ id: "wire", status: "running" });
  const integrations: IntegrationResult[] = [
    await writeCursorRule(root),
    await writeCursorHooks(root),
    ...(await writeAgentPointers(root)),
  ];

  // The workflow is created on init; update only refreshes an existing one so
  // hook-triggered runs never resurrect a workflow the user deleted.
  const workflowExists = await fs
    .access(path.join(root, WORKFLOW_PATH))
    .then(() => true)
    .catch(() => false);
  if (mode === "init" || workflowExists) {
    integrations.push(await writeWorkflow(root));
  }
  emitPhase({
    id: "wire",
    status: "done",
    detail: integrations
      .filter((integration) => integration.action !== "unchanged")
      .map((integration) => integration.path.split("/").pop())
      .join(", ") || "already wired",
  });

  emitPhase({ id: "backends", status: "running" });
  const backends = await detectBackends();
  const usable = backends.filter(
    (candidate) => candidate.status.installed && candidate.status.auth !== "missing",
  );
  emitPhase({
    id: "backends",
    status: usable.length > 0 ? "done" : "warn",
    detail:
      usable.length > 0
        ? usable.map((candidate) => candidate.backend.label).join(", ")
        : "no usable agent backend found",
  });

  let workflowPresent = true;
  try {
    await fs.access(path.join(root, WORKFLOW_PATH));
  } catch {
    workflowPresent = false;
  }

  return {
    mode,
    write,
    integrations,
    backends,
    totalFiles: scan.totalFiles,
    modules: graph.modules.size,
    gitHead: git?.head ?? null,
    workflowPresent,
  };
}

export interface StatusReport {
  initialized: boolean;
  meta: WikiMeta | null;
  pages: SlotOverview[];
  backends: DetectedBackend[];
}

export async function gatherStatus(root: string): Promise<StatusReport> {
  const [initialized, meta, pages, backends] = await Promise.all([
    wikiExists(root),
    readMeta(root),
    scanWiki(root),
    detectBackends(),
  ]);

  return { initialized, meta, pages, backends };
}

export interface DoctorCheck {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
}

export async function runDoctor(root: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const [major] = process.versions.node.split(".").map(Number);
  checks.push({
    label: "Node.js",
    status: major >= 20 ? "ok" : "fail",
    detail: `v${process.versions.node}`,
    hint: major >= 20 ? undefined : "agentwiki requires Node 20+",
  });

  const git = await collectGitFacts(root);
  checks.push({
    label: "Git repository",
    status: git ? "ok" : "warn",
    detail: git
      ? `branch ${git.branch} at ${git.head}`
      : "not a git repository",
    hint: git
      ? undefined
      : "run `git init` — activity pages and incremental updates need git history",
  });

  for (const { backend, status } of await detectBackends()) {
    if (!status.installed) {
      checks.push({
        label: backend.label,
        status: "warn",
        detail: "not installed",
        hint: `install: ${backend.installHint}`,
      });
    } else if (status.auth === "missing") {
      checks.push({
        label: backend.label,
        status: "warn",
        detail: `${status.version ?? "installed"} — ${status.authDetail}`,
        hint: `log in: ${backend.loginHint}`,
      });
    } else {
      checks.push({
        label: backend.label,
        status: "ok",
        detail: `${status.version ?? "installed"} — ${status.authDetail}`,
      });
    }
  }

  const initialized = await wikiExists(root);
  const meta = await readMeta(root);
  checks.push({
    label: "Wiki",
    status: initialized ? (meta?.paused ? "warn" : "ok") : "warn",
    detail: initialized
      ? `${meta?.paused ? "PAUSED, " : ""}initialized${meta ? `, last update ${meta.updatedAt} (${meta.command})` : ""}${meta?.backend ? `, preferred backend: ${meta.backend}` : ""}`
      : "not initialized",
    hint: initialized
      ? meta?.paused
        ? "run `agentwiki resume` to re-enable automation"
        : undefined
      : "run `agentwiki init`",
  });

  return checks;
}
