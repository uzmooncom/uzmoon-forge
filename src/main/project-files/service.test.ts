/**
 * service.test.ts — Project Context Integrity tests
 *
 * Covers:
 * - Canonical identity: projectId + relativePath (never basename alone)
 * - Content hashing (SHA-256)
 * - Snapshot immutability after capture
 * - Duplicate basename disambiguation (src/a/index.ts vs src/b/index.ts)
 * - Cross-project isolation (same relative path, different projects)
 * - Snapshot path security (traversal blocked)
 * - Context ref persistence round-trip
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { captureSnapshot, readSnapshot, listDirectory, readFile } from "./service.js";
import { getDb, resetDb } from "../database/db.js";

let tmpDir: string;
let projectRoot: string;
let dataDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-svc-test-"));
  projectRoot = path.join(tmpDir, "project");
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  resetDb();
  getDb(dataDir);
});

afterEach(() => {
  resetDb();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function writeFile(rel: string, content: string): void {
  const abs = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

// ── Snapshot capture tests ─────────────────────────────────────────────────

describe("captureSnapshot — identity", () => {
  it("returns a ContextRef with projectId placeholder and correct relativePath", () => {
    writeFile("src/index.ts", "export const x = 1;");
    const res = captureSnapshot(projectRoot, "src/index.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Service leaves projectId empty — caller fills in
    expect(res.ref.projectId).toBe("");
    expect(res.ref.relativePath).toBe("src/index.ts");
    expect(res.ref.id).toBeTruthy();
  });

  it("produces a stable UUID snapshot path inside dataDir/snapshots", () => {
    writeFile("main.ts", "const a = 1;");
    const res = captureSnapshot(projectRoot, "main.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const snapshotsDir = path.join(dataDir, "snapshots");
    expect(res.ref.snapshotPath.startsWith(snapshotsDir)).toBe(true);
    expect(fs.existsSync(res.ref.snapshotPath)).toBe(true);
  });

  it("snapshot file contains exactly the captured content", () => {
    const content = "export function hello() { return 42; }";
    writeFile("hello.ts", content);
    const res = captureSnapshot(projectRoot, "hello.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const written = fs.readFileSync(res.ref.snapshotPath, "utf8");
    expect(written).toBe(content);
  });

  it("includes contentHash matching SHA-256 of the content", () => {
    const content = "const PI = 3.14159;";
    writeFile("pi.ts", content);
    const res = captureSnapshot(projectRoot, "pi.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const expectedHash = createHash("sha256")
      .update(Buffer.from(content, "utf8"))
      .digest("hex");
    expect(res.ref.contentHash).toBe(expectedHash);
  });

  it("contentHash changes if file content changes between captures", () => {
    writeFile("changing.ts", "const v = 1;");
    const res1 = captureSnapshot(projectRoot, "changing.ts");
    expect(res1.ok).toBe(true);
    if (!res1.ok) return;

    writeFile("changing.ts", "const v = 2;");
    const res2 = captureSnapshot(projectRoot, "changing.ts");
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;

    // Two separate snapshots — different hashes, different IDs
    expect(res1.ref.contentHash).not.toBe(res2.ref.contentHash);
    expect(res1.ref.id).not.toBe(res2.ref.id);
    expect(res1.ref.snapshotPath).not.toBe(res2.ref.snapshotPath);
  });

  it("snapshot is immutable — modifying source file does not affect captured snapshot", () => {
    const original = "const answer = 42;";
    writeFile("answer.ts", original);
    const res = captureSnapshot(projectRoot, "answer.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Mutate source after capture
    writeFile("answer.ts", "const answer = 99;");

    // Snapshot still contains original content
    const snapshotContent = readSnapshot(res.ref.snapshotPath);
    expect(snapshotContent).toBe(original);
  });
});

// ── Duplicate basename disambiguation ─────────────────────────────────────

describe("captureSnapshot — duplicate basenames", () => {
  it("two files named index.ts in different dirs produce distinct ContextRefs", () => {
    writeFile("src/a/index.ts", "export const A = 'a';");
    writeFile("src/b/index.ts", "export const B = 'b';");

    const resA = captureSnapshot(projectRoot, "src/a/index.ts");
    const resB = captureSnapshot(projectRoot, "src/b/index.ts");
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (!resA.ok || !resB.ok) return;

    // Different identity — relativePath is the discriminator, not basename
    expect(resA.ref.relativePath).toBe("src/a/index.ts");
    expect(resB.ref.relativePath).toBe("src/b/index.ts");

    // Different snapshot IDs
    expect(resA.ref.id).not.toBe(resB.ref.id);

    // Different snapshot files
    expect(resA.ref.snapshotPath).not.toBe(resB.ref.snapshotPath);

    // Different hashes
    expect(resA.ref.contentHash).not.toBe(resB.ref.contentHash);
  });

  it("same content but different paths → different identity (same hash, different relativePath)", () => {
    const sharedContent = "export const SHARED = true;";
    writeFile("pkg/a/types.ts", sharedContent);
    writeFile("pkg/b/types.ts", sharedContent);

    const resA = captureSnapshot(projectRoot, "pkg/a/types.ts");
    const resB = captureSnapshot(projectRoot, "pkg/b/types.ts");
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (!resA.ok || !resB.ok) return;

    // Same content → same hash (expected, content-addressable)
    expect(resA.ref.contentHash).toBe(resB.ref.contentHash);

    // But identity is still distinct via relativePath
    expect(resA.ref.relativePath).not.toBe(resB.ref.relativePath);
    expect(resA.ref.id).not.toBe(resB.ref.id);
  });

  it("captures the exact file selected, not a same-named sibling", () => {
    writeFile("packages/ui/index.ts", "export * from './ui';");
    writeFile("packages/core/index.ts", "export * from './core';");

    const resUi = captureSnapshot(projectRoot, "packages/ui/index.ts");
    expect(resUi.ok).toBe(true);
    if (!resUi.ok) return;

    const content = readSnapshot(resUi.ref.snapshotPath);
    // Must be the ui file, not the core file
    expect(content).toContain("ui");
    expect(content).not.toContain("core");
  });
});

// ── Cross-project isolation ────────────────────────────────────────────────

describe("captureSnapshot — cross-project isolation", () => {
  it("same relativePath in two different project roots produces different snapshots", () => {
    const projectA = path.join(tmpDir, "projectA");
    const projectB = path.join(tmpDir, "projectB");
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    fs.writeFileSync(path.join(projectA, "config.ts"), "export const env = 'production';", "utf8");
    fs.writeFileSync(path.join(projectB, "config.ts"), "export const env = 'staging';", "utf8");

    const resA = captureSnapshot(projectA, "config.ts");
    const resB = captureSnapshot(projectB, "config.ts");
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (!resA.ok || !resB.ok) return;

    // Same relativePath — but different project roots → different content
    expect(resA.ref.relativePath).toBe("config.ts");
    expect(resB.ref.relativePath).toBe("config.ts");

    // Different hashes because different content
    expect(resA.ref.contentHash).not.toBe(resB.ref.contentHash);

    // Project A and B content must not bleed into each other
    const contentA = readSnapshot(resA.ref.snapshotPath);
    const contentB = readSnapshot(resB.ref.snapshotPath);
    expect(contentA).toContain("production");
    expect(contentB).toContain("staging");
    expect(contentA).not.toContain("staging");
    expect(contentB).not.toContain("production");
  });
});

// ── Path traversal / security ──────────────────────────────────────────────

describe("captureSnapshot — security", () => {
  it("blocks path traversal with ../", () => {
    // Create a sensitive file outside project root
    const outsideFile = path.join(tmpDir, "outside-secret.txt");
    fs.writeFileSync(outsideFile, "SECRET", "utf8");

    const res = captureSnapshot(projectRoot, "../outside-secret.txt");
    // Should fail — path traversal blocked by readFile
    expect(res.ok).toBe(false);
  });

  it("blocks absolute path injection", () => {
    const outsideFile = path.join(tmpDir, "absolute-secret.txt");
    fs.writeFileSync(outsideFile, "ABSOLUTE_SECRET", "utf8");

    const res = captureSnapshot(projectRoot, outsideFile);
    // Absolute path treated as relative inside project → won't resolve to real file
    expect(res.ok).toBe(false);
  });
});

// ── Line range snapshots ───────────────────────────────────────────────────

describe("captureSnapshot — line ranges", () => {
  it("captures only selected lines with lineStart/lineEnd", () => {
    writeFile("multi.ts", "line1\nline2\nline3\nline4\nline5");
    const res = captureSnapshot(projectRoot, "multi.ts", 2, 4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ref.lineStart).toBe(2);
    expect(res.ref.lineEnd).toBe(4);

    const content = readSnapshot(res.ref.snapshotPath);
    expect(content).toContain("line2");
    expect(content).toContain("line3");
    expect(content).toContain("line4");
    expect(content).not.toContain("line1");
    expect(content).not.toContain("line5");
  });

  it("line-range and full-file snapshots of same file have different hashes", () => {
    writeFile("big.ts", "const a = 1;\nconst b = 2;\nconst c = 3;");
    const full = captureSnapshot(projectRoot, "big.ts");
    const partial = captureSnapshot(projectRoot, "big.ts", 1, 1);
    expect(full.ok).toBe(true);
    expect(partial.ok).toBe(true);
    if (!full.ok || !partial.ok) return;
    expect(full.ref.contentHash).not.toBe(partial.ref.contentHash);
  });
});

// ── readSnapshot ───────────────────────────────────────────────────────────

describe("readSnapshot", () => {
  it("returns null for non-existent snapshot path", () => {
    const result = readSnapshot(path.join(dataDir, "snapshots", "nonexistent.txt"));
    expect(result).toBeNull();
  });

  it("returns content that matches what was written", () => {
    writeFile("verify.ts", "const verified = true;");
    const res = captureSnapshot(projectRoot, "verify.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const content = readSnapshot(res.ref.snapshotPath);
    expect(content).toBe("const verified = true;");
  });
});

// ── listDirectory ──────────────────────────────────────────────────────────

describe("listDirectory", () => {
  it("lists files at root", () => {
    writeFile("a.ts", "const a = 1;");
    writeFile("b.ts", "const b = 2;");
    const res = listDirectory("proj-1", projectRoot, ".");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("a.ts");
    expect(names).toContain("b.ts");
  });

  it("entries include relativePath not just filename", () => {
    writeFile("src/utils.ts", "export const u = 0;");
    const res = listDirectory("proj-1", projectRoot, "src");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const entry = res.entries.find((e) => e.name === "utils.ts");
    expect(entry).toBeDefined();
    // relativePath must include directory — never just basename
    expect(entry?.relativePath).toBe("src/utils.ts");
  });

  it("path traversal is blocked", () => {
    const res = listDirectory("proj-1", projectRoot, "../");
    expect(res.ok).toBe(false);
  });
});

// ── readFile ───────────────────────────────────────────────────────────────

describe("readFile", () => {
  it("reads a plain text file", () => {
    writeFile("readme.md", "# Hello");
    const res = readFile(projectRoot, "readme.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content).toContain("# Hello");
  });

  it("path traversal is blocked", () => {
    const outsideFile = path.join(tmpDir, "secret.txt");
    fs.writeFileSync(outsideFile, "super secret", "utf8");
    const res = readFile(projectRoot, "../secret.txt");
    expect(res.ok).toBe(false);
  });
});

// ── buildContextMessages integration ──────────────────────────────────────
// Tests the QueueManager context injection path with real snapshots

describe("buildContextMessages — context injection", () => {
  it("injects project_file XML block for messages with contextRefs", async () => {
    const { buildContextMessages } = await import("../queue/QueueManager.js");
    writeFile("src/api.ts", "export async function fetchData() {}");
    const res = captureSnapshot(projectRoot, "src/api.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ref = { ...res.ref, projectId: "proj-1" };

    const msgs = [
      {
        id: "msg-1",
        conversationId: "conv-1",
        role: "user" as const,
        content: "Explain the fetch function",
        createdAt: Date.now(),
        contextRefs: [ref],
      },
    ];

    const result = buildContextMessages(msgs);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    // Must be multipart
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as Array<{ type: string; text: string }>;
    const contextPart = parts.find((p) => p.type === "text" && p.text.includes("<project_context>"));
    expect(contextPart).toBeDefined();
    // Must contain relativePath (not basename)
    expect(contextPart?.text).toContain('path="src/api.ts"');
    // Must contain actual file content
    expect(contextPart?.text).toContain("fetchData");
  });

  it("throws ContextMissingError when snapshot file is missing (deleted/cleaned)", async () => {
    const { buildContextMessages, ContextMissingError } = await import("../queue/QueueManager.js");
    const ref = {
      id: "missing-snap",
      projectId: "proj-1",
      relativePath: "src/gone.ts",
      capturedAt: Date.now(),
      size: 100,
      language: "typescript",
      snapshotPath: path.join(dataDir, "snapshots", "missing-uuid.txt"),
      contentHash: "deadbeef",
    };

    const msgs = [
      {
        id: "msg-2",
        conversationId: "conv-2",
        role: "user" as const,
        content: "What about this?",
        createdAt: Date.now(),
        contextRefs: [ref],
      },
    ];

    // Must throw ContextMissingError — missing snapshot must abort the request,
    // not silently send the message without its context.
    expect(() => buildContextMessages(msgs)).toThrow(ContextMissingError);
  });

  it("two duplicate-basename files get distinct project_file blocks", async () => {
    const { buildContextMessages } = await import("../queue/QueueManager.js");
    writeFile("apps/web/index.ts", "export const WEB = 'web';");
    writeFile("apps/api/index.ts", "export const API = 'api';");

    const resWeb = captureSnapshot(projectRoot, "apps/web/index.ts");
    const resApi = captureSnapshot(projectRoot, "apps/api/index.ts");
    expect(resWeb.ok).toBe(true);
    expect(resApi.ok).toBe(true);
    if (!resWeb.ok || !resApi.ok) return;

    const refs = [
      { ...resWeb.ref, projectId: "proj-1" },
      { ...resApi.ref, projectId: "proj-1" },
    ];

    const msgs = [
      {
        id: "msg-3",
        conversationId: "conv-3",
        role: "user" as const,
        content: "Compare these two",
        createdAt: Date.now(),
        contextRefs: refs,
      },
    ];

    const result = buildContextMessages(msgs);
    const parts = result[0]!.content as Array<{ type: string; text: string }>;
    const contextText = parts.find((p) => p.text?.includes("<project_context>"))?.text ?? "";

    // Both full relative paths appear
    expect(contextText).toContain('path="apps/web/index.ts"');
    expect(contextText).toContain('path="apps/api/index.ts"');
    // Both contents appear
    expect(contextText).toContain("WEB");
    expect(contextText).toContain("API");
  });

  it("throws ContextIntegrityError when snapshot content has been tampered", async () => {
    const { buildContextMessages, ContextIntegrityError } = await import("../queue/QueueManager.js");
    writeFile("src/sensitive.ts", "export const SECRET = 42;");
    const res = captureSnapshot(projectRoot, "src/sensitive.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Tamper: overwrite snapshot file with different content after capture
    fs.writeFileSync(res.ref.snapshotPath, "export const SECRET = 999; // tampered", "utf8");

    const ref = { ...res.ref, projectId: "proj-tamper" };
    const msgs = [
      {
        id: "msg-tamper",
        conversationId: "conv-tamper",
        role: "user" as const,
        content: "Use this file",
        createdAt: Date.now(),
        contextRefs: [ref],
      },
    ];

    // Must throw — must NOT silently skip and send the message without context
    expect(() => buildContextMessages(msgs)).toThrow(ContextIntegrityError);
  });

  it("ContextIntegrityError carries relativePath and resourceId", async () => {
    const { buildContextMessages, ContextIntegrityError } = await import("../queue/QueueManager.js");
    writeFile("lib/utils.ts", "export const util = true;");
    const res = captureSnapshot(projectRoot, "lib/utils.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Tamper with different content
    fs.writeFileSync(res.ref.snapshotPath, "// corrupted", "utf8");

    const ref = { ...res.ref, projectId: "proj-err" };
    const msgs = [
      {
        id: "msg-err",
        conversationId: "conv-err",
        role: "user" as const,
        content: "Check this",
        createdAt: Date.now(),
        contextRefs: [ref],
      },
    ];

    let thrown: unknown;
    try {
      buildContextMessages(msgs);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ContextIntegrityError);
    const err = thrown as InstanceType<typeof ContextIntegrityError>;
    expect(err.resourceId).toBe(res.ref.id);
    expect(err.relativePath).toBe("lib/utils.ts");
    expect(err.message).toContain("lib/utils.ts");
  });

  it("ContextMissingError carries relativePath and resourceId", async () => {
    const { buildContextMessages, ContextMissingError } = await import("../queue/QueueManager.js");
    // A ref pointing to a snapshot that was never written (file simply gone)
    const ref = {
      id: "gone-snap",
      projectId: "proj-gone",
      relativePath: "src/deleted.ts",
      capturedAt: Date.now(),
      size: 50,
      language: "typescript",
      snapshotPath: path.join(dataDir, "snapshots", "gone-uuid.txt"),
      contentHash: "aabbccdd",
    };
    const msgs = [
      {
        id: "msg-gone",
        conversationId: "conv-gone",
        role: "user" as const,
        content: "Hello",
        createdAt: Date.now(),
        contextRefs: [ref],
      },
    ];
    // Must throw ContextMissingError with correct metadata
    let thrown: unknown;
    try {
      buildContextMessages(msgs);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContextMissingError);
    const err = thrown as InstanceType<typeof ContextMissingError>;
    expect(err.resourceId).toBe("gone-snap");
    expect(err.relativePath).toBe("src/deleted.ts");
    expect(err.message).toContain("src/deleted.ts");
  });

  it("skips hash check for refs without contentHash (legacy graceful degradation)", async () => {
    const { buildContextMessages } = await import("../queue/QueueManager.js");
    // Write a snapshot manually with no contentHash on the ref
    const snapshotId = "legacy-no-hash";
    const snapshotsDir = path.join(dataDir, "snapshots");
    if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });
    const snapshotFile = path.join(snapshotsDir, `${snapshotId}.txt`);
    fs.writeFileSync(snapshotFile, "export const legacy = 1;", "utf8");

    const ref = {
      id: snapshotId,
      projectId: "proj-legacy",
      relativePath: "legacy.ts",
      capturedAt: Date.now(),
      size: 24,
      language: "typescript",
      snapshotPath: snapshotFile,
      contentHash: "", // empty string = no hash = skip check
    };
    const msgs = [
      {
        id: "msg-legacy",
        conversationId: "conv-legacy",
        role: "user" as const,
        content: "Use legacy file",
        createdAt: Date.now(),
        contextRefs: [ref],
      },
    ];
    // Must NOT throw — empty contentHash means skip integrity check
    expect(() => buildContextMessages(msgs)).not.toThrow();
  });
});