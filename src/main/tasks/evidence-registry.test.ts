/**
 * evidence-registry.test.ts
 * Covers: registerEvidence, validateEvidenceRef, validateEvidenceRefs,
 *         getEvidenceRecord, getStepEvidence, collectAndRegisterEvidence,
 *         checkVerificationPolicy, sweepExpiredEvidence, getRegistrySize
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerEvidence,
  validateEvidenceRef,
  validateEvidenceRefs,
  getEvidenceRecord,
  getStepEvidence,
  collectAndRegisterEvidence,
  checkVerificationPolicy,
  sweepExpiredEvidence,
  getRegistrySize,
  _resetEvidenceRegistryForTest,
} from "./evidence-registry.js";
import type { AgentRun } from "../../shared/types.js";

const TASK_ID = "task-abc";
const STEP_ID = "step-1";
const RUN_ID  = "run-xyz";

function makeAgentRun(requestId = RUN_ID): AgentRun {
  return {
    requestId,
    conversationId: "conv-1",
    agentProfileId: "profile-1",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: "active",
    streamId: "stream-1",
    toolActivity: [],
    agentReadRefs: [],
  } as unknown as AgentRun;
}

beforeEach(() => {
  _resetEvidenceRegistryForTest();
});

// ── registerEvidence ──────────────────────────────────────────────────────

describe("registerEvidence", () => {
  it("returns an opaque UUID string ref", () => {
    const ref = registerEvidence({
      taskId: TASK_ID,
      stepId: STEP_ID,
      agentRunId: RUN_ID,
      kind: "agent_read",
      payload: { path: "/foo.ts" } as never,
    });
    expect(typeof ref).toBe("string");
    expect(ref.length).toBeGreaterThan(8);
  });

  it("stores multiple evidence records independently", () => {
    const r1 = registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/a.ts" } as never });
    const r2 = registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/b.ts" } as never });
    expect(r1).not.toBe(r2);
    expect(getRegistrySize()).toBe(2);
  });

  it("increments registry size on each registration", () => {
    expect(getRegistrySize()).toBe(0);
    registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/x.ts" } as never });
    expect(getRegistrySize()).toBe(1);
    registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/y.ts" } as never });
    expect(getRegistrySize()).toBe(2);
  });
});

// ── validateEvidenceRef ───────────────────────────────────────────────────

describe("validateEvidenceRef", () => {
  it("returns valid=true with record for a valid ref in scope", () => {
    const ref = registerEvidence({
      taskId: TASK_ID,
      stepId: STEP_ID,
      agentRunId: RUN_ID,
      kind: "agent_read",
      payload: { path: "/ok.ts" } as never,
    });
    const result = validateEvidenceRef(ref, TASK_ID, RUN_ID);
    expect(result.valid).toBe(true);
    expect(result.record?.id).toBe(ref);
  });

  it("returns valid=false for unknown ref", () => {
    const result = validateEvidenceRef("unknown-ref", TASK_ID, RUN_ID);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("returns valid=false for ref from different taskId (cross-task isolation)", () => {
    const ref = registerEvidence({
      taskId: "other-task",
      stepId: STEP_ID,
      agentRunId: RUN_ID,
      kind: "agent_read",
      payload: { path: "/x.ts" } as never,
    });
    const result = validateEvidenceRef(ref, TASK_ID, RUN_ID);
    expect(result.valid).toBe(false);
  });
});

// ── validateEvidenceRefs ──────────────────────────────────────────────────

describe("validateEvidenceRefs", () => {
  it("filters out fabricated refs, keeps valid ones", () => {
    const real = registerEvidence({
      taskId: TASK_ID,
      stepId: STEP_ID,
      agentRunId: RUN_ID,
      kind: "agent_read",
      payload: { path: "/real.ts" } as never,
    });
    const { validRefs, invalidRefs } = validateEvidenceRefs(
      [real, "fake-ref-123"],
      TASK_ID,
      RUN_ID
    );
    expect(validRefs).toEqual([real]);
    expect(invalidRefs).toHaveLength(1);
    expect(invalidRefs[0]!.ref).toBe("fake-ref-123");
  });

  it("returns all valid when all refs exist in scope", () => {
    const r1 = registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/a.ts" } as never });
    const r2 = registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/b.ts" } as never });
    const { validRefs, invalidRefs } = validateEvidenceRefs([r1, r2], TASK_ID, RUN_ID);
    expect(validRefs).toHaveLength(2);
    expect(invalidRefs).toHaveLength(0);
  });

  it("returns empty validRefs array when no refs match", () => {
    const { validRefs, invalidRefs } = validateEvidenceRefs(["x", "y"], TASK_ID, RUN_ID);
    expect(validRefs).toHaveLength(0);
    expect(invalidRefs).toHaveLength(2);
  });

  it("handles empty input array", () => {
    const { validRefs, invalidRefs } = validateEvidenceRefs([], TASK_ID, RUN_ID);
    expect(validRefs).toHaveLength(0);
    expect(invalidRefs).toHaveLength(0);
  });
});

// ── getEvidenceRecord ─────────────────────────────────────────────────────

describe("getEvidenceRecord", () => {
  it("retrieves stored record by opaque ID", () => {
    const ref = registerEvidence({
      taskId: TASK_ID,
      stepId: STEP_ID,
      agentRunId: RUN_ID,
      kind: "agent_read",
      payload: { path: "/hello.ts" } as never,
    });
    const rec = getEvidenceRecord(ref);
    expect(rec).not.toBeNull();
    expect(rec?.taskId).toBe(TASK_ID);
    expect(rec?.stepId).toBe(STEP_ID);
    expect(rec?.agentRunId).toBe(RUN_ID);
  });

  it("returns null for non-existent ID", () => {
    expect(getEvidenceRecord("does-not-exist")).toBeNull();
  });
});

// ── getStepEvidence ───────────────────────────────────────────────────────

describe("getStepEvidence", () => {
  it("returns all evidence for a specific step", () => {
    registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/a.ts" } as never });
    registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/b.ts" } as never });
    registerEvidence({ taskId: TASK_ID, stepId: "step-2", agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/c.ts" } as never });
    const recs = getStepEvidence(TASK_ID, STEP_ID);
    expect(recs).toHaveLength(2);
  });

  it("returns empty array when no evidence for step", () => {
    expect(getStepEvidence("missing-task", STEP_ID)).toHaveLength(0);
  });
});

// ── collectAndRegisterEvidence ────────────────────────────────────────────

describe("collectAndRegisterEvidence", () => {
  it("registers evidence from agentReadRefs", () => {
    const agentRun = makeAgentRun();
    const readRefs = [
      { path: "/src/main.ts", contentHash: "abc", excerpt: "code" },
      { path: "/src/utils.ts", contentHash: "def", excerpt: "more" },
    ] as never[];
    const ids = collectAndRegisterEvidence(agentRun, TASK_ID, STEP_ID, [], [], readRefs);
    expect(ids).toHaveLength(2);
    expect(getRegistrySize()).toBe(2);
  });

  it("registers evidence from commandRefs", () => {
    const agentRun = makeAgentRun();
    const cmdRefs = [
      { command: "npm test", exitCode: 0, stdout: "ok", stderr: "" },
    ] as never[];
    const ids = collectAndRegisterEvidence(agentRun, TASK_ID, STEP_ID, cmdRefs, [], []);
    expect(ids).toHaveLength(1);
  });

  it("registers evidence from browserRefs", () => {
    const agentRun = makeAgentRun();
    const browserRefs = [
      { url: "https://example.com", action: "navigate", result: "200 OK" },
    ] as never[];
    const ids = collectAndRegisterEvidence(agentRun, TASK_ID, STEP_ID, [], browserRefs, []);
    expect(ids).toHaveLength(1);
  });

  it("returns empty array when no evidence", () => {
    const agentRun = makeAgentRun();
    const ids = collectAndRegisterEvidence(agentRun, TASK_ID, STEP_ID, [], [], []);
    expect(ids).toHaveLength(0);
  });

  it("registers from all sources combined", () => {
    const agentRun = makeAgentRun();
    const cmdRefs = [{ command: "npm test", exitCode: 0, stdout: "ok", stderr: "" }] as never[];
    const browserRefs = [{ url: "https://example.com", action: "navigate", result: "ok" }] as never[];
    const readRefs = [{ path: "/file.ts", contentHash: "abc", excerpt: "code" }] as never[];
    const ids = collectAndRegisterEvidence(agentRun, TASK_ID, STEP_ID, cmdRefs, browserRefs, readRefs);
    expect(ids).toHaveLength(3);
  });
});

// ── checkVerificationPolicy ───────────────────────────────────────────────

describe("checkVerificationPolicy", () => {
  it("satisfies 'none' policy with no evidence", () => {
    const result = checkVerificationPolicy([], "none");
    expect(result.satisfied).toBe(true);
  });

  it("satisfies 'evidence_required' policy when evidence exists", () => {
    const ref = registerEvidence({
      taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID,
      kind: "agent_read", payload: { path: "/proof.ts" } as never,
    });
    const result = checkVerificationPolicy([ref], "evidence_required");
    expect(result.satisfied).toBe(true);
  });

  it("fails 'evidence_required' policy when no evidence", () => {
    const result = checkVerificationPolicy([], "evidence_required");
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("satisfies 'build_test' policy when command with exitCode=0 present", () => {
    const ref = registerEvidence({
      taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID,
      kind: "command",
      payload: { command: "npm test", exitCode: 0, stdout: "Tests: 10 passed", stderr: "" } as never,
    });
    const result = checkVerificationPolicy([ref], "build_test");
    expect(result.satisfied).toBe(true);
  });

  it("fails 'build_test' policy when command exited with non-zero", () => {
    const ref = registerEvidence({
      taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID,
      kind: "command",
      payload: { command: "npm test", exitCode: 1, stdout: "", stderr: "FAIL" } as never,
    });
    const result = checkVerificationPolicy([ref], "build_test");
    expect(result.satisfied).toBe(false);
  });

  it("satisfies 'browser' policy when browser evidence present", () => {
    const ref = registerEvidence({
      taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID,
      kind: "browser",
      payload: { url: "https://example.com", action: "navigate", result: "ok" } as never,
    });
    const result = checkVerificationPolicy([ref], "browser");
    expect(result.satisfied).toBe(true);
  });

  it("fails 'browser' policy when only command evidence", () => {
    const ref = registerEvidence({
      taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID,
      kind: "command",
      payload: { command: "ls", exitCode: 0, stdout: "", stderr: "" } as never,
    });
    const result = checkVerificationPolicy([ref], "browser");
    expect(result.satisfied).toBe(false);
  });
});

// ── sweepExpiredEvidence ──────────────────────────────────────────────────

describe("sweepExpiredEvidence", () => {
  it("returns a non-negative number", () => {
    registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/fresh.ts" } as never });
    const removed = sweepExpiredEvidence();
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(typeof removed).toBe("number");
  });

  it("does not remove fresh entries", () => {
    registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/fresh.ts" } as never });
    const before = getRegistrySize();
    sweepExpiredEvidence();
    expect(getRegistrySize()).toBe(before);
  });
});

// ── _resetEvidenceRegistryForTest ────────────────────────────────────────

describe("_resetEvidenceRegistryForTest", () => {
  it("clears all registry entries", () => {
    registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/x.ts" } as never });
    registerEvidence({ taskId: TASK_ID, stepId: STEP_ID, agentRunId: RUN_ID, kind: "agent_read", payload: { path: "/y.ts" } as never });
    expect(getRegistrySize()).toBe(2);
    _resetEvidenceRegistryForTest();
    expect(getRegistrySize()).toBe(0);
  });
});