import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { EnrichRunResult } from "./types.js";

const execFileAsync = promisify(execFile);

export async function tryExec(
  binary: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

const AUTH_FAILURE_PATTERN =
  /not logged in|log ?in required|please (?:log ?in|run .*login|authenticate)|unauthorized|401|invalid (?:api key|token|credentials)|token .*expired|expired.*token|authentication (?:failed|required|error)/i;

export function looksLikeAuthFailure(output: string): boolean {
  return AUTH_FAILURE_PATTERN.test(output);
}

export function runAgentProcess(
  binary: string,
  args: string[],
  cwd: string,
  onOutput: (chunk: string) => void,
): Promise<EnrichRunResult> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const capture = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      output += text;
      onOutput(text);
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    child.on("error", (error) => {
      resolve({
        ok: false,
        authFailed: false,
        exitCode: null,
        output: `${output}\n${String(error)}`,
      });
    });

    child.on("close", (code) => {
      const ok = code === 0;
      resolve({
        ok,
        authFailed: !ok && looksLikeAuthFailure(output),
        exitCode: code,
        output,
      });
    });
  });
}
