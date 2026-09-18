/**
 * Stop Lifecycle Tests
 *
 * Verifies the full cancellation lifecycle:
 *   1. returnControl with correct requestId resumes the run
 *   2. returnControl with stale requestId is silently ignored
 *   3. Stop during waiting_for_human rejects the onWaitingForHuman promise
 *   4. cancelStream triggers the approval cancellation callback
 *   5. Calling cancelStream twice is idempotent (abort fires once)
 *   6. Abort race: aborted signal before onWaitingForHuman is set → immediate reject
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../agent-client/agent-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-client/agent-loop.js")>();
  return { ...actual, runAgentLoop: vi.fn() };
});

vi.mock("../agent-client/client.js", () => ({
  makeRequest: vi.fn(() => Promise.resolve("ok")),
  classifyError: vi.fn(() => ({ status: "unknown", message: "mock error" })),
  testConnection: vi.fn(() => Promise.resolve({ status: "connected" })),
}));

vi.mock("../reliability/index.js", () => ({
  tryGetTraceRecorder: () => null,
  tryGetIncidentRecorder: () => null,
  assertInvariant: () => undefined,
  assertInvariantStrict: () => undefined,
  initReliabilityEngine: vi.fn(),
}));

vi.mock("../browser/browser-manager.js", () => ({
  requestShowBrowser: vi.fn(),
  getBrowserStatus: vi.fn(() => ({ open: false })),
  isBrowserWindowOpen: vi.fn(() => false),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { runAgentLoop } from "../agent-client/agent-loop.js";
import {
  getDb,
  resetDb,
  createConversation,
  saveAgentProfile,
} from "../database/db.js";
import {
  queueManager,
  setSecretGetter,
  getActiveStreamId,
  cancelStream,
  returnControl,
  setCancelApprovalsCallback,
  drainForTest,
  _resetQueueManagerForTest,
} from "./QueueManager.js";

const mockRunAgentLoop = vi.mocked(runAgentLoop);

const PROFILE_ID = "profile-stop-lifecycle";
let tmpDir: string;
let dataDir: string;

// ── Helpers ──────────────────────────────────────────────────────────────────

function wait(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

function pollUntil(cond: () => boolean, maxMs = 5000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) { resolve(); return; }
      if (Date.now() - start > maxMs) {
        reject(new Error(`pollUntil timeout after ${maxMs}ms`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function makeConv(id: string): string {
  createConversation(true, {
    id,
    title: "Stop Lifecycle Test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaultAgentProfileId: PROFILE_ID,
  });
  return id;
}

function enqueue(convId: string) {
  return queueManager.enqueue({
    conversationId: convId,
    content: "test message",
    attachmentIds: [],
    targetAgentProfileId: PROFILE_ID,
  });
}

function makeLoopResult(): import("../agent-client/agent-loop.js").AgentLoopResult {
  return {
    finalText: "ok",
    proposalFenceRaw: undefined,
    toolActivity: [],
    agentReadRefs: [],
    stepCount: 0,
    agentRun: {
      requestId: "r",
      conversationId: "c",
      projectId: "",
      agentProfileId: PROFILE_ID,
      state: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      toolStepCount: 0,
      recoveryCount: 0,
      readByteCount: 0,
      stuckScore: 0,
      terminated: true,
    },
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-stop-lifecycle-"));
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  resetDb();
  getDb(dataDir);

  saveAgentProfile(true, {
    id: PROFILE_ID,
    name: "Stop Lifecycle Agent",
    endpoint: "https://test.example.com",
    protocol: "anthropic",
    model: "test-model",
    isDefault: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  setSecretGetter(() => "sk-test");
  mockRunAgentLoop.mockReset();
  _resetQueueManagerForTest();
  queueManager.setSender({
    send: () => {},
    isDestroyed: () => false,
  } as unknown as Electron.WebContents);
});

afterEach(async () => {
  await drainForTest();
  _resetQueueManagerForTest();
  resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Stop Lifecycle (run-scoped return control + approval cancellation)", () => {
  // ── 1. returnControl with conv id (no requestId) resumes the run ───────────

  it("returnControl with conversationId (no requestId) resumes waiting run", async () => {
    let resumed = false;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      if (opts.onWaitingForHuman) {
        await opts.onWaitingForHuman({ kind: "captcha", description: "CAPTCHA required" });
        resumed = true;
      }
      return makeLoopResult();
    });

    makeConv("conv-sl-1");
    await enqueue("conv-sl-1");

    // Wait for the loop to be in waiting_for_human
    await pollUntil(() => mockRunAgentLoop.mock.calls.length > 0);
    await wait(60);

    // Backward-compat: no requestId → conv-level lookup
    returnControl("conv-sl-1");

    await pollUntil(() => resumed, 3000);
    expect(resumed).toBe(true);
  });

  // ── 2. returnControl with stale requestId is silently ignored ─────────────

  it("returnControl with stale requestId does not resume any run", async () => {
    let resumed = false;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      if (opts.onWaitingForHuman) {
        try {
          await opts.onWaitingForHuman({ kind: "captcha", description: "CAPTCHA required" });
          resumed = true;
        } catch {
          // cancelled or ignored
        }
      }
      return makeLoopResult();
    });

    makeConv("conv-sl-2");
    await enqueue("conv-sl-2");
    await pollUntil(() => mockRunAgentLoop.mock.calls.length > 0);
    await wait(60);

    // Use a stale / unknown requestId
    returnControl("conv-sl-2", "stale-request-id-does-not-exist");
    await wait(100);

    // Should NOT have resumed — requestId doesn't match
    expect(resumed).toBe(false);

    // Clean up: actually cancel so afterEach drain succeeds
    const sid = getActiveStreamId("conv-sl-2");
    if (sid) cancelStream(sid);
  });

  // ── 3. Stop during waiting_for_human → rejection ──────────────────────────

  it("cancelStream during waiting_for_human rejects onWaitingForHuman promise", async () => {
    let rejectMessage: string | undefined;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      if (opts.onWaitingForHuman) {
        try {
          await opts.onWaitingForHuman({ kind: "mfa", description: "MFA required" });
        } catch (err) {
          rejectMessage = err instanceof Error ? err.message : String(err);
        }
      }
      return makeLoopResult();
    });

    makeConv("conv-sl-3");
    await enqueue("conv-sl-3");
    await pollUntil(() => mockRunAgentLoop.mock.calls.length > 0);
    await wait(60);

    const sid = getActiveStreamId("conv-sl-3");
    expect(sid).toBeDefined();

    cancelStream(sid!);

    await pollUntil(() => rejectMessage !== undefined, 3000);
    expect(rejectMessage).toBe("CANCELLED");
  });

  // ── 4. cancelStream fires the approval cancellation callback ──────────────

  it("cancelStream triggers the approval cancellation callback with a non-empty requestId", async () => {
    const cancelledRequests: string[] = [];
    setCancelApprovalsCallback((requestId) => {
      cancelledRequests.push(requestId);
    });

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      // Hang until aborted
      await new Promise<void>((_, reject) => {
        if (opts.signal.aborted) { reject(new Error("CANCELLED")); return; }
        opts.signal.addEventListener("abort", () => reject(new Error("CANCELLED")), { once: true });
      });
      return makeLoopResult();
    });

    makeConv("conv-sl-4");
    await enqueue("conv-sl-4");

    let sid: string | undefined;
    await pollUntil(() => {
      sid = getActiveStreamId("conv-sl-4");
      return !!sid;
    });

    cancelStream(sid!);
    await wait(80);

    // Callback should have been called with the requestId
    expect(cancelledRequests.length).toBeGreaterThanOrEqual(1);
    expect(typeof cancelledRequests[0]).toBe("string");
    expect(cancelledRequests[0]!.length).toBeGreaterThan(0);
  });

  // ── 5. Calling cancelStream twice is idempotent ────────────────────────────

  it("calling cancelStream twice on same streamId is idempotent", async () => {
    let abortCount = 0;

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      await new Promise<void>((_, reject) => {
        if (opts.signal.aborted) { reject(new Error("CANCELLED")); return; }
        opts.signal.addEventListener("abort", () => {
          abortCount++;
          reject(new Error("CANCELLED"));
        }, { once: true });
      });
      return makeLoopResult();
    });

    makeConv("conv-sl-5");
    await enqueue("conv-sl-5");

    let sid: string | undefined;
    await pollUntil(() => {
      sid = getActiveStreamId("conv-sl-5");
      return !!sid;
    });

    cancelStream(sid!);
    cancelStream(sid!); // second call — no-op
    await wait(80);

    expect(abortCount).toBe(1);
  });

  // ── 6. Abort race: signal already aborted before onWaitingForHuman runs ───
  //
  // The QueueManager race guard is: if (controller.signal.aborted) return Promise.reject(new Error('CANCELLED'))
  // We verify this by: aborting via cancelStream inside the mock BEFORE calling onWaitingForHuman.
  // The mock has direct access to the streamId via the convId → getActiveStreamId lookup.

  it("aborted signal before onWaitingForHuman fires causes immediate rejection", async () => {
    let rejectMessage: string | undefined;
    const convId = makeConv("conv-sl-6");

    mockRunAgentLoop.mockImplementationOnce(async (opts) => {
      if (opts.onWaitingForHuman) {
        // Cancel the stream BEFORE calling onWaitingForHuman (simulates the race)
        const sid = getActiveStreamId(convId);
        if (sid) cancelStream(sid);
        // onWaitingForHuman sees signal.aborted === true → immediate rejection
        try {
          await opts.onWaitingForHuman({ kind: "captcha", description: "CAPTCHA required" });
        } catch (err) {
          rejectMessage = err instanceof Error ? err.message : String(err);
        }
      }
      return makeLoopResult();
    });

    await enqueue(convId);
    await pollUntil(() => mockRunAgentLoop.mock.calls.length > 0);
    await wait(200); // let the mock run to completion

    expect(rejectMessage).toBe("CANCELLED");
  });
});