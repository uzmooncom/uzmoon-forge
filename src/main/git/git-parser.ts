/**
 * git-parser.ts — Pure parsers for git porcelain output.
 *
 * No process spawning. No side effects. Fully deterministic.
 * All parsers operate on string input and return typed structures.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface GitStatusEntry {
  /** Two-char porcelain v1 XY code: X=staged, Y=working tree */
  xy: string;
  path: string;
  /** Original path (for renames/copies) */
  origPath?: string;
}

export interface GitStatusParsed {
  branch: string | null;
  /** null = detached HEAD, undefined = unborn branch */
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  conflicts: GitStatusEntry[];
  isClean: boolean;
  isDetachedHead: boolean;
  isInitialCommit: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
}

export interface GitDiffStats {
  files: string[];
  additions: number;
  deletions: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const GIT_PORCELAIN_V1_AHEAD_BEHIND =
  /^## .+\.\.\..+ \[ahead (\d+)(?:, behind (\d+))?\]$|^## .+\.\.\..+ \[behind (\d+)\]$/;

// ── Status parser ───────────────────────────────────────────────────────────

/**
 * Parse `git status --porcelain=v1 -b -u` output.
 *
 * Branch header line: `## main...origin/main [ahead 1, behind 2]`
 * or `## HEAD (no branch)` for detached HEAD
 * or `## No commits yet on main` for unborn branch
 *
 * Status lines: XY <space> path
 * Renamed: XY <space> new_path -> old_path   (porcelain v1 uses \0 in -z mode)
 */
export function parseGitStatus(raw: string): GitStatusParsed {
  const lines = raw.split("\n").filter((l) => l.length > 0);

  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let isDetachedHead = false;
  let isInitialCommit = false;

  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  const conflicts: GitStatusEntry[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const header = line.slice(3);

      if (header.startsWith("HEAD (no branch)")) {
        isDetachedHead = true;
        branch = null;
      } else if (header.startsWith("No commits yet on ")) {
        isInitialCommit = true;
        branch = header.replace("No commits yet on ", "").trim();
      } else {
        // Parse "branch...upstream [ahead N, behind M]"
        const dotIdx = header.indexOf("...");
        if (dotIdx !== -1) {
          branch = header.slice(0, dotIdx);
          const rest = header.slice(dotIdx + 3);
          // upstream is everything before ' [ahead'
          const bracketIdx = rest.indexOf(" [");
          upstream = bracketIdx !== -1 ? rest.slice(0, bracketIdx) : rest;

          const match = GIT_PORCELAIN_V1_AHEAD_BEHIND.exec(line);
          if (match) {
            ahead = parseInt(match[1] ?? "0") || 0;
            behind = parseInt(match[2] ?? match[3] ?? "0") || 0;
          }
        } else {
          // Branch with no upstream: "## main"
          branch = header.trim();
        }
      }
      continue;
    }

    if (line.length < 3) continue;

    const X = line[0]!;
    const Y = line[1]!;
    const xy = X + Y;
    let filePart = line.slice(3);

    // Handle rename format "new -> old"
    let origPath: string | undefined;
    const arrowIdx = filePart.indexOf(" -> ");
    if (arrowIdx !== -1) {
      origPath = filePart.slice(arrowIdx + 4);
      filePart = filePart.slice(0, arrowIdx);
    }

    const entry: GitStatusEntry = { xy, path: filePart, ...(origPath ? { origPath } : {}) };

    // Conflict states: DD, AU, UD, UA, DU, AA, UU
    if (X === "U" || Y === "U" || xy === "AA" || xy === "DD") {
      conflicts.push(entry);
      continue;
    }

    // Untracked
    if (xy === "??") {
      untracked.push(entry);
      continue;
    }

    // Staged: X column is not space or ?
    if (X !== " " && X !== "?") {
      staged.push(entry);
    }

    // Unstaged: Y column is not space or ?
    if (Y !== " " && Y !== "?") {
      unstaged.push(entry);
    }
  }

  const isClean =
    staged.length === 0 &&
    unstaged.length === 0 &&
    untracked.length === 0 &&
    conflicts.length === 0;

  return {
    branch,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicts,
    isClean,
    isDetachedHead,
    isInitialCommit,
  };
}

// ── Log parser ──────────────────────────────────────────────────────────────

/** Record separator used in --format string */
const LOG_SEP = "\x1F"; // unit separator, safe inside git subjects

/**
 * Parse `git log --format=<hash><SEP><short><SEP><author><SEP><email><SEP><date><SEP><subject>` output.
 * Each record is one line (subject may not contain newlines in this format).
 */
export function parseGitLog(raw: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  const lines = raw.split("\n").filter((l) => l.includes(LOG_SEP));

  for (const line of lines) {
    const parts = line.split(LOG_SEP);
    if (parts.length < 6) continue;
    entries.push({
      hash: (parts[0] ?? "").trim(),
      shortHash: (parts[1] ?? "").trim(),
      author: (parts[2] ?? "").trim(),
      authorEmail: (parts[3] ?? "").trim(),
      date: (parts[4] ?? "").trim(),
      subject: (parts[5] ?? "").trim(),
    });
  }

  return entries;
}

/** Build the --format string for git log */
export function buildLogFormat(): string {
  return `%H${LOG_SEP}%h${LOG_SEP}%an${LOG_SEP}%ae${LOG_SEP}%aI${LOG_SEP}%s`;
}

// ── Diff stat parser ────────────────────────────────────────────────────────

/**
 * Parse `git diff --stat` output.
 * Sample lines:
 *   src/foo.ts | 5 +++--
 *   1 file changed, 3 insertions(+), 2 deletions(-)
 */
export function parseGitDiffStat(raw: string): GitDiffStats {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    // Summary line
    const summaryMatch = line.match(/(\d+) insertion|(\d+) deletion/g);
    if (summaryMatch) {
      const insMatch = line.match(/(\d+) insertion/);
      const delMatch = line.match(/(\d+) deletion/);
      if (insMatch) additions = parseInt(insMatch[1] ?? "0");
      if (delMatch) deletions = parseInt(delMatch[1] ?? "0");
      continue;
    }

    // File line: " path/to/file | N +++--"
    const pipeIdx = line.lastIndexOf("|");
    if (pipeIdx > 0) {
      const filePath = line.slice(0, pipeIdx).trim();
      if (filePath) files.push(filePath);
    }
  }

  return { files, additions, deletions };
}

// ── Commit-ish validator ─────────────────────────────────────────────────────

/** Safe commit-ish chars: hex digits, ^, ~, digits, and the special HEAD ref */
const SAFE_COMMITISH_RE = /^[0-9a-f~^@{}:./A-Z_-]{1,200}$/i;

/** Patterns that indicate shell injection attempt */
const UNSAFE_COMMITISH_PATTERNS = [
  /\s/, // whitespace
  /[;&|`$()!]/, // shell metacharacters
  /\.\.\./, // triple dot is blocked; double dot A..B is allowed
  /^-/, // flag injection
];

/**
 * Validate a commit-ish string from model input.
 * Returns true only for strings that are safe to pass as a git rev argument.
 */
export function isValidCommitish(rev: string): boolean {
  if (!rev || rev.length === 0 || rev.length > 200) return false;
  if (!SAFE_COMMITISH_RE.test(rev)) return false;
  for (const pattern of UNSAFE_COMMITISH_PATTERNS) {
    if (pattern.test(rev)) return false;
  }
  return true;
}

// ── Commit message validator ─────────────────────────────────────────────────

const MAX_COMMIT_MESSAGE_LENGTH = 5000;
const MIN_COMMIT_MESSAGE_LENGTH = 3;

/**
 * Validate a commit message from model input.
 * Rejects empty, too-short, too-long, or messages containing null bytes.
 */
export function isValidCommitMessage(msg: string): boolean {
  if (typeof msg !== "string") return false;
  const trimmed = msg.trim();
  if (trimmed.length < MIN_COMMIT_MESSAGE_LENGTH) return false;
  if (trimmed.length > MAX_COMMIT_MESSAGE_LENGTH) return false;
  if (trimmed.includes("\0")) return false;
  return true;
}

// ── Path validator for staging ───────────────────────────────────────────────

/**
 * Validate a relative path for staging.
 * Blocks absolute paths, path traversal, and shell metacharacters.
 */
export function isValidStagingPath(p: string): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return false;
  // Block absolute paths
  if (p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p)) return false;
  // Block traversal
  if (p.includes("..")) return false;
  // Block null bytes
  if (p.includes("\0")) return false;
  // Block shell metacharacters
  if (/[;&|`$()!*?]/.test(p)) return false;
  return true;
}