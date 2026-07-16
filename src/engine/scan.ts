import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CODE_EXTENSIONS,
  IGNORED_DIRS,
  LANGUAGE_BY_EXTENSION,
  WIKI_DIR,
} from "../constants.js";

const execFileAsync = promisify(execFile);

export interface ManifestInfo {
  kind: "node" | "python" | "go" | "rust";
  file: string;
  name: string | null;
  description: string | null;
  scripts: Record<string, string>;
  bin: Record<string, string>;
}

export interface ScanResult {
  /** Absolute path actually scanned — the scoped app dir in a monorepo. */
  root: string;
  /** Monorepo scope the scan was limited to ("" = whole repo). */
  scope: string;
  /** All tracked/visible files, relative to `root` with forward slashes. */
  files: string[];
  codeFiles: string[];
  totalFiles: number;
  languages: { name: string; files: number }[];
  topDirs: { name: string; files: number; codeFiles: number }[];
  manifests: ManifestInfo[];
  entrypoints: string[];
  readmes: string[];
  docsDirs: string[];
  /** Root that contains the bulk of the source ("src" or ""). */
  sourceRoot: string;
}

export async function scanRepository(
  repoRoot: string,
  scope = "",
): Promise<ScanResult> {
  // In a monorepo the scan is rooted at the chosen app dir; `git ls-files`
  // run from a subdirectory already lists only that subtree, cwd-relative.
  const root = scope ? path.join(repoRoot, scope) : repoRoot;
  const files = (await listFiles(root)).filter((file) => {
    const top = file.includes("/") ? file.slice(0, file.indexOf("/")) : file;
    return top !== WIKI_DIR && !IGNORED_DIRS.has(top);
  });
  const codeFiles = files.filter((file) =>
    CODE_EXTENSIONS.has(path.extname(file)),
  );

  const languageCounts = new Map<string, number>();
  for (const file of codeFiles) {
    const language = LANGUAGE_BY_EXTENSION[path.extname(file)];
    if (language) {
      languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    }
  }

  const dirCounts = new Map<string, { files: number; codeFiles: number }>();
  for (const file of files) {
    const top = file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
    const entry = dirCounts.get(top) ?? { files: 0, codeFiles: 0 };
    entry.files += 1;
    if (CODE_EXTENSIONS.has(path.extname(file))) {
      entry.codeFiles += 1;
    }
    dirCounts.set(top, entry);
  }

  const manifests = await readManifests(root, files);

  return {
    root,
    scope,
    files,
    codeFiles,
    totalFiles: files.length,
    languages: [...languageCounts.entries()]
      .map(([name, count]) => ({ name, files: count }))
      .sort((a, b) => b.files - a.files),
    topDirs: [...dirCounts.entries()]
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => b.files - a.files),
    manifests,
    entrypoints: detectEntrypoints(files, manifests),
    readmes: files.filter((file) =>
      /(^|\/)readme(\.[a-z]+)?$/i.test(file),
    ),
    docsDirs: [...dirCounts.keys()].filter((dir) =>
      /^(docs?|documentation|wiki)$/i.test(dir),
    ),
    sourceRoot: files.some((file) => file.startsWith("src/")) ? "src" : "",
  };
}

async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    const files = stdout.split("\n").filter(Boolean);

    if (files.length > 0) {
      const existing = await Promise.all(
        files.map(async (file) => {
          try {
            const stat = await fs.stat(path.join(root, file));
            return stat.isFile() ? file : null;
          } catch {
            return null;
          }
        }),
      );

      return existing.filter((file): file is string => file !== null);
    }
  } catch {
    // Not a git repo (or git missing): fall through to a filesystem walk.
  }

  const collected: string[] = [];
  await walk(root, "", collected);
  return collected;
}

async function walk(
  root: string,
  relative: string,
  collected: string[],
): Promise<void> {
  const entries = await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }

    const relPath = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await walk(root, relPath, collected);
      }
    } else if (entry.isFile()) {
      collected.push(relPath);
    }
  }
}

async function readManifests(
  root: string,
  files: string[],
): Promise<ManifestInfo[]> {
  const manifests: ManifestInfo[] = [];

  if (files.includes("package.json")) {
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(root, "package.json"), "utf8"),
      ) as Record<string, unknown>;

      manifests.push({
        kind: "node",
        file: "package.json",
        name: typeof parsed.name === "string" ? parsed.name : null,
        description:
          typeof parsed.description === "string" ? parsed.description : null,
        scripts: asStringRecord(parsed.scripts),
        bin:
          typeof parsed.bin === "string"
            ? { [String(parsed.name ?? "cli")]: parsed.bin }
            : asStringRecord(parsed.bin),
      });
    } catch {
      // Unparseable package.json: skip rather than fail the scan.
    }
  }

  if (files.includes("pyproject.toml")) {
    const content = await fs.readFile(
      path.join(root, "pyproject.toml"),
      "utf8",
    );
    manifests.push({
      kind: "python",
      file: "pyproject.toml",
      name: matchToml(content, "name"),
      description: matchToml(content, "description"),
      scripts: {},
      bin: {},
    });
  }

  if (files.includes("go.mod")) {
    const content = await fs.readFile(path.join(root, "go.mod"), "utf8");
    manifests.push({
      kind: "go",
      file: "go.mod",
      name: content.match(/^module\s+(\S+)/m)?.[1] ?? null,
      description: null,
      scripts: {},
      bin: {},
    });
  }

  if (files.includes("Cargo.toml")) {
    const content = await fs.readFile(path.join(root, "Cargo.toml"), "utf8");
    manifests.push({
      kind: "rust",
      file: "Cargo.toml",
      name: matchToml(content, "name"),
      description: matchToml(content, "description"),
      scripts: {},
      bin: {},
    });
  }

  return manifests;
}

function matchToml(content: string, key: string): string | null {
  return content.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      record[key] = entry;
    }
  }
  return record;
}

function detectEntrypoints(
  files: string[],
  manifests: ManifestInfo[],
): string[] {
  const entrypoints = new Set<string>();

  for (const manifest of manifests) {
    for (const target of Object.values(manifest.bin)) {
      const normalized = target.replace(/^\.\//, "");
      // bin usually points at build output; map dist/x.js back to src when possible.
      const sourceGuess = normalized
        .replace(/^dist\//, "src/")
        .replace(/\.js$/, ".ts");

      if (files.includes(normalized)) {
        entrypoints.add(normalized);
      }
      for (const candidate of [sourceGuess, `${sourceGuess}x`]) {
        if (files.includes(candidate)) {
          entrypoints.add(candidate);
        }
      }
    }
  }

  const conventional = [
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    "src/cli.ts",
    "src/cli.tsx",
    "src/app.ts",
    "index.ts",
    "index.js",
    "main.py",
    "app.py",
    "src/main.py",
    "main.go",
    "src/main.rs",
  ];

  for (const candidate of conventional) {
    if (files.includes(candidate)) {
      entrypoints.add(candidate);
    }
  }

  for (const file of files) {
    if (/^cmd\/[^/]+\/main\.go$/.test(file)) {
      entrypoints.add(file);
    }
  }

  return [...entrypoints].sort();
}
