/**
 * agentRead.integration.test.ts — V0.4 agent-read / edit-base integration tests.
 *
 * Verifies the following requirements end-to-end:
 *
 *  Req 6:  Agent reads a file with read_file (agentReadRef, fullFile=true)
 *          → model proposes forge_edit_proposal → FileEdit.status=ready
 *
 *  Req 7:  Agent only uses search_code / search_files (no read_file)
 *          → forge_edit_proposal → FileEdit.status=needs_context
 *
 *  Req 8:  Agent uses read_file_range only (fullFile=false)
 *          → forge_edit_proposal → FileEdit.status=needs_context
 *
 *  Req 9:  Agent reads a file (fullFile=true), then the file is modified
 *          on disk BEFORE Apply → preflight hash check → Apply blocked (stale)
 *
 *  Req 10: Incremental index — buildIndex then evictIndex+rebuild reflects
 *          new/modified/deleted files
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// ── Mock runAgentLoop so we control what agentReadRefs + finalText it returns ─
vi.mock("../agent-client/agent-loop.js", () => ({
  runAgentLoop: vi.fn(),
}));

// Also mock client so the real HTTP is never called
vi.mock("../agent-client/client.js", () => ({
  makeRequest: vi.fn(() => Promise.resolve("ok")),
  classifyError: vi.fn(() => ({ status: "unknown", message: "mock error" })),
  testConnection: vi.fn(() => Promise.resolve({ status: "connected" })),
}));

import { runAgentLoop } from "../agent-client/agent-loop.js";
import {
  getDb,
  resetDb,
  createConversation,
  saveAgentProfile,
  createProject,
  getProposal,
  getMessagesByConversation,
} from "../database/db.js";
import { captureSnapshot, buildIndex, evictIndex, getAllIndexedPaths, searchFiles } from "../project-files/service.js";
import { queueManager, setSecretGetter } from "./QueueManager.js";
import type { AgentReadRef } from "../../shared/types.js";

const mockRunAgentLoop = runAgentLoop as ReturnType<typeof vi.fn>;

// ── Test setup ──────────────────────────────────────────────────────────────

let tmpDir: string;
let projectRoot: string;
let dataDir: string;

const PROFILE_ID = "agent-read-test-profile";
const PROJECT_ID = "agent-read-proj-001";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-agentread-test-"));
  projectRoot = path.join(tmpDir, "project");
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  resetDb();
  getDb(dataDir);

  saveAgentProfile(true, {
    id: PROFILE_ID,
    name: "Test Agent",
    endpoint: "https://test.example.com",
    protocol: "anthropic",
    model: "claude-test",
    isDefault: false,
    lastConnectionStatus: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  createProject(true, {
    id: PROJECT_ID,
    name: "Test Project",
    workingDirectory: projectRoot,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  setSecretGetter((id) => (id === PROFILE_ID ? "test-api-key" : null));

  mockRunAgentLoop.mockReset();

  queueManager.setSender({
    send: () => {},
    isDestroyed: () => false,
  } as unknown as Electron.WebContents);
});

afterEach(() => {
  // Evict in-memory index so stale entries don't bleed into next test
  evictIndex(PROJECT_ID);
  resetDb();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeProjectFile(rel: string, content: string): void {
  const abs = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function waitForQueue(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeForgeProposalResponse(relPath: string, newContent: string): string {
  return [
    "I've analyzed the file and propose the following change:",
    "```forge_edit_proposal",
    JSON.stringify({
      type: "forge_edit_proposal",
      summary: "Update file",
      files: [{ path: relPath, content: newContent }],
    }),
    "```",
  ].join("\n");
}

// makeAgentReadRef is defined but not used directly in tests — each test builds its
// own AgentReadRef inline for clarity. Keeping the helper available for future tests.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _makeAgentReadRef(overrides: { snapshotPath: string; relativePath: string } & Partial<AgentReadRef>): AgentReadRef {
  return {
    id: overrides.id ?? randomUUID(),
    requestId: overrides.requestId ?? randomUUID(),
    conversationId: overrides.conversationId ?? "conv-placeholder",
    projectId: overrides.projectId ?? PROJECT_ID,
    snapshotPath: overrides.snapshotPath,
    contentHash: overrides.contentHash ?? "deadbeef",
    capturedAt: overrides.capturedAt ?? Date.now(),
    size: overrides.size ?? 100,
    language: overrides.language ?? "typescript",
    fullFile: overrides.fullFile ?? true,
    relativePath: overrides.relativePath,
  };
}

async function enqueueMessage(convId: string) {
  return queueManager.enqueue({
    conversationId: convId,
    content: "Refactor this file",
    attachmentIds: [],
    targetAgentProfileId: PROFILE_ID,
    contextRefs: [], // No manual context — agent must discover autonomously
  });
}

// ── Req 6: agent read_file → forge_edit_proposal → FileEdit.status=ready ───

describe("Req 6 — agent read_file full file → FileEdit.status ready", () => {
  it("FileEdit is ready when agent used read_file (fullFile=true) for the proposed path", async () => {
    // Arrange: create the source file
    const relPath = "src/utils.ts";
    const originalContent = "export const add = (a: number, b: number) => a + b;";
    const proposedContent = "export const add = (a: number, b: number): number => a + b;";
    writeProjectFile(relPath, originalContent);

    // Capture a snapshot representing the agent's read_file call
    const snap = captureSnapshot(PROJECT_ID, projectRoot, relPath);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    // Build agentReadRef (fullFile=true)
    const agentRef: AgentReadRef = {
      id: snap.ref.id,
      requestId: randomUUID(),
      conversationId: "will-be-set-later",
      projectId: PROJECT_ID,
      relativePath: snap.ref.relativePath,
      snapshotPath: snap.ref.snapshotPath,
      contentHash: snap.ref.contentHash,
      capturedAt: snap.ref.capturedAt,
      size: snap.ref.size,
      language: snap.ref.language,
      fullFile: true,
    };

    // Mock runAgentLoop to return: agent read the file + proposed changes
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: makeForgeProposalResponse(relPath, proposedContent),
      stepCount: 2,
      agentReadRefs: [agentRef],
      toolActivity: [],
    });

    // Act
    const convId = "conv-req6-ready";
    createConversation(true, {
      id: convId,
      title: "Req 6 Test",
      projectId: PROJECT_ID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await enqueueMessage(convId);
    await waitForQueue();

    // Assert: runAgentLoop was called
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);

    // Assert: a proposal was created with FileEdit.status=ready
    const msgs = getMessagesByConversation(true, convId);
    const aMsg = msgs.find((m) => m.role === "assistant");
    expect(aMsg).toBeDefined();

    const proposalId = (aMsg as unknown as Record<string, unknown>)["proposalId"];
    expect(proposalId).toBeTruthy();

    const proposal = getProposal(true, proposalId as string);
    expect(proposal).not.toBeNull();
    expect(proposal!.fileEdits.length).toBe(1);

    // The key assertion: status=ready because agent read the full file
    expect(proposal!.fileEdits[0]!.status).toBe("ready");
    expect(proposal!.fileEdits[0]!.baseSnapshotId).toBeTruthy();
  });
});

// ── Req 7: no read_file → forge_edit_proposal → FileEdit.status=needs_context ─

describe("Req 7 — no read_file (search only) → FileEdit.status needs_context", () => {
  it("FileEdit is needs_context when agent only searched but never read the file", async () => {
    const relPath = "src/config.ts";
    const proposedContent = "export const config = { debug: false };";
    writeProjectFile(relPath, "export const config = { debug: true };");

    // Mock: agent searched but did NOT read the file (agentReadRefs=[])
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: makeForgeProposalResponse(relPath, proposedContent),
      stepCount: 1,
      agentReadRefs: [], // <-- no read_file calls
      toolActivity: [],
    });

    const convId = "conv-req7-no-read";
    createConversation(true, {
      id: convId,
      title: "Req 7 Test",
      projectId: PROJECT_ID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await enqueueMessage(convId);
    await waitForQueue();

    const msgs = getMessagesByConversation(true, convId);
    const aMsg = msgs.find((m) => m.role === "assistant");
    expect(aMsg).toBeDefined();

    const proposalId = (aMsg as unknown as Record<string, unknown>)["proposalId"];
    expect(proposalId).toBeTruthy();

    const proposal = getProposal(true, proposalId as string);
    expect(proposal).not.toBeNull();
    expect(proposal!.fileEdits.length).toBe(1);

    // The key assertion: needs_context because no full-file snapshot exists
    expect(proposal!.fileEdits[0]!.status).toBe("needs_context");
    expect(proposal!.fileEdits[0]!.baseSnapshotId).toBeUndefined();
  });
});

// ── Req 8: read_file_range only → FileEdit.status=needs_context ─────────────

describe("Req 8 — read_file_range only (fullFile=false) → FileEdit.status needs_context", () => {
  it("FileEdit is needs_context when agent only read a line range (not full file)", async () => {
    const relPath = "src/helpers.ts";
    const proposedContent = "export function helper(): string { return 'v2'; }";
    writeProjectFile(relPath, "export function helper(): string { return 'v1'; }");

    // Capture a RANGE snapshot (fullFile=false — simulates read_file_range)
    const snap = captureSnapshot(PROJECT_ID, projectRoot, relPath, 1, 1);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    const rangeRef: AgentReadRef = {
      id: snap.ref.id,
      requestId: randomUUID(),
      conversationId: "conv-req8-range",
      projectId: PROJECT_ID,
      relativePath: snap.ref.relativePath,
      snapshotPath: snap.ref.snapshotPath,
      contentHash: snap.ref.contentHash,
      capturedAt: snap.ref.capturedAt,
      size: snap.ref.size,
      language: snap.ref.language,
      fullFile: false, // <-- range read, NOT valid as edit base
      lineStart: 1,
      lineEnd: 1,
    };

    // Mock: agent read a range but NOT the full file
    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: makeForgeProposalResponse(relPath, proposedContent),
      stepCount: 1,
      agentReadRefs: [rangeRef],
      toolActivity: [],
    });

    const convId = "conv-req8-range";
    createConversation(true, {
      id: convId,
      title: "Req 8 Test",
      projectId: PROJECT_ID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await enqueueMessage(convId);
    await waitForQueue();

    const msgs = getMessagesByConversation(true, convId);
    const aMsg = msgs.find((m) => m.role === "assistant");
    expect(aMsg).toBeDefined();

    const proposalId = (aMsg as unknown as Record<string, unknown>)["proposalId"];
    expect(proposalId).toBeTruthy();

    const proposal = getProposal(true, proposalId as string);
    expect(proposal).not.toBeNull();
    expect(proposal!.fileEdits.length).toBe(1);

    // Key assertion: needs_context because fullFile=false ref is not a valid edit base
    expect(proposal!.fileEdits[0]!.status).toBe("needs_context");
    expect(proposal!.fileEdits[0]!.baseSnapshotId).toBeUndefined();
  });
});

// ── Req 9: file modified after agent read → Apply blocked (stale) ────────────

describe("Req 9 — file modified between agent read and Apply → stale apply blocked", () => {
  it("preflightCheck fails if file on disk changed after agent read snapshot", async () => {
    const relPath = "src/target.ts";
    const originalContent = "export const TARGET_VERSION = 1;";
    const proposedContent = "export const TARGET_VERSION = 2;";
    writeProjectFile(relPath, originalContent);

    // Capture full-file snapshot (as agent's read_file would)
    const snap = captureSnapshot(PROJECT_ID, projectRoot, relPath);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    const agentRef: AgentReadRef = {
      id: snap.ref.id,
      requestId: randomUUID(),
      conversationId: "conv-req9-stale",
      projectId: PROJECT_ID,
      relativePath: snap.ref.relativePath,
      snapshotPath: snap.ref.snapshotPath,
      contentHash: snap.ref.contentHash,
      capturedAt: snap.ref.capturedAt,
      size: snap.ref.size,
      language: snap.ref.language,
      fullFile: true,
    };

    mockRunAgentLoop.mockResolvedValueOnce({
      finalText: makeForgeProposalResponse(relPath, proposedContent),
      stepCount: 1,
      agentReadRefs: [agentRef],
      toolActivity: [],
    });

    const convId = "conv-req9-stale";
    createConversation(true, {
      id: convId,
      title: "Req 9 Test",
      projectId: PROJECT_ID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await enqueueMessage(convId);
    await waitForQueue();

    // Get the proposal
    const msgs = getMessagesByConversation(true, convId);
    const aMsg = msgs.find((m) => m.role === "assistant");
    const proposalId = (aMsg as unknown as Record<string, unknown>)["proposalId"] as string;
    expect(proposalId).toBeTruthy();

    const proposal = getProposal(true, proposalId);
    expect(proposal).not.toBeNull();
    expect(proposal!.fileEdits[0]!.status).toBe("ready");

    // NOW: modify the file on disk (simulates external edit after agent snapshot)
    writeProjectFile(relPath, "export const TARGET_VERSION = 99; // externally modified");

    // Run preflight — should fail because disk content no longer matches base snapshot
    const { preflightFileEdits } = await import("../project-files/edit-service.js");
    // Correct signature: (projectRoot, proposal, selectedFileEditIds) → PreflightResult[]
    const preflightResults = preflightFileEdits(
      projectRoot,
      proposal!,
      [proposal!.fileEdits[0]!.id]
    );

    // Preflight must report the file as stale/failed — NOT ok to apply
    expect(preflightResults.length).toBe(1);
    expect(preflightResults[0]!.ok).toBe(false);
    // Should mention stale or hash mismatch
    expect(preflightResults[0]!.reason).toBeTruthy();
  });
});

// ── Helpers for async index polling ─────────────────────────────────────────

/** Poll until predicate is true or timeout (ms). Yields between polls. */
async function pollUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return predicate();
}

// ── Req 10: incremental index — new/modified/deleted files reflected ──────────

describe("Req 10 — incremental index reflects file system changes after evict+rebuild", () => {
  it("new file appears in index after evict+rebuild", async () => {
    evictIndex(PROJECT_ID); // ensure clean slate regardless of previous test state
    writeProjectFile("src/existing.ts", "export const x = 1;");
    buildIndex(PROJECT_ID, projectRoot);

    // Yield to let setImmediate-based async walk complete
    await pollUntil(() => getAllIndexedPaths(PROJECT_ID, projectRoot).length > 0);

    const beforePaths = getAllIndexedPaths(PROJECT_ID, projectRoot);
    expect(beforePaths.some((p) => p.includes("existing.ts"))).toBe(true);
    expect(beforePaths.some((p) => p.includes("newfile.ts"))).toBe(false);

    // Add a new file
    writeProjectFile("src/newfile.ts", "export const y = 2;");

    // Evict and rebuild
    evictIndex(PROJECT_ID);
    buildIndex(PROJECT_ID, projectRoot);

    // Wait for async rebuild to include the new file
    await pollUntil(() => getAllIndexedPaths(PROJECT_ID, projectRoot).some((p) => p.includes("newfile.ts")));

    const afterPaths = getAllIndexedPaths(PROJECT_ID, projectRoot);
    expect(afterPaths.some((p) => p.includes("newfile.ts"))).toBe(true);
    expect(afterPaths.some((p) => p.includes("existing.ts"))).toBe(true);
  });

  it("deleted file disappears from index after evict+rebuild", async () => {
    evictIndex(PROJECT_ID);
    writeProjectFile("src/will-delete.ts", "export const z = 3;");
    buildIndex(PROJECT_ID, projectRoot);

    await pollUntil(() => getAllIndexedPaths(PROJECT_ID, projectRoot).some((p) => p.includes("will-delete.ts")));

    const beforePaths = getAllIndexedPaths(PROJECT_ID, projectRoot);
    expect(beforePaths.some((p) => p.includes("will-delete.ts"))).toBe(true);

    // Delete the file
    fs.unlinkSync(path.join(projectRoot, "src", "will-delete.ts"));

    // Evict and rebuild
    evictIndex(PROJECT_ID);
    buildIndex(PROJECT_ID, projectRoot);

    // Wait until deleted file is gone from index
    await pollUntil(() => !getAllIndexedPaths(PROJECT_ID, projectRoot).some((p) => p.includes("will-delete.ts")));

    const afterPaths = getAllIndexedPaths(PROJECT_ID, projectRoot);
    expect(afterPaths.some((p) => p.includes("will-delete.ts"))).toBe(false);
  });

  it("searchFiles returns only files that exist after evict+rebuild", async () => {
    evictIndex(PROJECT_ID);
    writeProjectFile("lib/alpha.ts", "export const alpha = 1;");
    writeProjectFile("lib/beta.ts", "export const beta = 2;");
    buildIndex(PROJECT_ID, projectRoot);

    // Wait for index to contain alpha.ts before querying searchFiles
    await pollUntil(() => getAllIndexedPaths(PROJECT_ID, projectRoot).some((p) => p.includes("alpha.ts")));

    // Verify both files searchable (index is ready now)
    const beforeAlpha = searchFiles(PROJECT_ID, projectRoot, "alpha", 10);
    expect(beforeAlpha.some((f) => f.name === "alpha.ts")).toBe(true);

    // Delete alpha.ts and rebuild
    fs.unlinkSync(path.join(projectRoot, "lib", "alpha.ts"));
    evictIndex(PROJECT_ID);
    buildIndex(PROJECT_ID, projectRoot);

    // Wait until alpha.ts is gone from index
    await pollUntil(() => !searchFiles(PROJECT_ID, projectRoot, "alpha", 10).some((f) => f.name === "alpha.ts"));

    // alpha.ts should no longer appear in search results
    const afterAlpha = searchFiles(PROJECT_ID, projectRoot, "alpha", 10);
    expect(afterAlpha.some((f) => f.name === "alpha.ts")).toBe(false);

    // beta.ts should still appear
    const afterBeta = searchFiles(PROJECT_ID, projectRoot, "beta", 10);
    expect(afterBeta.some((f) => f.name === "beta.ts")).toBe(true);
  });
});