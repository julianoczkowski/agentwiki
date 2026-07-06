import { looksLikeAuthFailure, runAgentProcess, tryExec } from "./process.js";
import type { AgentBackend, BackendStatus } from "./types.js";

export const cursorBackend: AgentBackend = {
  id: "cursor",
  label: "Cursor CLI",
  binary: "cursor-agent",
  installHint: "curl https://cursor.com/install -fsS | bash",
  loginHint: "cursor-agent login",

  async detect(): Promise<BackendStatus> {
    const version = await tryExec("cursor-agent", ["--version"]);

    if (!version.ok) {
      return {
        installed: false,
        version: null,
        auth: "missing",
        authDetail: "cursor-agent binary not found on PATH",
      };
    }

    // CURSOR_API_KEY (CI) takes precedence over interactive login state.
    if (process.env.CURSOR_API_KEY) {
      return {
        installed: true,
        version: version.stdout.trim() || null,
        auth: "ok",
        authDetail: "authenticated via CURSOR_API_KEY",
      };
    }

    const status = await tryExec("cursor-agent", ["status"]);
    const combined = `${status.stdout}\n${status.stderr}`;

    if (/logged in|authenticated/i.test(combined) && !/not logged/i.test(combined)) {
      return {
        installed: true,
        version: version.stdout.trim() || null,
        auth: "ok",
        authDetail: "logged in (cursor-agent status)",
      };
    }

    if (/not logged|unauthenticated|login/i.test(combined) || looksLikeAuthFailure(combined)) {
      return {
        installed: true,
        version: version.stdout.trim() || null,
        auth: "missing",
        authDetail: "not logged in — token missing or expired",
      };
    }

    return {
      installed: true,
      version: version.stdout.trim() || null,
      auth: "unknown",
      authDetail: "could not determine login state from `cursor-agent status`",
    };
  },

  enrich(prompt, cwd, onOutput) {
    return runAgentProcess(
      "cursor-agent",
      ["-p", prompt, "--output-format", "text", "--force"],
      cwd,
      onOutput,
    );
  },
};
