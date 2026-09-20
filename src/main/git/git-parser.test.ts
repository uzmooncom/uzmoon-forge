/**
 * git-parser.test.ts — Unit tests for git porcelain output parsers.
 *
 * Pure functions — no process spawning, no filesystem access.
 */
import { describe, it, expect } from "vitest";
import {
  parseGitStatus,
  parseGitLog,
  buildLogFormat,
  parseGitDiffStat,
  isValidCommitish,
  isValidCommitMessage,
  isValidStagingPath,
} from "./git-parser.js";

// ── parseGitStatus ──────────────────────────────────────────────────────────

describe("parseGitStatus", () => {
  it("parses clean repository", () => {
    const raw = "## main...origin/main\n";
    const result = parseGitStatus(raw);
    expect(result.branch).toBe("main");
    expect(result.upstream).toBe("origin/main");
    expect(result.isClean).toBe(true);
    expect(result.staged).toHaveLength(0);
    expect(result.unstaged).toHaveLength(0);
    expect(result.untracked).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.isDetachedHead).toBe(false);
    expect(result.isInitialCommit).toBe(false);
  });

  it("parses ahead/behind from branch header", () => {
    const raw = "## main...origin/main [ahead 2, behind 3]\n";
    const result = parseGitStatus(raw);
    expect(result.branch).toBe("main");
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(3);
  });

  it("parses ahead only", () => {
    const raw = "## feat/foo...origin/feat/foo [ahead 1]\n";
    const result = parseGitStatus(raw);
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(0);
  });

  it("parses detached HEAD", () => {
    const raw = "## HEAD (no branch)\n";
    const result = parseGitStatus(raw);
    expect(result.isDetachedHead).toBe(true);
    expect(result.branch).toBe(null);
  });

  it("parses initial commit (unborn branch)", () => {
    const raw = "## No commits yet on main\n";
    const result = parseGitStatus(raw);
    expect(result.isInitialCommit).toBe(true);
    expect(result.branch).toBe("main");
  });

  it("parses staged modification", () => {
    const raw = "## main\nM  src/foo.ts\n";
    const result = parseGitStatus(raw);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]!.path).toBe("src/foo.ts");
    expect(result.staged[0]!.xy).toBe("M ");
    expect(result.unstaged).toHaveLength(0);
  });

  it("parses unstaged modification", () => {
    const raw = "## main\n M src/bar.ts\n";
    const result = parseGitStatus(raw);
    expect(result.unstaged).toHaveLength(1);
    expect(result.unstaged[0]!.path).toBe("src/bar.ts");
    expect(result.staged).toHaveLength(0);
  });

  it("parses both staged and unstaged on same file", () => {
    const raw = "## main\nMM src/baz.ts\n";
    const result = parseGitStatus(raw);
    expect(result.staged).toHaveLength(1);
    expect(result.unstaged).toHaveLength(1);
    expect(result.staged[0]!.path).toBe("src/baz.ts");
    expect(result.unstaged[0]!.path).toBe("src/baz.ts");
  });

  it("parses untracked files", () => {
    const raw = "## main\n?? new-file.ts\n?? another.ts\n";
    const result = parseGitStatus(raw);
    expect(result.untracked).toHaveLength(2);
    expect(result.untracked[0]!.path).toBe("new-file.ts");
    expect(result.untracked[1]!.path).toBe("another.ts");
    expect(result.isClean).toBe(false);
  });

  it("parses conflicts (UU)", () => {
    const raw = "## main\nUU src/conflict.ts\n";
    const result = parseGitStatus(raw);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.xy).toBe("UU");
    expect(result.isClean).toBe(false);
  });

  it("parses conflicts (AA)", () => {
    const raw = "## main\nAA src/added-both.ts\n";
    const result = parseGitStatus(raw);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.xy).toBe("AA");
  });

  it("parses renamed file (staged)", () => {
    const raw = "## main\nR  new-name.ts -> old-name.ts\n";
    const result = parseGitStatus(raw);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]!.path).toBe("new-name.ts");
    expect(result.staged[0]!.origPath).toBe("old-name.ts");
  });

  it("parses added staged file", () => {
    const raw = "## main\nA  new-file.ts\n";
    const result = parseGitStatus(raw);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]!.xy).toBe("A ");
    expect(result.isClean).toBe(false);
  });

  it("parses deleted staged file", () => {
    const raw = "## main\nD  deleted.ts\n";
    const result = parseGitStatus(raw);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]!.xy).toBe("D ");
  });

  it("mixed output - multiple file states", () => {
    const raw = [
      "## main...origin/main [ahead 1]",
      "M  src/staged.ts",
      " M src/unstaged.ts",
      "?? src/new.ts",
      "D  src/deleted.ts",
    ].join("\n") + "\n";

    const result = parseGitStatus(raw);
    expect(result.branch).toBe("main");
    expect(result.ahead).toBe(1);
    expect(result.staged).toHaveLength(2); // M  and D  
    expect(result.unstaged).toHaveLength(1);
    expect(result.untracked).toHaveLength(1);
    expect(result.isClean).toBe(false);
  });

  it("branch with no upstream", () => {
    const raw = "## feature/new-feature\n";
    const result = parseGitStatus(raw);
    expect(result.branch).toBe("feature/new-feature");
    expect(result.upstream).toBe(null);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });

  it("empty input", () => {
    const result = parseGitStatus("");
    expect(result.isClean).toBe(true);
    expect(result.branch).toBe(null);
  });
});

// ── parseGitLog ─────────────────────────────────────────────────────────────

describe("parseGitLog", () => {
  const SEP = "\x1F";

  it("parses single log entry", () => {
    const hash = "abc1234def5678901234567890123456789012345";
    const short = "abc1234";
    const author = "Jane Doe";
    const email = "jane@example.com";
    const date = "2024-01-15T10:30:00+00:00";
    const subject = "Add login validation";

    const raw = [hash, short, author, email, date, subject].join(SEP) + "\n";
    const entries = parseGitLog(raw);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe(hash);
    expect(entries[0]!.shortHash).toBe(short);
    expect(entries[0]!.author).toBe(author);
    expect(entries[0]!.authorEmail).toBe(email);
    expect(entries[0]!.date).toBe(date);
    expect(entries[0]!.subject).toBe(subject);
  });

  it("parses multiple entries", () => {
    const SEP = "\x1F";
    const line1 = ["aaa", "aaa0001", "Alice", "a@a.com", "2024-01-01", "First commit"].join(SEP);
    const line2 = ["bbb", "bbb0002", "Bob", "b@b.com", "2024-01-02", "Second commit"].join(SEP);
    const entries = parseGitLog(line1 + "\n" + line2 + "\n");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.subject).toBe("First commit");
    expect(entries[1]!.subject).toBe("Second commit");
  });

  it("returns empty for no separator lines", () => {
    expect(parseGitLog("abc\ndef\n")).toHaveLength(0);
    expect(parseGitLog("")).toHaveLength(0);
  });

  it("skips incomplete lines (< 6 parts)", () => {
    const SEP = "\x1F";
    const incomplete = ["aaa", "short", "author"].join(SEP);
    expect(parseGitLog(incomplete + "\n")).toHaveLength(0);
  });

  it("buildLogFormat returns expected separator pattern", () => {
    const fmt = buildLogFormat();
    expect(fmt).toContain("\x1F");
    expect(fmt).toContain("%H");
    expect(fmt).toContain("%h");
    expect(fmt).toContain("%an");
    expect(fmt).toContain("%ae");
    expect(fmt).toContain("%aI");
    expect(fmt).toContain("%s");
  });
});

// ── parseGitDiffStat ─────────────────────────────────────────────────────────

describe("parseGitDiffStat", () => {
  it("parses single file stat", () => {
    const raw = " src/foo.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)\n";
    const result = parseGitDiffStat(raw);
    expect(result.files).toContain("src/foo.ts");
    expect(result.additions).toBe(3);
    expect(result.deletions).toBe(2);
  });

  it("parses multiple files", () => {
    const raw = [
      " src/a.ts | 10 +++++-----",
      " src/b.ts |  2 +-",
      " 2 files changed, 6 insertions(+), 6 deletions(-)",
    ].join("\n") + "\n";
    const result = parseGitDiffStat(raw);
    expect(result.files).toHaveLength(2);
    expect(result.additions).toBe(6);
    expect(result.deletions).toBe(6);
  });

  it("handles insertions only", () => {
    const raw = " new.ts | 20 ++++++++++++++++++++\n 1 file changed, 20 insertions(+)\n";
    const result = parseGitDiffStat(raw);
    expect(result.additions).toBe(20);
    expect(result.deletions).toBe(0);
  });

  it("handles deletions only", () => {
    const raw = " old.ts | 5 -----\n 1 file changed, 5 deletions(-)\n";
    const result = parseGitDiffStat(raw);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(5);
  });

  it("handles empty diff", () => {
    const result = parseGitDiffStat("");
    expect(result.files).toHaveLength(0);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });
});

// ── isValidCommitish ─────────────────────────────────────────────────────────

describe("isValidCommitish", () => {
  it("accepts full sha", () => {
    expect(isValidCommitish("abc1234def5678901234567890123456789012345")).toBe(true);
  });

  it("accepts short sha", () => {
    expect(isValidCommitish("abc1234")).toBe(true);
  });

  it("accepts HEAD", () => {
    expect(isValidCommitish("HEAD")).toBe(true);
  });

  it("accepts HEAD~1", () => {
    expect(isValidCommitish("HEAD~1")).toBe(true);
  });

  it("accepts HEAD^", () => {
    expect(isValidCommitish("HEAD^")).toBe(true);
  });

  it("accepts HEAD~3", () => {
    expect(isValidCommitish("HEAD~3")).toBe(true);
  });

  it("accepts branch name", () => {
    expect(isValidCommitish("main")).toBe(true);
    expect(isValidCommitish("feat/new-feature")).toBe(true);
  });

  it("accepts tag", () => {
    expect(isValidCommitish("v1.2.3")).toBe(true);
  });

  it("accepts A..B range", () => {
    expect(isValidCommitish("HEAD..main")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidCommitish("")).toBe(false);
  });

  it("rejects whitespace", () => {
    expect(isValidCommitish("abc 123")).toBe(false);
    expect(isValidCommitish("abc\t123")).toBe(false);
  });

  it("rejects shell metacharacters", () => {
    expect(isValidCommitish("abc;rm -rf /")).toBe(false);
    expect(isValidCommitish("abc|cat /etc/passwd")).toBe(false);
    expect(isValidCommitish("abc&&evil")).toBe(false);
    expect(isValidCommitish("$(evil)")).toBe(false);
    expect(isValidCommitish("`evil`")).toBe(false);
  });

  it("rejects flag injection", () => {
    expect(isValidCommitish("--force")).toBe(false);
    expect(isValidCommitish("-a")).toBe(false);
  });

  it("rejects very long strings", () => {
    expect(isValidCommitish("a".repeat(201))).toBe(false);
  });
});

// ── isValidCommitMessage ────────────────────────────────────────────────────

describe("isValidCommitMessage", () => {
  it("accepts valid short message", () => {
    expect(isValidCommitMessage("Add feature")).toBe(true);
  });

  it("accepts valid multiline message", () => {
    expect(isValidCommitMessage("Add feature\n\nThis adds a new feature.")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidCommitMessage("")).toBe(false);
  });

  it("rejects too-short message", () => {
    expect(isValidCommitMessage("ab")).toBe(false);
    expect(isValidCommitMessage("  ")).toBe(false);
  });

  it("rejects too-long message", () => {
    expect(isValidCommitMessage("a".repeat(5001))).toBe(false);
  });

  it("rejects message with null bytes", () => {
    expect(isValidCommitMessage("good\0message")).toBe(false);
  });

  it("accepts exactly 3 chars", () => {
    expect(isValidCommitMessage("abc")).toBe(true);
  });

  it("rejects non-string", () => {
    expect(isValidCommitMessage(null as unknown as string)).toBe(false);
    expect(isValidCommitMessage(undefined as unknown as string)).toBe(false);
  });
});

// ── isValidStagingPath ────────────────────────────────────────────────────────

describe("isValidStagingPath", () => {
  it("accepts relative path", () => {
    expect(isValidStagingPath("src/foo.ts")).toBe(true);
  });

  it("accepts simple filename", () => {
    expect(isValidStagingPath("README.md")).toBe(true);
  });

  it("accepts nested path", () => {
    expect(isValidStagingPath("src/main/bar/baz.ts")).toBe(true);
  });

  it("rejects absolute path (unix)", () => {
    expect(isValidStagingPath("/etc/passwd")).toBe(false);
  });

  it("rejects absolute path (windows)", () => {
    expect(isValidStagingPath("C:\\Windows\\System32")).toBe(false);
    expect(isValidStagingPath("C:/Windows")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidStagingPath("../escape.ts")).toBe(false);
    expect(isValidStagingPath("src/../../etc/passwd")).toBe(false);
    expect(isValidStagingPath("..")).toBe(false);
  });

  it("rejects shell metacharacters", () => {
    expect(isValidStagingPath("src/foo;rm -rf /")).toBe(false);
    expect(isValidStagingPath("src/*.ts")).toBe(false);
    expect(isValidStagingPath("src/foo?")).toBe(false);
    expect(isValidStagingPath("src/$(evil)")).toBe(false);
  });

  it("rejects null bytes", () => {
    expect(isValidStagingPath("src/foo\0.ts")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidStagingPath("")).toBe(false);
    expect(isValidStagingPath("   ")).toBe(false);
  });

  it("accepts path with hyphens and underscores", () => {
    expect(isValidStagingPath("src/my-module/some_file.ts")).toBe(true);
  });
});