import { runAgentProcess, tryExec } from "./process.js";
import type { AgentBackend, BackendStatus } from "./types.js";

export const claudeBackend: AgentBackend = {
  id: "claude",
  label: "Claude Code",
  binary: "claude",
  installHint: "npm install -g @anthropic-ai/claude-code",
  loginHint: "claude  # then use /login inside the session",
  installSteps: [
    {
      run: "npm install -g @anthropic-ai/claude-code",
      note: "installs Claude Code",
    },
  ],
  loginSteps: [
    {
      run: "claude",
      note: "start it once and follow the sign-in prompt (uses your Claude subscription), then type /exit",
    },
  ],

  async detect(): Promise<BackendStatus> {
    const version = await tryExec("claude", ["--version"]);

    if (!version.ok) {
      return {
        installed: false,
        version: null,
        auth: "missing",
        authDetail: "claude binary not found on PATH",
      };
    }

    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return {
        installed: true,
        version: version.stdout.trim() || null,
        auth: "ok",
        authDetail: process.env.ANTHROPIC_API_KEY
          ? "authenticated via ANTHROPIC_API_KEY"
          : "authenticated via CLAUDE_CODE_OAUTH_TOKEN",
      };
    }

    // Claude Code has no cheap offline auth probe; expired/missing logins are
    // detected at run time from the process output instead.
    return {
      installed: true,
      version: version.stdout.trim() || null,
      auth: "unknown",
      authDetail: "login state is verified when a run starts",
    };
  },

  enrich(prompt, cwd, onOutput) {
    return runAgentProcess(
      "claude",
      ["-p", prompt, "--allowedTools", "Read,Grep,Glob,Edit,Write"],
      cwd,
      onOutput,
    );
  },
};
