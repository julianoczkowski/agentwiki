import fs from "node:fs/promises";
import path from "node:path";

/**
 * Deterministic, dependency-free symbol and import extraction.
 *
 * This intentionally trades exhaustive parsing for zero runtime dependencies:
 * line-anchored patterns catch the overwhelmingly common declaration styles in
 * each language, which is all the wiki needs (a map, not a compiler).
 */

export interface FileSymbols {
  file: string;
  language: string;
  exports: string[];
  imports: string[];
}

const MAX_FILE_BYTES = 512 * 1024;

export async function extractSymbols(
  root: string,
  files: string[],
): Promise<Map<string, FileSymbols>> {
  const results = new Map<string, FileSymbols>();

  for (const file of files) {
    const extension = path.extname(file);
    const extractor = EXTRACTORS[extension];

    if (!extractor) {
      continue;
    }

    let content: string;
    try {
      const stat = await fs.stat(path.join(root, file));
      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }
      content = await fs.readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }

    results.set(file, extractor(file, content));
  }

  return results;
}

type Extractor = (file: string, content: string) => FileSymbols;

function collect(pattern: RegExp, content: string, group = 1): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const value = match[group];
    if (value) {
      found.add(value);
    }
  }

  return [...found];
}

function extractTypeScript(file: string, content: string): FileSymbols {
  const exports = new Set<string>([
    ...collect(
      /^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
      content,
    ),
    ...collect(
      /^export\s+(?:const|let|var|type)\s+([A-Za-z_$][\w$]*)/gm,
      content,
    ),
  ]);

  // export { a, b as c }
  const listPattern = /^export\s*\{([^}]+)\}/gm;
  let listMatch: RegExpExecArray | null;
  while ((listMatch = listPattern.exec(content)) !== null) {
    for (const piece of listMatch[1].split(",")) {
      const name = piece.split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
        exports.add(name);
      }
    }
  }

  if (/^export\s+default\b/m.test(content)) {
    exports.add("default");
  }

  const imports = new Set<string>([
    ...collect(
      /^import\s+(?:type\s+)?(?:[\w${},*\s]+\s+from\s+)?["']([^"']+)["']/gm,
      content,
    ),
    ...collect(/^export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm, content),
    ...collect(/require\(\s*["']([^"']+)["']\s*\)/g, content),
  ]);

  return {
    file,
    language: "TypeScript",
    exports: [...exports].sort(),
    imports: [...imports].sort(),
  };
}

function extractPython(file: string, content: string): FileSymbols {
  const exports = [
    ...collect(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, content),
    ...collect(/^class\s+([A-Za-z_]\w*)/gm, content),
  ].filter((name) => !name.startsWith("_"));

  const imports = new Set<string>([
    ...collect(/^from\s+([\w.]+)\s+import\b/gm, content),
    ...collect(/^import\s+([\w.]+)/gm, content),
  ]);

  return {
    file,
    language: "Python",
    exports: [...new Set(exports)].sort(),
    imports: [...imports].sort(),
  };
}

function extractGo(file: string, content: string): FileSymbols {
  const exports = [
    ...collect(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*\(/gm, content),
    ...collect(/^type\s+([A-Z]\w*)\s/gm, content),
    ...collect(/^(?:var|const)\s+([A-Z]\w*)/gm, content),
  ];

  const imports: string[] = [];
  const importBlock = content.match(/import\s*\(([^)]*)\)/s);
  if (importBlock) {
    imports.push(...collect(/"([^"]+)"/g, importBlock[1]));
  }
  imports.push(...collect(/^import\s+"([^"]+)"/gm, content));

  return {
    file,
    language: "Go",
    exports: [...new Set(exports)].sort(),
    imports: [...new Set(imports)].sort(),
  };
}

function extractRust(file: string, content: string): FileSymbols {
  const exports = collect(
    /^\s*pub\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|mod|type|const|static)\s+([A-Za-z_]\w*)/gm,
    content,
  );

  const imports = collect(/^\s*use\s+([\w:]+)/gm, content).map(
    (import_) => import_.split("::")[0],
  );

  return {
    file,
    language: "Rust",
    exports: exports.sort(),
    imports: [...new Set(imports)].sort(),
  };
}

const EXTRACTORS: Record<string, Extractor> = {
  ".ts": extractTypeScript,
  ".tsx": extractTypeScript,
  ".mts": extractTypeScript,
  ".cts": extractTypeScript,
  ".js": extractTypeScript,
  ".jsx": extractTypeScript,
  ".mjs": extractTypeScript,
  ".cjs": extractTypeScript,
  ".py": extractPython,
  ".go": extractGo,
  ".rs": extractRust,
};
