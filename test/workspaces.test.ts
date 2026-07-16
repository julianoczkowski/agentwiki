import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspaceApps } from "../src/engine/workspaces.js";
import { scanRepository } from "../src/engine/scan.js";

const tempDirs: string[] = [];

async function makeRepo(
  files: Record<string, string>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentwiki-test-"));
  tempDirs.push(root);

  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(root, relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("detectWorkspaceApps", () => {
  it("expands package.json workspaces globs", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "mono",
        workspaces: ["apps/*", "tools/scripts"],
      }),
      "apps/web/package.json": JSON.stringify({ name: "@mono/web" }),
      "apps/api/package.json": JSON.stringify({ name: "@mono/api" }),
      "tools/scripts/package.json": JSON.stringify({ name: "@mono/scripts" }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => app.dir)).toEqual([
      "apps/api",
      "apps/web",
      "tools/scripts",
    ]);
    expect(apps.find((app) => app.dir === "apps/web")?.name).toBe("@mono/web");
  });

  it("reads pnpm-workspace.yaml patterns", async () => {
    const root = await makeRepo({
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\n',
      "apps/dashboard/package.json": JSON.stringify({ name: "dashboard" }),
      "packages/ui/package.json": JSON.stringify({ name: "ui" }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => app.dir)).toEqual([
      "apps/dashboard",
      "packages/ui",
    ]);
  });

  it("sweeps for nested manifests without any workspace config", async () => {
    const root = await makeRepo({
      "services/auth/go.mod": "module example.com/auth\n",
      "services/billing/go.mod": "module example.com/billing\n",
      "web/package.json": JSON.stringify({ name: "web" }),
      "docs/readme.md": "# docs",
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => app.dir)).toEqual([
      "services/auth",
      "services/billing",
      "web",
    ]);
    expect(apps.find((app) => app.dir === "services/auth")?.name).toBe(
      "example.com/auth",
    );
  });

  it("classifies apps vs shared packages and lists apps first", async () => {
    const root = await makeRepo({
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\n',
      "apps/web/package.json": JSON.stringify({ name: "@repo/web" }),
      "apps/admin/package.json": JSON.stringify({ name: "@repo/admin" }),
      "packages/ui/package.json": JSON.stringify({ name: "@repo/ui" }),
      "packages/tsconfig/package.json": JSON.stringify({
        name: "@repo/tsconfig",
      }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => `${app.dir}:${app.kind}`)).toEqual([
      "apps/admin:app",
      "apps/web:app",
      "packages/tsconfig:package",
      "packages/ui:package",
    ]);
  });

  it("supports NX layouts: workspaceLayout dirs and project.json projectType", async () => {
    const root = await makeRepo({
      "nx.json": JSON.stringify({
        workspaceLayout: { appsDir: "clients/apps", libsDir: "shared/libs" },
      }),
      "package.json": JSON.stringify({ name: "nx-mono" }),
      // NX integrated repo: project.json only, no per-app package.json.
      "clients/apps/storefront/project.json": JSON.stringify({
        name: "storefront",
        projectType: "application",
      }),
      "clients/apps/checkout/project.json": JSON.stringify({
        name: "checkout",
        projectType: "application",
      }),
      "shared/libs/design-system/project.json": JSON.stringify({
        name: "design-system",
        projectType: "library",
      }),
      // projectType wins over the appsDir location.
      "clients/apps/e2e-utils/project.json": JSON.stringify({
        name: "e2e-utils",
        projectType: "library",
      }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => `${app.dir}:${app.kind}`)).toEqual([
      "clients/apps/checkout:app",
      "clients/apps/storefront:app",
      "clients/apps/e2e-utils:package",
      "shared/libs/design-system:package",
    ]);
    expect(apps[0]?.name).toBe("checkout");
  });

  it("descends into a nested workspace root instead of listing it as an app", async () => {
    // trimble-web-apps shape: the repo root has no workspace config at all;
    // clients/ is the actual NX workspace with its own nx.json + package.json.
    const root = await makeRepo({
      "build/readme.txt": "build scripts",
      "clients/nx.json": JSON.stringify({}),
      "clients/package.json": JSON.stringify({ name: "clients-workspace" }),
      "clients/apps/modus/project.json": JSON.stringify({
        name: "modus",
        projectType: "application",
      }),
      "clients/apps/field/project.json": JSON.stringify({
        name: "field",
        projectType: "application",
      }),
      "clients/libs/shared-ui/project.json": JSON.stringify({
        name: "shared-ui",
        projectType: "library",
      }),
      "clients/tools/generators/package.json": JSON.stringify({
        name: "generators",
      }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => `${app.dir}:${app.kind}`)).toEqual([
      "clients/apps/field:app",
      "clients/apps/modus:app",
      "clients/libs/shared-ui:package",
      "clients/tools/generators:package",
    ]);
    // The workspace container itself must never be offered as an app.
    expect(apps.some((app) => app.dir === "clients")).toBe(false);
  });

  it("applies a nested workspace's own nx.json layout and workspace globs", async () => {
    const root = await makeRepo({
      "clients/nx.json": JSON.stringify({
        workspaceLayout: { appsDir: "products", libsDir: "shared" },
      }),
      "clients/package.json": JSON.stringify({
        name: "ws",
        workspaces: ["products/*", "shared/*"],
      }),
      "clients/products/alpha/package.json": JSON.stringify({ name: "alpha" }),
      "clients/products/beta/package.json": JSON.stringify({ name: "beta" }),
      "clients/shared/kit/package.json": JSON.stringify({ name: "kit" }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => `${app.dir}:${app.kind}`)).toEqual([
      "clients/products/alpha:app",
      "clients/products/beta:app",
      "clients/shared/kit:package",
    ]);
  });

  it("reads the NX project-graph cache: manifest-less apps, e2e demotion, stale entries", async () => {
    const root = await makeRepo({
      "clients/nx.json": JSON.stringify({}),
      "clients/package.json": JSON.stringify({ name: "clients-ws" }),
      // NX knows tcweb is an app even though it has NO manifest on disk
      // (plugin-inferred from its webpack config).
      "clients/.nx/workspace-data/project-graph.json": JSON.stringify({
        graph: {
          nodes: {
            tcweb: { type: "app", data: { root: "apps/tcweb" } },
            "tcweb-e2e": { type: "e2e", data: { root: "apps/tcweb-e2e" } },
            "maya-viewer": { type: "app", data: { root: "apps/maya-viewer" } },
            "shared-ui": { type: "lib", data: { root: "libs/shared-ui" } },
            ghost: { type: "app", data: { root: "apps/deleted-long-ago" } },
          },
        },
      }),
      "clients/apps/tcweb/webpack.config.js": "module.exports = {};",
      // Vendored subfolder with its own package.json must not become a member.
      "clients/apps/tcweb/build/components/react-hotkeys/package.json":
        JSON.stringify({ name: "react-hotkeys" }),
      "clients/apps/tcweb-e2e/project.json": JSON.stringify({
        name: "tcweb-e2e",
        projectType: "application",
      }),
      "clients/apps/maya-viewer/project.json": JSON.stringify({
        name: "@trimble/maya-viewer",
        projectType: "application",
      }),
      "clients/libs/shared-ui/project.json": JSON.stringify({
        name: "shared-ui",
        projectType: "library",
      }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => `${app.dir}:${app.kind}`)).toEqual([
      "clients/apps/maya-viewer:app",
      "clients/apps/tcweb:app",
      "clients/apps/tcweb-e2e:package",
      "clients/libs/shared-ui:package",
    ]);
    // Stale graph entries and vendored subfolders never surface.
    expect(apps.some((app) => app.dir.includes("deleted-long-ago"))).toBe(false);
    expect(apps.some((app) => app.dir.includes("react-hotkeys"))).toBe(false);
  });

  it("demotes e2e and integration-test projects even when typed as applications", async () => {
    const root = await makeRepo({
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
      "apps/viewer/project.json": JSON.stringify({
        name: "viewer",
        projectType: "application",
      }),
      "apps/viewer-e2e/project.json": JSON.stringify({
        name: "viewer-e2e",
        projectType: "application",
      }),
      "apps/viewer-integration-tests/project.json": JSON.stringify({
        name: "viewer-integration-tests",
        projectType: "application",
      }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => `${app.dir}:${app.kind}`)).toEqual([
      "apps/viewer:app",
      "apps/viewer-e2e:package",
      "apps/viewer-integration-tests:package",
    ]);
  });

  it("finds at most one app in a single-project repo", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({ name: "single" }),
      "src/index.ts": "export {};\n",
      "test/index.test.ts": "export {};\n",
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.length).toBeLessThan(2);
  });

  it("skips ignored directories and rejects escaping patterns", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        workspaces: ["../outside", "/абс", "node_modules/*", "apps/*"],
      }),
      "node_modules/dep/package.json": JSON.stringify({ name: "dep" }),
      "apps/one/package.json": JSON.stringify({ name: "one" }),
      "apps/two/package.json": JSON.stringify({ name: "two" }),
    });

    const apps = await detectWorkspaceApps(root);

    expect(apps.map((app) => app.dir)).toEqual(["apps/one", "apps/two"]);
  });
});

describe("scanRepository with a monorepo scope", () => {
  it("scopes files, manifests, and language stats to the app dir", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({
        name: "@mono/web",
        scripts: { dev: "vite" },
      }),
      "apps/web/src/main.ts": "export const x = 1;\n",
      "apps/web/README.md": "# web",
      "apps/api/package.json": JSON.stringify({ name: "@mono/api" }),
      "apps/api/src/server.py": "x = 1\n",
    });

    const scan = await scanRepository(root, "apps/web");

    expect(scan.scope).toBe("apps/web");
    expect(scan.root).toBe(path.join(root, "apps/web"));
    expect(scan.files).toEqual(
      expect.arrayContaining(["package.json", "src/main.ts", "README.md"]),
    );
    expect(scan.files.some((file) => file.includes("api"))).toBe(false);
    expect(scan.manifests[0]?.name).toBe("@mono/web");
    expect(scan.languages.map((language) => language.name)).toEqual([
      "TypeScript",
    ]);
    expect(scan.readmes).toEqual(["README.md"]);
  });

  it("scans the whole repo when no scope is given", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({ name: "mono" }),
      "apps/web/src/main.ts": "export const x = 1;\n",
    });

    const scan = await scanRepository(root);

    expect(scan.scope).toBe("");
    expect(scan.files).toContain("apps/web/src/main.ts");
  });
});
