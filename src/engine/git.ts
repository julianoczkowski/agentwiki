import { simpleGit } from "simple-git";

export interface GitFacts {
  head: string;
  branch: string;
  commitsRecent: number;
  contributorsRecent: number;
  firstCommitDate: string | null;
  hotFiles: { file: string; commits: number }[];
  recentCommits: { hash: string; date: string; author: string; message: string }[];
}

const RECENT_WINDOW = "90 days ago";

export async function collectGitFacts(root: string): Promise<GitFacts | null> {
  const git = simpleGit(root);

  try {
    if (!(await git.checkIsRepo())) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const head = (await git.revparse(["--short", "HEAD"])).trim();
    const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

    const log = await git.log([
      `--since=${RECENT_WINDOW}`,
      "--max-count=500",
    ]);

    const contributors = new Set(
      log.all.map((commit) => commit.author_email || commit.author_name),
    );

    let firstCommitDate: string | null = null;
    try {
      const rootDates = await git.raw([
        "log",
        "--max-parents=0",
        "--format=%as",
      ]);
      firstCommitDate = rootDates.trim().split("\n").pop() || null;
    } catch {
      firstCommitDate = null;
    }

    const nameOnly = await git.raw([
      "log",
      `--since=${RECENT_WINDOW}`,
      "--max-count=500",
      "--name-only",
      "--pretty=format:%h",
    ]);

    const fileCounts = new Map<string, number>();
    for (const line of nameOnly.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || /^[0-9a-f]{7,}$/.test(trimmed)) {
        continue;
      }
      fileCounts.set(trimmed, (fileCounts.get(trimmed) ?? 0) + 1);
    }

    return {
      head,
      branch,
      commitsRecent: log.total,
      contributorsRecent: contributors.size,
      firstCommitDate,
      hotFiles: [...fileCounts.entries()]
        .map(([file, commits]) => ({ file, commits }))
        .sort((a, b) => b.commits - a.commits)
        .slice(0, 12),
      recentCommits: log.all.slice(0, 10).map((commit) => ({
        hash: commit.hash.slice(0, 7),
        date: commit.date.slice(0, 10),
        author: commit.author_name,
        message: commit.message.split("\n")[0].slice(0, 100),
      })),
    };
  } catch {
    // Repos with no commits yet (fresh git init) land here.
    return null;
  }
}
