import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The git repository root containing `cwd`, or null outside a git repo.
 * All agentwiki artifacts anchor here — running the CLI from a monorepo
 * subfolder must never create a second wiki/rules/.github tree in it.
 */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 10_000 },
    );
    const top = stdout.trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}
