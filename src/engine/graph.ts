import path from "node:path";
import type { FileSymbols } from "./symbols.js";
import type { ScanResult } from "./scan.js";

/**
 * Module graph: files are grouped into "modules" (the children of the source
 * root, or top-level dirs), and relative imports between files become edges
 * between modules. This powers the architecture Mermaid diagram and the
 * imports/imported-by sections of module pages.
 */

export interface ModuleInfo {
  name: string;
  files: string[];
  /** module -> number of file-level import edges into it */
  importsTo: Map<string, number>;
  importedBy: Map<string, number>;
}

export interface ModuleGraph {
  modules: Map<string, ModuleInfo>;
  moduleOf: (file: string) => string | null;
}

export function buildModuleGraph(
  scan: ScanResult,
  symbols: Map<string, FileSymbols>,
): ModuleGraph {
  const prefix = scan.sourceRoot ? `${scan.sourceRoot}/` : "";

  function moduleOf(file: string): string | null {
    if (prefix && !file.startsWith(prefix)) {
      // Code outside the source root groups under its top-level dir.
      return file.includes("/") ? file.slice(0, file.indexOf("/")) : null;
    }

    const inner = file.slice(prefix.length);
    if (!inner.includes("/")) {
      // Files directly in the source root form the "(root)" module.
      return prefix ? `${scan.sourceRoot} (root)` : null;
    }

    return prefix + inner.slice(0, inner.indexOf("/"));
  }

  const modules = new Map<string, ModuleInfo>();

  function ensure(name: string): ModuleInfo {
    let module = modules.get(name);
    if (!module) {
      module = {
        name,
        files: [],
        importsTo: new Map(),
        importedBy: new Map(),
      };
      modules.set(name, module);
    }
    return module;
  }

  for (const file of scan.codeFiles) {
    const module = moduleOf(file);
    if (module !== null) {
      ensure(module).files.push(file);
    }
  }

  const fileSet = new Set(scan.files);

  for (const [file, fileSymbols] of symbols) {
    const fromModule = moduleOf(file);
    if (fromModule === null) {
      continue;
    }

    for (const importPath of fileSymbols.imports) {
      const resolved = resolveRelativeImport(file, importPath, fileSet);
      if (!resolved) {
        continue;
      }

      const toModule = moduleOf(resolved);
      if (toModule === null || toModule === fromModule) {
        continue;
      }

      const from = ensure(fromModule);
      const to = ensure(toModule);
      from.importsTo.set(toModule, (from.importsTo.get(toModule) ?? 0) + 1);
      to.importedBy.set(fromModule, (to.importedBy.get(fromModule) ?? 0) + 1);
    }
  }

  for (const module of modules.values()) {
    module.files.sort();
  }

  return { modules, moduleOf };
}

/** Resolve `./x` / `../y` style imports to an actual repo file, if possible. */
function resolveRelativeImport(
  fromFile: string,
  importPath: string,
  files: Set<string>,
): string | null {
  if (!importPath.startsWith(".")) {
    return null;
  }

  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), importPath),
  );

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.py`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/__init__.py`,
    // TS ESM style: import "./x.js" resolving to x.ts / x.tsx
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
  ];

  for (const candidate of candidates) {
    if (files.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function renderMermaid(graph: ModuleGraph): string {
  const nodes = [...graph.modules.values()]
    .filter((module) => module.files.length > 0)
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, 20);

  if (nodes.length === 0) {
    return "";
  }

  const idOf = (name: string): string =>
    name.replace(/[^\w]/g, "_").replace(/^(\d)/, "_$1");

  const lines = ["```mermaid", "flowchart LR"];

  for (const node of nodes) {
    lines.push(
      `  ${idOf(node.name)}["${node.name} (${node.files.length})"]`,
    );
  }

  const nodeNames = new Set(nodes.map((node) => node.name));
  const edges: string[] = [];

  for (const node of nodes) {
    for (const [target, weight] of [...node.importsTo.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      if (nodeNames.has(target)) {
        edges.push(`  ${idOf(node.name)} -->|${weight}| ${idOf(target)}`);
      }
    }
  }

  lines.push(...edges.slice(0, 40), "```");

  return edges.length > 0 ? lines.join("\n") : "";
}
