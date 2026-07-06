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

/** One terminal action in an onboarding walkthrough. */
export interface SetupStep {
  /** Command to type, if this step is a command. */
  run?: string;
  /** Plain-language explanation of the step. */
  note: string;
}

export interface AgentBackend {
  id: BackendId;
  label: string;
  binary: string;
  installHint: string;
  loginHint: string;
  /** Ordered terminal steps for a machine where the tool is not installed. */
  installSteps: SetupStep[];
  /** Ordered terminal steps when installed but not signed in. */
  loginSteps: SetupStep[];
  detect(): Promise<BackendStatus>;
  enrich(
    prompt: string,
    cwd: string,
    onOutput: (chunk: string) => void,
  ): Promise<EnrichRunResult>;
}
