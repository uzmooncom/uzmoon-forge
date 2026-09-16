import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import {
  extractProposalFence,
  stripProposalFence,
  parseProposalJson,
  resolveContextRef,
  verifyBaseSnapshot,
  computeCurrentHash,
  isEditEligible,
  writeFileAtomicWithProject,
  createBackupSnapshot,
  restoreFromBackup,
  readProposalTarget,
  captureProposalTarget,
  preflightFileEdits,
  computeProposalStatus,
  computeDiffStats,
  sweepWriteJournal,
} from "./edit-service.js";
import type { ContextRef, FileEdit, EditProposal } from "../../shared/types.js";

// ── DB mock ────────────────────────────────────────────────────────────────

vi.mock("../database/db.js", () => {
  let dataDir = "";
  let journal: Record<string, import("../../shared/types.js").WriteJournalEntry> = {};
  let projects: Record<string, import("../../shared/types.js").Project> = {};
  return {
    getDataDir: () => dataDir,
    addWriteJournalEntry: (_: true, entry: import("../../shared/types.js").WriteJournalEntry) => { journal[entry.id] = entry; },
    removeWriteJournalEntry: (_: true, id: string) => { delete journal[id]; },
    listWriteJournalEntries: (_: true) => Object.values(journal),
    getProject: (_: true, id: string) => projects[id] ?? null,
    // helpers for tests
    __setDataDir: (d: string) => { dataDir = d; },
    __setProjects: (p: Record<string, unknown>) => { projects = p as Record<string, import("../../shared/types.js").Project>; },
    __getJournal: () => journal,
    __clearJournal: () => { journal = {}; },
  };
});

// ── eligibility mock ───────────────────────────────────────────────────────

vi.mock("./eligibility.js", () => ({
  resolveProjectPath: (root: string, rel: string) => {
    if (rel.includes("..")) return null;
    return path.join(root, rel);
  },
  checkEligibility: (_root: string, absPath: string, _rel: string) => {
    if (absPath.includes(".env") || absPath.includes(".pem")) return { status: "sensitive" };
    if (absPath.endsWith(".png") || absPath.endsWith(".bin")) return { status: "binary" };
    if (!fs.existsSync(absPath)) return { status: "missing" };
    return { status: "ok", language: "typescript", sizeBytes: 100 };
  },
}));

// ── Setup ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let dataDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-edit-test-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const db = await import("../database/db.js");
  (db as unknown as { __setDataDir: (d: string) => void }).__setDataDir(dataDir);
  (db as unknown as { __clearJournal: () => void }).__clearJournal();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── extractProposalFence ───────────────────────────────────────────────────

describe("extractProposalFence", () => {
  it("extracts JSON from fence block", () => {
    const text = `Here is the edit:\n\`\`\`forge_edit_proposal\n{"summary":"fix bug","files":[]}\n\`\`\`\nDone.`;
    expect(extractProposalFence(text)).toBe('{"summary":"fix bug","files":[]}');
  });

  it("returns null when no fence present", () => {
    expect(extractProposalFence("just regular text")).toBeNull();
  });

  it("only extracts first fence", () => {
    const text = "```forge_edit_proposal\n{\"summary\":\"a\",\"files\":[]}\n```\n```forge_edit_proposal\n{\"summary\":\"b\",\"files\":[]}\n```";
    const result = extractProposalFence(text);
    expect(result).toContain('"summary":"a"');
    expect(result).not.toContain('"summary":"b"');
  });
});

// ── stripProposalFence ─────────────────────────────────────────────────────

describe("stripProposalFence", () => {
  it("strips the fence block from text", () => {
    const text = "Here is the plan.\n```forge_edit_proposal\n{\"summary\":\"fix\"}\n```\nApplied.";
    const result = stripProposalFence(text);
    expect(result).not.toContain("forge_edit_proposal");
    expect(result).toContain("Here is the plan.");
    expect(result).toContain("Applied.");
  });

  it("returns original text unchanged if no fence", () => {
    const text = "No fence here.";
    expect(stripProposalFence(text)).toBe(text);
  });
});

// ── parseProposalJson ──────────────────────────────────────────────────────

describe("parseProposalJson", () => {
  it("parses valid proposal JSON", () => {
    const raw = JSON.stringify({
      type: "modify",
      summary: "Fix auth bug",
      explanation: "The token check was inverted",
      files: [{ path: "src/auth.ts", content: "export function check() { return true; }" }],
    });
    const result = parseProposalJson(raw);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Fix auth bug");
    expect(result!.explanation).toBe("The token check was inverted");
    expect(result!.files).toHaveLength(1);
    expect(result!.files[0]!.path).toBe("src/auth.ts");
  });

  it("returns null for invalid JSON", () => {
    expect(parseProposalJson("not json")).toBeNull();
  });

  it("returns null when files is empty after filtering", () => {
    const raw = JSON.stringify({ summary: "x", files: [] });
    expect(parseProposalJson(raw)).toBeNull();
  });

  it("returns null when summary is missing", () => {
    const raw = JSON.stringify({ files: [{ path: "a.ts", content: "x" }] });
    expect(parseProposalJson(raw)).toBeNull();
  });

  it("normalizes path: strips leading slashes", () => {
    const raw = JSON.stringify({
      summary: "s",
      files: [{ path: "/src/auth.ts", content: "x" }],
    });
    const result = parseProposalJson(raw);
    expect(result!.files[0]!.path).toBe("src/auth.ts");
  });

  it("skips files whose content exceeds MAX_CONTEXT_BYTES", () => {
    const bigContent = "x".repeat(600 * 1024); // 600 KB
    const raw = JSON.stringify({
      summary: "s",
      files: [{ path: "big.ts", content: bigContent }, { path: "small.ts", content: "ok" }],
    });
    const result = parseProposalJson(raw);
    expect(result).not.toBeNull();
    expect(result!.files).toHaveLength(1);
    expect(result!.files[0]!.path).toBe("small.ts");
  });
});

// ── resolveContextRef ──────────────────────────────────────────────────────

function makeRef(overrides: Partial<ContextRef> = {}): ContextRef {
  return {
    id: "ref-1",
    projectId: "proj-1",
    relativePath: "src/auth.ts",
    snapshotPath: "/tmp/snap.txt",
    contentHash: "abc123",
    capturedAt: Date.now(),
    size: 100,
    language: "typescript",
    ...overrides,
  };
}

describe("resolveContextRef", () => {
  it("returns ok when exactly one full-file ref matches", () => {
    const ref = makeRef();
    const result = resolveContextRef([ref], "proj-1", "src/auth.ts");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.ref).toBe(ref);
  });

  it("returns needs_context when no refs match", () => {
    expect(resolveContextRef([], "proj-1", "src/auth.ts").status).toBe("needs_context");
  });

  it("returns needs_context when projectId does not match", () => {
    const ref = makeRef({ projectId: "other-proj" });
    expect(resolveContextRef([ref], "proj-1", "src/auth.ts").status).toBe("needs_context");
  });

  it("returns needs_context when relativePath does not match", () => {
    const ref = makeRef({ relativePath: "src/other.ts" });
    expect(resolveContextRef([ref], "proj-1", "src/auth.ts").status).toBe("needs_context");
  });

  it("returns needs_context when lineStart is set (not full-file)", () => {
    const ref = makeRef({ lineStart: 1, lineEnd: 10 });
    expect(resolveContextRef([ref], "proj-1", "src/auth.ts").status).toBe("needs_context");
  });

  it("returns needs_context when contentHash is empty", () => {
    const ref = makeRef({ contentHash: "" });
    expect(resolveContextRef([ref], "proj-1", "src/auth.ts").status).toBe("needs_context");
  });

  it("returns ambiguous_context when two refs match", () => {
    const ref1 = makeRef({ id: "r1" });
    const ref2 = makeRef({ id: "r2" });
    expect(resolveContextRef([ref1, ref2], "proj-1", "src/auth.ts").status).toBe("ambiguous_context");
  });

  it("normalizes path separators", () => {
    const ref = makeRef({ relativePath: "src\\auth.ts" });
    expect(resolveContextRef([ref], "proj-1", "src/auth.ts").status).toBe("ok");
  });
});

// ── verifyBaseSnapshot ─────────────────────────────────────────────────────

describe("verifyBaseSnapshot", () => {
  it("returns ok when hash matches", () => {
    const content = "export const x = 1;";
    const snapshotPath = path.join(tmpDir, "snap.txt");
    fs.writeFileSync(snapshotPath, content, "utf8");
    // Compute expected hash
    const hash = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
    const ref = makeRef({ snapshotPath, contentHash: hash });
    const result = verifyBaseSnapshot(ref);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verifiedHash).toBe(hash);
  });

  it("returns failed when hash mismatches", () => {
    const snapshotPath = path.join(tmpDir, "snap2.txt");
    fs.writeFileSync(snapshotPath, "tampered content", "utf8");
    const ref = makeRef({ snapshotPath, contentHash: "wrong-hash" });
    const result = verifyBaseSnapshot(ref);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("failed");
  });

  it("returns needs_context when snapshot file is missing", () => {
    const ref = makeRef({ snapshotPath: "/nonexistent/path.txt" });
    const result = verifyBaseSnapshot(ref);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("needs_context");
  });
});

// ── computeCurrentHash ─────────────────────────────────────────────────────

describe("computeCurrentHash", () => {
  it("reads file and returns hash and content", () => {
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;", "utf8");
    const result = computeCurrentHash(tmpDir, "test.ts");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("const x = 1;");
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("returns error for missing file", () => {
    const result = computeCurrentHash(tmpDir, "missing.ts");
    expect(result.ok).toBe(false);
  });

  it("returns error on path traversal", () => {
    const result = computeCurrentHash(tmpDir, "../../../etc/passwd");
    expect(result.ok).toBe(false);
  });
});

// ── isEditEligible ─────────────────────────────────────────────────────────

describe("isEditEligible", () => {
  it("returns ok for a valid ts file", () => {
    const filePath = path.join(tmpDir, "valid.ts");
    fs.writeFileSync(filePath, "export {}");
    expect(isEditEligible(tmpDir, "valid.ts").ok).toBe(true);
  });

  it("returns error for .env files", () => {
    const result = isEditEligible(tmpDir, ".env");
    expect(result.ok).toBe(false);
  });

  it("returns error for binary files", () => {
    const result = isEditEligible(tmpDir, "image.png");
    expect(result.ok).toBe(false);
  });

  it("returns error on path traversal", () => {
    const result = isEditEligible(tmpDir, "../../secret");
    expect(result.ok).toBe(false);
  });
});

// ── captureProposalTarget + readProposalTarget ─────────────────────────────

describe("captureProposalTarget / readProposalTarget", () => {
  it("writes proposal resource and returns hash", () => {
    const result = captureProposalTarget("prop-1", "fe-1", "export const x = 1;");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(result.resourcePath)).toBe(true);
    }
  });

  it("reads back the written content", () => {
    const content = "export const foo = 42;";
    const capResult = captureProposalTarget("prop-2", "fe-2", content);
    expect(capResult.ok).toBe(true);
    if (capResult.ok) {
      const readBack = readProposalTarget(capResult.resourcePath);
      expect(readBack).toBe(content);
    }
  });

  it("readProposalTarget returns null for path outside dataDir", () => {
    const result = readProposalTarget("/etc/passwd");
    expect(result).toBeNull();
  });
});

// ── writeFileAtomicWithProject ─────────────────────────────────────────────

describe("writeFileAtomicWithProject", () => {
  it("writes content atomically and verifies hash", () => {
    const content = "const answer = 42;";
    const targetPath = path.join(tmpDir, "src", "answer.ts");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "old content");

    const hash = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

    const result = writeFileAtomicWithProject(tmpDir, "proj-1", "src/answer.ts", content, hash);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actualHash).toBe(hash);
      expect(fs.readFileSync(targetPath, "utf8")).toBe(content);
    }
  });

  it("rejects mismatched reviewedTargetHash", () => {
    const content = "const x = 1;";
    const result = writeFileAtomicWithProject(tmpDir, "proj-1", "src/x.ts", content, "wrong-hash");
    expect(result.ok).toBe(false);
  });

  it("rejects path traversal", () => {
    const result = writeFileAtomicWithProject(tmpDir, "proj-1", "../../etc/passwd", "x", "x");
    expect(result.ok).toBe(false);
  });

  it("cleans up journal entry on success", async () => {
    const db = await import("../database/db.js");
    const content = "const a = 1;";
    const targetPath = path.join(tmpDir, "a.ts");
    fs.writeFileSync(targetPath, "old");
    const hash = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
    const result = writeFileAtomicWithProject(tmpDir, "proj-1", "a.ts", content, hash);
    expect(result.ok).toBe(true);
    // Journal should be empty after successful write
    const journal = (db as unknown as { __getJournal: () => Record<string, unknown> }).__getJournal();
    expect(Object.keys(journal)).toHaveLength(0);
  });
});

// ── createBackupSnapshot + restoreFromBackup ───────────────────────────────

describe("createBackupSnapshot / restoreFromBackup", () => {
  it("creates backup and restores it", () => {
    const originalContent = "original content";
    const targetPath = path.join(tmpDir, "target.ts");
    fs.writeFileSync(targetPath, originalContent);

    const backupResult = createBackupSnapshot("ae-1", targetPath);
    expect(backupResult.ok).toBe(true);
    if (!backupResult.ok) return;

    // Overwrite the file
    fs.writeFileSync(targetPath, "modified content");

    // Restore
    const restoreResult = restoreFromBackup(
      tmpDir,
      "proj-1",
      "target.ts",
      backupResult.backupPath,
      backupResult.contentHash,
      undefined // no stale-undo guard for this test (file was manually overwritten)
    );
    expect(restoreResult.ok).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(originalContent);
  });

  it("restoreFromBackup rejects tampered backup", () => {
    const targetPath = path.join(tmpDir, "f.ts");
    fs.writeFileSync(targetPath, "content");
    const backupResult = createBackupSnapshot("ae-2", targetPath);
    expect(backupResult.ok).toBe(true);
    if (!backupResult.ok) return;
    const result = restoreFromBackup(tmpDir, "proj-1", "f.ts", backupResult.backupPath, "wrong-hash", undefined);
    expect(result.ok).toBe(false);
  });
});

// ── computeDiffStats ───────────────────────────────────────────────────────

describe("computeDiffStats", () => {
  it("detects added and removed lines", () => {
    const base = "line1\nline2\nline3";
    const proposed = "line1\nnewline\nline3";
    const stats = computeDiffStats(base, proposed);
    expect(stats.linesAdded).toBeGreaterThan(0);
    expect(stats.linesRemoved).toBeGreaterThan(0);
  });

  it("returns zero changes for identical content", () => {
    const content = "line1\nline2\nline3";
    const stats = computeDiffStats(content, content);
    expect(stats.linesAdded).toBe(0);
    expect(stats.linesRemoved).toBe(0);
    expect(stats.linesUnchanged).toBeGreaterThan(0);
  });

  it("handles empty base (all lines added)", () => {
    const stats = computeDiffStats("", "new line");
    expect(stats.linesAdded).toBeGreaterThan(0);
  });
});

// ── computeProposalStatus ──────────────────────────────────────────────────

function makeFileEdit(status: FileEdit["status"], id = "fe-1"): FileEdit {
  return {
    id,
    proposalId: "prop-1",
    relativePath: "src/a.ts",
    targetResourcePath: "/data/proposals/prop-1/fe-1.txt",
    targetContentHash: "abc",
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("computeProposalStatus", () => {
  it("returns applied when all edits applied", () => {
    expect(computeProposalStatus([makeFileEdit("applied")])).toBe("applied");
  });

  it("returns needs_context when any edit needs_context", () => {
    expect(computeProposalStatus([makeFileEdit("ready"), makeFileEdit("needs_context", "fe-2")])).toBe("needs_context");
  });

  it("returns ambiguous_context when any edit is ambiguous", () => {
    expect(computeProposalStatus([makeFileEdit("ambiguous_context")])).toBe("ambiguous_context");
  });

  it("returns ready when all edits are ready", () => {
    expect(computeProposalStatus([makeFileEdit("ready")])).toBe("ready");
  });

  it("returns rejected when all edits are rejected", () => {
    expect(computeProposalStatus([makeFileEdit("rejected")])).toBe("rejected");
  });

  it("returns failed for empty file edits", () => {
    expect(computeProposalStatus([])).toBe("failed");
  });

  it("returns partiallyApplied when some applied, some not", () => {
    expect(computeProposalStatus([makeFileEdit("applied"), makeFileEdit("ready", "fe-2")])).toBe("partiallyApplied");
  });
});

// ── preflightFileEdits ────────────────────────────────────────────────────

describe("preflightFileEdits", () => {
  function buildProposal(fes: FileEdit[]): EditProposal {
    return {
      id: "prop-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      projectId: "proj-1",
      status: "ready",
      summary: "Test proposal",
      rawProposalJson: "{}",
      fileEdits: fes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  it("returns ok=false for non-ready status", () => {
    const fe = makeFileEdit("needs_context");
    const proposal = buildProposal([fe]);
    const results = preflightFileEdits(tmpDir, proposal, [fe.id]);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.reason).toContain("needs_context");
  });

  it("returns ok=false for missing proposal target resource", () => {
    const fe: FileEdit = {
      ...makeFileEdit("ready"),
      targetResourcePath: "/nonexistent/path.txt",
      targetContentHash: "abc",
    };
    const proposal = buildProposal([fe]);
    const results = preflightFileEdits(tmpDir, proposal, [fe.id]);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.reason).toContain("missing");
  });

  it("returns ok=true when resource exists, hashes match, and no baseContentHash", () => {
    const content = "export const x = 1;";
    const capResult = captureProposalTarget("prop-1", "fe-1", content);
    expect(capResult.ok).toBe(true);
    if (!capResult.ok) return;

    const fe: FileEdit = {
      ...makeFileEdit("ready"),
      targetResourcePath: capResult.resourcePath,
      targetContentHash: capResult.contentHash,
    };
    const proposal = buildProposal([fe]);
    const results = preflightFileEdits(tmpDir, proposal, [fe.id]);
    expect(results[0]!.ok).toBe(true);
  });

  it("returns ok=false when file is stale (current hash != baseContentHash)", () => {
    const proposedContent = "export const x = 2;";
    const capResult = captureProposalTarget("prop-2", "fe-2", proposedContent);
    expect(capResult.ok).toBe(true);
    if (!capResult.ok) return;

    // Write original content to disk
    const targetPath = path.join(tmpDir, "stale.ts");
    fs.writeFileSync(targetPath, "export const x = 999; // different");

    const baseHash = createHash("sha256").update(Buffer.from("export const x = 1;", "utf8")).digest("hex");

    const fe: FileEdit = {
      ...makeFileEdit("ready"),
      id: "fe-2",
      proposalId: "prop-2",
      relativePath: "stale.ts",
      targetResourcePath: capResult.resourcePath,
      targetContentHash: capResult.contentHash,
      baseContentHash: baseHash,
    };
    const proposal = buildProposal([fe]);
    const results = preflightFileEdits(tmpDir, proposal, [fe.id]);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.reason).toContain("stale");
  });
});

// ── sweepWriteJournal ─────────────────────────────────────────────────────

describe("sweepWriteJournal", () => {
  it("deletes orphaned temp files from journal", async () => {
    const db = await import("../database/db.js");

    // Create a temp file that was left behind
    const projectRoot = tmpDir;
    const tempPath = path.join(projectRoot, "src", ".forge-tmp-deadbeef");
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
    fs.writeFileSync(tempPath, "orphan content");

    // Add journal entry
    const entry: import("../../shared/types.js").WriteJournalEntry = {
      id: "journal-1",
      projectId: "proj-1",
      tempRelativePath: "src/.forge-tmp-deadbeef",
      targetRelativePath: "src/target.ts",
      createdAt: Date.now(),
    };
    db.addWriteJournalEntry(true, entry);

    // Register a fake project
    (db as unknown as { __setProjects: (p: Record<string, unknown>) => void }).__setProjects({
      "proj-1": { id: "proj-1", displayName: "Test", workingDirectory: projectRoot, rootPath: projectRoot, createdAt: Date.now(), updatedAt: Date.now() },
    });

    sweepWriteJournal();

    expect(fs.existsSync(tempPath)).toBe(false);
    const journal = (db as unknown as { __getJournal: () => Record<string, unknown> }).__getJournal();
    expect(Object.keys(journal)).toHaveLength(0);
  });
});