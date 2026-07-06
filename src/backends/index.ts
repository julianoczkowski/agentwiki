import { claudeBackend } from "./claude.js";
import { cursorBackend } from "./cursor.js";
import type {
  AgentBackend,
  BackendId,
  BackendStatus,
  SetupStep,
} from "./types.js";

export const BACKENDS: AgentBackend[] = [cursorBackend, claudeBackend];

export function getBackend(id: BackendId): AgentBackend {
  const backend = BACKENDS.find((candidate) => candidate.id === id);
  if (!backend) {
    throw new Error(`Unknown backend: ${id}`);
  }
  return backend;
}

export function isBackendId(value: string): value is BackendId {
  return value === "cursor" || value === "claude";
}

export interface DetectedBackend {
  backend: AgentBackend;
  status: BackendStatus;
}

/** The terminal steps still needed before this backend can write prose. */
export function setupSteps(
  backend: AgentBackend,
  status: BackendStatus,
): SetupStep[] {
  if (!status.installed) {
    return [...backend.installSteps, ...backend.loginSteps];
  }
  if (status.auth === "missing") {
    return backend.loginSteps;
  }
  return [];
}

/** Plain-text numbered walkthrough, e.g. for enrich/backend command output. */
export function setupGuideText(
  backend: AgentBackend,
  status: BackendStatus,
): string[] {
  const steps = setupSteps(backend, status);
  if (steps.length === 0) {
    return [];
  }

  const lines = [
    `To use ${backend.label}, do this in your terminal, one step at a time:`,
  ];
  steps.forEach((step, index) => {
    if (step.run) {
      lines.push(`  ${index + 1}. type:  ${step.run}`);
      lines.push(`          (${step.note})`);
    } else {
      lines.push(`  ${index + 1}. ${step.note}`);
    }
  });
  lines.push(`  ${steps.length + 1}. type:  agentwiki enrich`);

  return lines;
}

export async function detectBackends(): Promise<DetectedBackend[]> {
  return Promise.all(
    BACKENDS.map(async (backend) => ({
      backend,
      status: await backend.detect(),
    })),
  );
}

/**
 * Choose the backend for an enrich run: explicit flag first, then the saved
 * preference, then the first installed backend whose auth is usable.
 */
export async function pickBackend(
  explicit: BackendId | null,
  saved: BackendId | undefined,
): Promise<{ choice: DetectedBackend | null; all: DetectedBackend[] }> {
  const all = await detectBackends();

  const usable = (candidate: DetectedBackend): boolean =>
    candidate.status.installed && candidate.status.auth !== "missing";

  // An explicit flag or a saved preference is authoritative: if that backend
  // isn't ready we surface its setup guide rather than silently switching.
  const chosen = explicit ?? saved;
  if (chosen) {
    const match = all.find((candidate) => candidate.backend.id === chosen);
    return { choice: match ?? null, all };
  }

  return { choice: all.find(usable) ?? null, all };
}
