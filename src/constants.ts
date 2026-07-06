export const VERSION = "0.1.0";

/** Output directory for the generated wiki, relative to the target repo root. */
export const WIKI_DIR = "agentwiki";

/** Metadata file inside the wiki dir (excluded from content snapshots). */
export const META_FILE = ".agentwiki.json";

export const CURSOR_RULE_PATH = ".cursor/rules/agentwiki.mdc";
export const CURSOR_HOOKS_PATH = ".cursor/hooks.json";
export const WORKFLOW_PATH = ".github/workflows/agentwiki.yml";

/** Directories never scanned. */
export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  ".cursor",
  ".claude",
]);

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".hpp": "C++",
  ".cc": "C++",
  ".scala": "Scala",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".zig": "Zig",
  ".lua": "Lua",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".sql": "SQL",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

/** Extensions that count as source code (used for module pages and symbols). */
export const CODE_EXTENSIONS = new Set(
  Object.keys(LANGUAGE_BY_EXTENSION).filter(
    (extension) => ![".sh", ".bash", ".zsh", ".sql"].includes(extension),
  ),
);
