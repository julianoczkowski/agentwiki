export type BackendId = "cursor" | "claude";

export type AuthState = "ok" | "missing" | "unknown";

export interface BackendStatus {
  installed: boolean;
  version: string | null;
  auth: AuthState;
  authDetail: string;
}

export interface EnrichRunResult {
  ok: boolean;
  /** True when the failure looks like a missing/expired login rather than a task error. */
  authFailed: boolean;
  exitCode: number | null;
  output: string;
}

export interface AgentBackend {
  id: BackendId;
  label: string;
  binary: string;
  installHint: string;
  loginHint: string;
  detect(): Promise<BackendStatus>;
  enrich(
    prompt: string,
    cwd: string,
    onOutput: (chunk: string) => void,
  ): Promise<EnrichRunResult>;
}
