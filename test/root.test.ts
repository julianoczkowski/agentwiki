import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "../src/engine/root.js";
import { matchAppForPath, type WorkspaceApp } from "../src/engine/workspaces.js";

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentwiki-root-"));
  tempDirs.push(dir);
  return fs.realpath(dir);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("findRepoRoot", () => {
  it("resolves the repo root from a nested subdirectory", async () => {
    const root = await makeDir();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const nested = path.join(root, "clients", "apps", "web");
    await fs.mkdir(nested, { recursive: true });

    expect(await findRepoRoot(nested)).toBe(root);
    expect(await findRepoRoot(root)).toBe(root);
  });

  it("returns null outside a git repository", async () => {
    const dir = await makeDir();
    // os.tmpdir() itself must not be inside a repo for this to hold.
    expect(await findRepoRoot(dir)).toBeNull();
  });
});

describe("matchAppForPath", () => {
  const apps: WorkspaceApp[] = [
    { dir: "clients/apps/web", name: "web", kind: "app" },
    { dir: "clients/apps/web-e2e", name: "web-e2e", kind: "app" },
    { dir: "packages/ui", name: "ui", kind: "package" },
  ];

  it("matches the app containing the path, longest dir first", () => {
    expect(matchAppForPath(apps, "clients/apps/web")?.name).toBe("web");
    expect(matchAppForPath(apps, "clients/apps/web/src/pages")?.name).toBe(
      "web",
    );
    expect(matchAppForPath(apps, "clients/apps/web-e2e/tests")?.name).toBe(
      "web-e2e",
    );
    expect(matchAppForPath(apps, "packages/ui")?.name).toBe("ui");
  });

  it("returns null for the root, unknown dirs, and prefix look-alikes", () => {
    expect(matchAppForPath(apps, "")).toBeNull();
    expect(matchAppForPath(apps, null)).toBeNull();
    expect(matchAppForPath(apps, "clients/apps")).toBeNull();
    expect(matchAppForPath(apps, "clients/apps/webby")).toBeNull();
  });
});
