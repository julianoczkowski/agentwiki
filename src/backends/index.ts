import { claudeBackend } from "./claude.js";
import { cursorBackend } from "./cursor.js";
import type { AgentBackend, BackendId, BackendStatus } from "./types.js";

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

  if (explicit) {
    const match = all.find((candidate) => candidate.backend.id === explicit);
    return { choice: match ?? null, all };
  }

  if (saved) {
    const match = all.find((candidate) => candidate.backend.id === saved);
    if (match && usable(match)) {
      return { choice: match, all };
    }
  }

  return { choice: all.find(usable) ?? null, all };
}
