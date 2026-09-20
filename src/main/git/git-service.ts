/**
 * git-service.ts — Safe, structured Git operations for Uzmoon Forge.
 *
 * Architecture:
 *   GitService → child_process.spawn (shell: false) → git executable
 *
 * Security invariants:
 * - shell: false always (no shell composition)
 * - cwd always set to verified project root (never model-supplied)
 * - Only safe, typed subcommands are ever run (no model-controlled git args)
 * - AbortSignal honoured for all operations
 * - Output is always bounded before returning to model
 * - Commit-ish and path inputs validated by git-parser before use
 *
 * Process execution: uses child_process.spawn directly (not CommandManager)
 * because git operations are sub-operations of an agent tool call, not
 * user-visible command executions. They are short-lived, bounded, and require
 * no persistence, output paging, approval UI, or trust rules.
 * CommandManager is for user-visible command executions with approval flows.
 */
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import {
  parseGitStatus,
  parseGitLog,
  buildLogFormat,
  parseGitDiffStat,
  isValidCommitish,
  isValidCommitMessage,
  isValidStagingPath,
  type GitStatusParsed,
  type GitLogEntry,
} from "./git-parser.js";
import { forgeLogger } from "../telemetry/logger.js";
import { assertInvariant } from "../reliability/invariants.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum diff bytes returned to model (prevents context explosion) */
export const GIT_MAX_DIFF_BYTES = 64 * 1024; // 64 KB

/** Maximum log entries returned */
export const GIT_MAX_LOG_ENTRIES = 100;

/** Default log entries */
export const GIT_DEFAULT_LOG_ENTRIES = 20;

/** Git command timeout */
const GIT_TIMEOUT_MS = 30_000;

// ── Result types ─────────────────────────────────────────────────────────────

export type GitErrorCode =
  | "NOT_A_GIT_REPOSITORY"
  | "PROJECT_NOT_FOUND"
  | "PATH_OUTSIDE_PROJECT"
  | "NO_STAGED_CHANGES"
  | "MERGE_CONFLICT_PRESENT"
  | "INVALID_REVISION"
  | "INVALID_COMMIT_MESSAGE"
  | "GIT_NOT_AVAILABLE"
  | "COMMAND_FAILED"
  | "CANCELLED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "INVALID_PATH"
  | "UNSUPPORTED_OPERATION";

export interface GitResult<T = void> {
  ok: boolean;
  operation: string;
  repositoryRoot?: string;
  branch?: string;
  head?: string;
  data?: T;
  summary: string;
  errorCode?: GitErrorCode;
  errorMessage?: string;
  truncated?: boolean;
}

export interface GitStatusResult {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Array<{ xy: string; path: string; origPath?: string }>;
  unstaged: Array<{ xy: string; path: string; origPath?: string }>;
  untracked: Array<{ xy: string; path: string; origPath?: string }>;
  conflicts: Array<{ xy: string; path: string; origPath?: string }>;
  isClean: boolean;
  isDetachedHead: boolean;
  isInitialCommit: boolean;
  headCommit: string | null;
}

export interface GitDiffResult {
  text: string;
  files: string[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

export interface GitShowResult {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  diff: string;
  truncated: boolean;
}

export interface GitCommitResult {
  hash: string;
  shortHash: string;
  branch: string;
  summary: string;
}

// ── Internal runner ──────────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnFailed: string | null;
}

/**
 * Run a git subcommand with shell:false.
 * cwd must already be a validated, absolute project root.
 */
function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = GIT_TIMEOUT_MS
): Promise<RunResult> {
  return new Promise((resolve) => {
    // Pre-check signal
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true, spawnFailed: null });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Ensure consistent output regardless of locale
          GIT_TERMINAL_PROMPT: "0",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          // Disable pager
          GIT_PAGER: "cat",
          PAGER: "cat",
        },
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        cancelled: false,
        spawnFailed: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let finished = false;
    let timedOut = false;
    let cancelled = false;

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const doFinish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        timedOut,
        cancelled,
        spawnFailed: null,
      });
    };

    child.on("error", () => doFinish(null));
    child.on("close", (code) => doFinish(code));

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
    }, timeoutMs);
    if (timer.unref) timer.unref();

    // Wire AbortSignal
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          try { child.kill("SIGTERM"); } catch { /* already dead */ }
        },
        { once: true }
      );
    }
  });
}

// ── Project root validation ──────────────────────────────────────────────────

/**
 * Resolve and validate a project root.
 * Returns null if the directory does not exist or is not a git repo.
 */
export function resolveAndValidateRoot(projectRoot: string): {
  ok: true;
  root: string;
} | {
  ok: false;
  errorCode: GitErrorCode;
  errorMessage: string;
} {
  if (!projectRoot || typeof projectRoot !== "string") {
    return { ok: false, errorCode: "PROJECT_NOT_FOUND", errorMessage: "No project root supplied" };
  }

  let root: string;
  try {
    root = fs.realpathSync(path.resolve(projectRoot));
  } catch {
    return { ok: false, errorCode: "PROJECT_NOT_FOUND", errorMessage: `Project root does not exist: ${projectRoot}` };
  }

  // Check .git exists (file for worktrees or submodules, dir for normal repos)
  const gitPath = path.join(root, ".git");
  if (!fs.existsSync(gitPath)) {
    return { ok: false, errorCode: "NOT_A_GIT_REPOSITORY", errorMessage: `Not a git repository: ${root}` };
  }

  return { ok: true, root };
}

/**
 * Validate that a list of relative paths all resolve inside the project root.
 * Returns the first escaping path or null if all are safe.
 */
function validatePathsInsideRoot(paths: string[], root: string): string | null {
  for (const p of paths) {
    if (!isValidStagingPath(p)) return p;
    const resolved = path.resolve(root, p);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) return p;
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * git_status — Structured repository status.
 */
export async function gitStatus(
  projectRoot: string,
  signal?: AbortSignal
): Promise<GitResult<GitStatusResult>> {
  const validation = resolveAndValidateRoot(projectRoot);
  if (!validation.ok) {
    return { ok: false, operation: "git_status", summary: validation.errorMessage, errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }
  const root = validation.root;

  _emitLog("GIT_OPERATION_STARTED", root, "git_status");

  // Get status
  const statusRun = await runGit(["status", "--porcelain=v1", "-b", "-u"], root, signal);
  if (statusRun.cancelled) return _cancelledResult("git_status", root);
  if (statusRun.timedOut) return _failedResult("git_status", root, "COMMAND_FAILED", "git status timed out");
  if (statusRun.spawnFailed) return _failedResult("git_status", root, "GIT_NOT_AVAILABLE", `git not available: ${statusRun.spawnFailed}`);

  const parsed: GitStatusParsed = parseGitStatus(statusRun.stdout);

  // Get HEAD commit hash
  let headCommit: string | null = null;
  const revRun = await runGit(["rev-parse", "--short", "HEAD"], root, signal);
  if (!revRun.cancelled && !revRun.timedOut && revRun.exitCode === 0) {
    headCommit = revRun.stdout.trim() || null;
  }

  const data: GitStatusResult = {
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    conflicts: parsed.conflicts,
    isClean: parsed.isClean,
    isDetachedHead: parsed.isDetachedHead,
    isInitialCommit: parsed.isInitialCommit,
    headCommit,
  };

  _emitLog("GIT_OPERATION_COMPLETED", root, "git_status");

  return {
    ok: true,
    operation: "git_status",
    repositoryRoot: root,
    ...(parsed.branch !== null ? { branch: parsed.branch } : {}),
    ...(headCommit !== null ? { head: headCommit } : {}),
    data,
    summary: parsed.isClean
      ? `Repository is clean on branch ${parsed.branch ?? "(detached)"}`
      : `${parsed.staged.length} staged, ${parsed.unstaged.length} unstaged, ${parsed.untracked.length} untracked`,
  };
}

/**
 * git_diff — Working tree or staged diff.
 */
export async function gitDiff(
  projectRoot: string,
  opts: {
    staged?: boolean;
    paths?: string[];
  },
  signal?: AbortSignal
): Promise<GitResult<GitDiffResult>> {
  const validation = resolveAndValidateRoot(projectRoot);
  if (!validation.ok) {
    return { ok: false, operation: "git_diff", summary: validation.errorMessage, errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }
  const root = validation.root;

  // Validate paths if provided
  if (opts.paths && opts.paths.length > 0) {
    const escaping = validatePathsInsideRoot(opts.paths, root);
    if (escaping) {
      assertInvariant("GIT_OPERATION_OUTSIDE_PROJECT", false, { escaping, root });
      return _failedResult("git_diff", root, "PATH_OUTSIDE_PROJECT", `Path escapes project: ${escaping}`);
    }
  }

  _emitLog("GIT_OPERATION_STARTED", root, "git_diff");

  const args = ["diff"];
  if (opts.staged) args.push("--staged");
  // Always get stat first to parse metadata
  const statArgs = [...args, "--stat"];
  if (opts.paths && opts.paths.length > 0) statArgs.push("--", ...opts.paths);

  const statRun = await runGit(statArgs, root, signal);
  if (statRun.cancelled) return _cancelledResult("git_diff", root);
  if (statRun.spawnFailed) return _failedResult("git_diff", root, "GIT_NOT_AVAILABLE", statRun.spawnFailed);

  const stats = parseGitDiffStat(statRun.stdout);

  // Get actual diff text
  const diffArgs = [...args];
  if (opts.paths && opts.paths.length > 0) diffArgs.push("--", ...opts.paths);

  const diffRun = await runGit(diffArgs, root, signal);
  if (diffRun.cancelled) return _cancelledResult("git_diff", root);

  let text = diffRun.stdout;
  let truncated = false;
  if (Buffer.byteLength(text, "utf8") > GIT_MAX_DIFF_BYTES) {
    const buf = Buffer.from(text, "utf8");
    text = buf.slice(0, GIT_MAX_DIFF_BYTES).toString("utf8") + "\n\n[... diff truncated ...]";
    truncated = true;
  }

  _emitLog("GIT_OPERATION_COMPLETED", root, "git_diff");

  return {
    ok: true,
    operation: "git_diff",
    repositoryRoot: root,
    data: { text, files: stats.files, additions: stats.additions, deletions: stats.deletions, truncated },
    summary: truncated
      ? `Diff truncated. ${stats.files.length} files, +${stats.additions} -${stats.deletions}`
      : `${stats.files.length} files, +${stats.additions} -${stats.deletions}`,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * git_log — Structured commit log.
 */
export async function gitLog(
  projectRoot: string,
  opts: {
    limit?: number;
    path?: string;
  },
  signal?: AbortSignal
): Promise<GitResult<GitLogEntry[]>> {
  const validation = resolveAndValidateRoot(projectRoot);
  if (!validation.ok) {
    return { ok: false, operation: "git_log", summary: validation.errorMessage, errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }
  const root = validation.root;

  const limit = Math.min(
    Math.max(1, opts.limit ?? GIT_DEFAULT_LOG_ENTRIES),
    GIT_MAX_LOG_ENTRIES
  );

  const args = ["log", `--format=${buildLogFormat()}`, `-${limit}`];

  if (opts.path) {
    if (!isValidStagingPath(opts.path)) {
      return _failedResult("git_log", root, "INVALID_PATH", `Invalid path: ${opts.path}`);
    }
    const resolved = path.resolve(root, opts.path);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      return _failedResult("git_log", root, "PATH_OUTSIDE_PROJECT", `Path escapes project: ${opts.path}`);
    }
    args.push("--", opts.path);
  }

  _emitLog("GIT_OPERATION_STARTED", root, "git_log");

  const run = await runGit(args, root, signal);
  if (run.cancelled) return _cancelledResult("git_log", root);
  if (run.spawnFailed) return _failedResult("git_log", root, "GIT_NOT_AVAILABLE", run.spawnFailed);
  if (run.exitCode !== 0 && run.exitCode !== null) {
    // Empty repo returns exit 128
    if (run.stderr.includes("does not have any commits")) {
      _emitLog("GIT_OPERATION_COMPLETED", root, "git_log");
      return { ok: true, operation: "git_log", repositoryRoot: root, data: [], summary: "No commits yet" };
    }
    return _failedResult("git_log", root, "COMMAND_FAILED", run.stderr.slice(0, 500));
  }

  const entries = parseGitLog(run.stdout);
  _emitLog("GIT_OPERATION_COMPLETED", root, "git_log");

  return {
    ok: true,
    operation: "git_log",
    repositoryRoot: root,
    data: entries,
    summary: `${entries.length} commits`,
  };
}

/**
 * git_show — Show commit details and bounded diff.
 */
export async function gitShow(
  projectRoot: string,
  revision: string,
  signal?: AbortSignal
): Promise<GitResult<GitShowResult>> {
  const validation = resolveAndValidateRoot(projectRoot);
  if (!validation.ok) {
    return { ok: false, operation: "git_show", summary: validation.errorMessage, errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }
  const root = validation.root;

  if (!isValidCommitish(revision)) {
    return _failedResult("git_show", root, "INVALID_REVISION", `Invalid revision: ${revision}`);
  }

  _emitLog("GIT_OPERATION_STARTED", root, "git_show");

  // Get commit metadata
  const sep = "\x1F";
  const metaRun = await runGit(
    ["show", "--no-patch", `--format=%H${sep}%h${sep}%an${sep}%aI${sep}%s${sep}%b`, revision],
    root,
    signal
  );
  if (metaRun.cancelled) return _cancelledResult("git_show", root);
  if (metaRun.spawnFailed) return _failedResult("git_show", root, "GIT_NOT_AVAILABLE", metaRun.spawnFailed);
  if (metaRun.exitCode !== 0) {
    return _failedResult("git_show", root, "INVALID_REVISION", `Unknown revision: ${revision}`);
  }

  // Get diff
  const diffRun = await runGit(["show", "--format=", revision], root, signal);
  if (diffRun.cancelled) return _cancelledResult("git_show", root);

  let diff = diffRun.stdout;
  let truncated = false;
  if (Buffer.byteLength(diff, "utf8") > GIT_MAX_DIFF_BYTES) {
    const buf = Buffer.from(diff, "utf8");
    diff = buf.slice(0, GIT_MAX_DIFF_BYTES).toString("utf8") + "\n\n[... diff truncated ...]";
    truncated = true;
  }

  const metaParts = metaRun.stdout.split(sep);
  const hash = (metaParts[0] ?? "").trim();
  const shortHash = (metaParts[1] ?? "").trim();
  const author = (metaParts[2] ?? "").trim();
  const date = (metaParts[3] ?? "").trim();
  const subject = (metaParts[4] ?? "").trim();
  const body = (metaParts[5] ?? "").trim();

  _emitLog("GIT_OPERATION_COMPLETED", root, "git_show");

  return {
    ok: true,
    operation: "git_show",
    repositoryRoot: root,
    ...(shortHash ? { head: shortHash } : {}),
    data: { hash, shortHash, author, date, subject, body, diff, truncated },
    summary: `${shortHash} ${subject}`,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * git_branch_info — Current branch and local branches (read-only).
 */
export async function gitBranchInfo(
  projectRoot: string,
  signal?: AbortSignal
): Promise<GitResult<{ current: string | null; branches: string[]; upstream: string | null; ahead: number; behind: number }>> {
  const validation = resolveAndValidateRoot(projectRoot);
  if (!validation.ok) {
    return { ok: false, operation: "git_branch_info", summary: validation.errorMessage, errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }
  const root = validation.root;

  _emitLog("GIT_OPERATION_STARTED", root, "git_branch_info");

  // Get all local branches with current marker
  const branchRun = await runGit(["branch", "--format=%(refname:short)%(HEAD)"], root, signal);
  if (branchRun.cancelled) return _cancelledResult("git_branch_info", root);
  if (branchRun.spawnFailed) return _failedResult("git_branch_info", root, "GIT_NOT_AVAILABLE", branchRun.spawnFailed);

  let current: string | null = null;
  const branches: string[] = [];

  for (const line of branchRun.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith("*")) {
      current = trimmed.slice(0, -1).trim();
      branches.push(current);
    } else {
      branches.push(trimmed);
    }
  }

  // Get status for ahead/behind
  const statusRun = await runGit(["status", "--porcelain=v1", "-b"], root, signal);
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (!statusRun.cancelled && statusRun.exitCode === 0) {
    const parsed = parseGitStatus(statusRun.stdout);
    upstream = parsed.upstream;
    ahead = parsed.ahead;
    behind = parsed.behind;
    if (current === null) current = parsed.branch;
  }

  _emitLog("GIT_OPERATION_COMPLETED", root, "git_branch_info");

  return {
    ok: true,
    operation: "git_branch_info",
    repositoryRoot: root,
    ...(current !== null ? { branch: current } : {}),
    data: { current, branches, upstream, ahead, behind },
    summary: `On branch ${current ?? "(detached HEAD)"}, ${branches.length} local branches`,
  };
}

/**
 * git_stage — Stage specific paths (no wildcards, no add-all).
 */
export async function gitStage(
  projectRoot: string,
  relativePaths: string[],
  signal?: AbortSignal
): Promise<GitResult<{ stagedPaths: string[] }>> {
  const validation = resolveAndValidateRoot(projectRoot);
  if (!validation.ok) {
    return { ok: false, operation: "git_stage", summary: validation.errorMessage, errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }
  const root = validation.root;

  if (!relativePaths || relativePaths.length === 0) {
    return _failedResult("git_stage", root, "INVALID_PATH", "No paths supplied to stage");
  }

  // Validate all paths before touching the repo
  const escaping = validatePathsInsideRoot(relativePaths, root);
  if (escaping) {
    assertInvariant("GIT_OPERATION_OUTSIDE_PROJECT", false, { escaping, root });
    return _failedResult("git_stage", root, "PATH_OUTSIDE_PROJECT", `Path escapes project: ${escaping}`);
  }

  _emitLog("GIT_OPERATION_STARTED", root, "git_stage");

  // Check for conflicts first
  const statusRun = await runGit(["status", "--porcelain=v1", "-b", "-u"], root, signal);
  if (statusRun.cancelled) return _cancelledResult("git_stage", root);
  const statusParsed = parseGitStatus(statusRun.stdout);

  if (statusParsed.conflicts.length > 0) {
    assertInvariant("GIT_COMMIT_WITH_NO_STAGED_CHANGES", false, { conflicts: statusParsed.conflicts.length });
    return _failedResult("git_stage", root, "MERGE_CONFLICT_PRESENT", `Cannot stage: ${statusParsed.conflicts.length} unresolved conflicts exist`);
  }

  // git add -- path1 path2 ...
  const addRun = await runGit(["add", "--", ...relativePaths], root, signal);
  if (addRun.cancelled) return _cancelledResult("git_stage", root);
  if (addRun.spawnFailed) return _failedResult("git_stage", root, "GIT_NOT_AVAILABLE", addRun.spawnFailed);
  if (addRun.exitCode !== 0) {
    return _failedResult("git_stage", root, "COMMAND_FAILED", addRun.stderr.slice(0, 500));
  }

  _emitLog("GIT_OPERATION_COMPLETED", root, "git_stage");

  return {
    ok: true,
    operation: "git_stage",
    repositoryRoot: root,
    data: { stagedPaths: relativePaths },
    summary: `Staged ${relativePaths.length} path(s): ${relativePaths.join(", ")}`,
  };
}

/**
 * git_unstage — Unstage specific paths (non-destructive — preserves working tree).
 */
export async function gitUnstage(
  projectRoot: string,
  relativePaths: string[],
  signal?: AbortSignal
): Promise<GitResult<{ unstaggedPaths: string[] }>> {
  const validation = resolveAndValidateRoot(projectRoot);
  if (!validation.ok) {
    return { ok: false, operation: "git_unstage", summary: validation.errorMessage, errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }
  const root = validation.root;

  if (!relativePaths || relativePaths.length === 0) {
    return _failedResult("git_unstage", root, "INVALID_PATH", "No paths supplied to unstage");
  }

  const escaping = validatePathsInsideRoot(relativePaths, root);
  if (escaping) {
    assertInvariant("GIT_OPERATION_OUTSIDE_PROJECT", false, { escaping, root });
    return _failedResult("git_unstage", root, "PATH_OUTSIDE_PROJECT", `Path escapes project: ${escaping}`);
  }

  _emitLog("GIT_OPERATION_STARTED", root, "git_unstage");

  // Use "git restore --staged --" which is non-destructive (working tree unchanged)
  // Falls back to "git reset HEAD --" for older git versions
  const restoreRun = await runGit(["restore", "--staged", "--", ...relativePaths], root, signal);
  if (restoreRun.cancelled) return _cancelledResult("git_unstage", root);

  // If restore failed (older git), try reset
  if (restoreRun.exitCode !== 0 && !restoreRun.spawnFailed) {
    const resetRun = await runGit(["reset", "HEAD", "--", ...relativePaths], root, signal);
    if (resetRun.cancelled) return _cancelledResult("git_unstage", root);
    if (resetRun.exitCode !== 0) {
      return _failedResult("git_unstage", root, "COMMAND_FAILED", resetRun.stderr.slice(0, 500));
    }
  } else if (restoreRun.spawnFailed) {
    return _failedResult("git_unstage", root, "GIT_NOT_AVAILABLE", restoreRun.spawnFailed);
  }

  _emitLog("GIT_OPERATION_COMPLETED", root, "git_unstage");

  return {
    ok: true,
    operation: "git_unstage",
    repositoryRoot: root,
    data: { unstaggedPaths: relativePaths },
    summary: `Unstaged ${relativePaths.length} path(s): ${relativePaths.join(", ")}`,
  };
}

/**
 * git_commit — Create a commit from already-staged changes.
 * Does NOT implicitly stage anything. Does NOT use -a.
 */
export async function gitCommit(
  projectRoot: string,
  message: string,
  signal?: AbortSignal
): Promise<GitResult<GitCommitResult>> {
  if (!isValidCommitMessage(message)) {
    return {
      ok: false,
      operation: "git_commit",
      summary: "Invalid commit message",
      errorCode: "INVALID_COMMIT_MESSAGE",
      errorMessage: "Commit message must be between 3 and 5000 characters",
    };
  }

  const validation = resolveAndValidateRoot(projectRoot);
  if (!validation.ok) {
    return { ok: false, operation: "git_commit", summary: validation.errorMessage, errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }
  const root = validation.root;

  _emitLog("GIT_OPERATION_STARTED", root, "git_commit");

  // Pre-flight: check for conflicts and staged changes
  const statusRun = await runGit(["status", "--porcelain=v1", "-b", "-u"], root, signal);
  if (statusRun.cancelled) return _cancelledResult("git_commit", root);
  if (statusRun.spawnFailed) return _failedResult("git_commit", root, "GIT_NOT_AVAILABLE", statusRun.spawnFailed);

  const status = parseGitStatus(statusRun.stdout);

  if (status.conflicts.length > 0) {
    assertInvariant("GIT_COMMIT_WITH_NO_STAGED_CHANGES", false, { reason: "conflicts", count: status.conflicts.length });
    return _failedResult("git_commit", root, "MERGE_CONFLICT_PRESENT", `Cannot commit: ${status.conflicts.length} unresolved conflicts`);
  }

  if (status.staged.length === 0 && !status.isInitialCommit) {
    assertInvariant("GIT_COMMIT_WITH_NO_STAGED_CHANGES", false, { reason: "nothing_staged" });
    return _failedResult("git_commit", root, "NO_STAGED_CHANGES", "No staged changes to commit");
  }

  // Commit — explicit message only, no -a flag
  const commitRun = await runGit(["commit", "-m", message], root, signal);
  if (commitRun.cancelled) return _cancelledResult("git_commit", root);
  if (commitRun.spawnFailed) return _failedResult("git_commit", root, "GIT_NOT_AVAILABLE", commitRun.spawnFailed);
  if (commitRun.exitCode !== 0) {
    return _failedResult("git_commit", root, "COMMAND_FAILED", commitRun.stderr.slice(0, 500));
  }

  // Get hash of new commit
  const hashRun = await runGit(["rev-parse", "HEAD"], root, signal);
  const hashFull = hashRun.exitCode === 0 ? hashRun.stdout.trim() : "";
  const shortRun = await runGit(["rev-parse", "--short", "HEAD"], root, signal);
  const hashShort = shortRun.exitCode === 0 ? shortRun.stdout.trim() : hashFull.slice(0, 7);

  forgeLogger.info("tool", `GIT_COMMIT_CREATED: ${hashShort} — ${message.slice(0, 80)}`, { metadata: { hash: hashFull } });
  _emitLog("GIT_OPERATION_COMPLETED", root, "git_commit");

  return {
    ok: true,
    operation: "git_commit",
    repositoryRoot: root,
    ...(hashShort ? { head: hashShort } : {}),
    data: {
      hash: hashFull,
      shortHash: hashShort,
      branch: status.branch ?? "(detached)",
      summary: `Committed: ${hashShort} — ${message.slice(0, 80)}`,
    },
    summary: `Committed: ${hashShort} — ${message.slice(0, 80)}`,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _emitLog(event: string, root: string, operation: string): void {
  forgeLogger.debug("tool", `${event}: ${operation}`, { metadata: { repositoryRoot: root, operation } });
}

function _cancelledResult(operation: string, root?: string): GitResult<never> {
  _emitLog("GIT_OPERATION_CANCELLED", root ?? "", operation);
  return {
    ok: false,
    operation,
    ...(root ? { repositoryRoot: root } : {}),
    summary: `Git operation cancelled`,
    errorCode: "CANCELLED",
    errorMessage: "Operation was cancelled",
  };
}

function _failedResult(
  operation: string,
  root: string,
  errorCode: GitErrorCode,
  errorMessage: string
): GitResult<never> {
  _emitLog("GIT_OPERATION_FAILED", root, operation);
  forgeLogger.warn("tool", `GIT_OPERATION_FAILED: ${operation} — ${errorCode}: ${errorMessage}`, { metadata: { operation, errorCode } });
  return {
    ok: false,
    operation,
    repositoryRoot: root,
    summary: `Git ${operation} failed: ${errorCode}`,
    errorCode,
    errorMessage,
  };
}