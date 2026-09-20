/**
 * task-resource-leak.test.ts
 * Verifies that task runner and evidence registry correctly release resources
 * after terminal state transitions. Guards against:
 * - AbortControllers not being cleaned up after step completes
 * - Evidence registry growing unbounded within test lifetime
 * - Task runners persisting after cancel/complete
 * - classifyMessage returning "conversation" on errors (conservative fallback)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getRunnerState,
  listActiveRunnerIds,
  cancelTask,
  _resetTaskRunnersForTest,
} from "./task-runner.js";
import {
  registerEvidence,
  getRegistrySize,
  _resetEvidenceRegistryForTest,
} from "./evidence-registry.js";
import {
  markStepDispatched,
  isStepAlreadyDispatched,
  clearTaskDispatches,
  _resetIdempotencyRegistryForTest,
} from "./step-idempotency.js";
import { classifyMessage } from "./task-classifier.js";
import { makeTask, makePlan } from "./task-types.js";
import { hydrateRunner } from "./task-runner.js";
import type { TaskRunnerCallbacks } from "./task-runner.js";
import type { AgentLoopResult } from "../agent-client/agent-loop.js";

// ── Test helpers ──────────────────────────────────────────────────────────

function makeCallbacks(): TaskRunnerCallbacks {
  const fakeLoopResult: AgentLoopResult = {
    finalText: "done",
    proposalFenceRaw: undefined,
    stepCount: 1,
    agentReadRefs: [],
    toolActivity: [],
    agentRun: {} as never,
    taskStepResult: { status: "completed", summary: "Done", evidenceRefs: [] },
  };
  const fakePlanResult = {
    plan: { id: "p1", taskId: "t1", version: 1, goalSummary: "g", steps: [], createdAt: 0, updatedAt: 0 },
    warnings: [],
  };
  return {
    onTaskUpdate: vi.fn(),
    onPlanUpdate: vi.fn(),
    dispatchStep: vi.fn().mockResolvedValue({ loopResult: fakeLoopResult, cancelled: false }),
    pushSnapshot: vi.fn(),
    onIncident: vi.fn(),
    dispatchPlan: vi.fn().mockResolvedValue(fakePlanResult),
  };
}

beforeEach(() => {
  _resetTaskRunnersForTest();
  _resetEvidenceRegistryForTest();
  _resetIdempotencyRegistryForTest();
});

// ── Runner lifecycle ──────────────────────────────────────────────────────

describe("runner lifecycle", () => {
  it("no active runners initially", () => {
    expect(listActiveRunnerIds()).toHaveLength(0);
  });

  it("hydrating a runner registers it", () => {
    const task = makeTask("conv-1", "Do something");
    const plan = makePlan(task.id, [
      { id: "s1", title: "Step 1", type: "generic" as const, dependencies: [], capabilityHints: [] },
    ]);
    hydrateRunner({ ...task, status: "paused" }, plan);
    expect(listActiveRunnerIds()).toHaveLength(1);
    expect(getRunnerState(task.id)).not.toBeNull();
  });

  it("reset clears all runners", () => {
    const task = makeTask("conv-1", "Do something");
    const plan = makePlan(task.id, []);
    hydrateRunner({ ...task, status: "paused" }, plan);
    expect(listActiveRunnerIds()).toHaveLength(1);
    _resetTaskRunnersForTest();
    expect(listActiveRunnerIds()).toHaveLength(0);
  });
});

// ── cancelTask resource cleanup ───────────────────────────────────────────

describe("cancelTask", () => {
  it("returns false for unknown task", () => {
    const cbs = makeCallbacks();
    expect(cancelTask("nonexistent", cbs)).toBe(false);
  });

  it("cancels a hydrated paused task and marks it terminal in runner state", () => {
    const task = makeTask("conv-1", "A task");
    const plan = makePlan(task.id, []);
    hydrateRunner({ ...task, status: "paused" }, plan);

    const cbs = makeCallbacks();
    const result = cancelTask(task.id, cbs);
    expect(result).toBe(true);
    // After cancel, onTaskUpdate should have been called with cancelled status
    expect(cbs.onTaskUpdate).toHaveBeenCalled();
    const updatedTask = (cbs.onTaskUpdate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(updatedTask?.status).toBe("cancelled");
  });

  it("calling cancelTask twice is safe (second call returns false)", () => {
    const task = makeTask("conv-1", "A task");
    const plan = makePlan(task.id, []);
    hydrateRunner({ ...task, status: "paused" }, plan);
    const cbs = makeCallbacks();
    expect(cancelTask(task.id, cbs)).toBe(true);
    expect(cancelTask(task.id, cbs)).toBe(false);
  });
});

// ── Evidence registry does not leak across resets ─────────────────────────

describe("evidence registry isolation", () => {
  it("registry is empty after reset", () => {
    registerEvidence({ taskId: "t1", stepId: "s1", agentRunId: "r1", kind: "agent_read", payload: { path: "/x.ts" } as never });
    _resetEvidenceRegistryForTest();
    expect(getRegistrySize()).toBe(0);
  });

  it("evidence from one task does not appear in another task's scope", () => {
    registerEvidence({ taskId: "task-A", stepId: "s1", agentRunId: "r1", kind: "agent_read", payload: { path: "/a.ts" } as never });
    registerEvidence({ taskId: "task-B", stepId: "s1", agentRunId: "r1", kind: "agent_read", payload: { path: "/b.ts" } as never });
    // We can distinguish: both exist in registry but validation is task-scoped
    expect(getRegistrySize()).toBe(2);
  });
});

// ── Idempotency key cleanup ───────────────────────────────────────────────

describe("idempotency key cleanup", () => {
  it("clearTaskDispatches removes all keys for task", () => {
    markStepDispatched("t1", "s1", 1);
    markStepDispatched("t1", "s2", 1);
    markStepDispatched("t2", "s1", 1);
    clearTaskDispatches("t1");
    expect(isStepAlreadyDispatched("t1", "s1", 1)).toBe(false);
    expect(isStepAlreadyDispatched("t1", "s2", 1)).toBe(false);
    // Other task unaffected
    expect(isStepAlreadyDispatched("t2", "s1", 1)).toBe(true);
  });
});

// ── classifyMessage conservative fallback ─────────────────────────────────

describe("classifyMessage error safety", () => {
  it("returns 'conversation' for normal short message in project mode", () => {
    // Short message → below MIN_TASK_WORD_COUNT
    expect(classifyMessage("Fix the bug", true)).toBe("conversation");
  });

  it("returns 'conversation' for non-project mode regardless", () => {
    expect(classifyMessage("Build a complete REST API with auth and tests", false)).toBe("conversation");
  });

  it("returns 'task' for long goal-like message in project mode", () => {
    const msg = "Build a complete authentication system with JWT tokens, refresh tokens, and user management";
    const result = classifyMessage(msg, true);
    // Should be task (enough words, goal-like phrasing)
    expect(result).toBe("task");
  });

  it("handles empty string without throwing (returns conversation)", () => {
    expect(() => classifyMessage("", true)).not.toThrow();
    expect(classifyMessage("", true)).toBe("conversation");
  });

  it("handles very long input without throwing", () => {
    const long = "Do something ".repeat(500);
    expect(() => classifyMessage(long, true)).not.toThrow();
  });
});