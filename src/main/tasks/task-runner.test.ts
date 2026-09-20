/**
 * task-runner.test.ts — Unit tests for task-runner.ts
 *
 * These tests focus on synchronous state management (pause, cancel, hydrate,
 * getRunnerState) and a controlled async dispatch path using fake callbacks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getRunnerState,
  listActiveRunnerIds,
  hydrateRunner,
  pauseTask,
  cancelTask,
  isTaskRunning,
  getActiveStepId,
  _resetTaskRunnersForTest,
} from "./task-runner.js";
import { makeTask, makePlan } from "./task-types.js";
import type { ForgeTask, ForgeTaskPlan } from "../../shared/types.js";
import type { TaskRunnerCallbacks } from "./task-runner.js";
import type { AgentLoopResult } from "../agent-client/agent-loop.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestPlan(taskId: string, numSteps = 1): ForgeTaskPlan {
  const rawSteps = Array.from({ length: numSteps }, (_, i) => ({
    id: `step-${i + 1}`,
    title: `Step ${i + 1}`,
    type: "generic" as const,
    dependencies: i === 0 ? [] : [`step-${i}`],
    capabilityHints: [] as string[],
  }));
  return makePlan(taskId, rawSteps);
}

function makeRunningTask(id: string): ForgeTask {
  const task = makeTask("conv-1", "Do something", "proj-1");
  return { ...task, id, status: "running" };
}

function makeNoopCallbacks(): TaskRunnerCallbacks {
  const fakeLoopResult: AgentLoopResult = {
    finalText: "done",
    proposalFenceRaw: undefined,
    stepCount: 1,
    agentReadRefs: [],
    toolActivity: [],
    agentRun: {} as never,
    taskStepResult: { status: "completed", summary: "Done", evidenceRefs: [] },
  };
  const fakePlannerResult = {
    plan: { id: "plan-1", taskId: "t1", version: 1, goalSummary: "goal", steps: [], createdAt: 0, updatedAt: 0 },
    warnings: [],
  };
  return {
    onTaskUpdate: vi.fn(),
    onPlanUpdate: vi.fn(),
    dispatchStep: vi.fn().mockResolvedValue({ loopResult: fakeLoopResult, cancelled: false }),
    pushSnapshot: vi.fn(),
    onIncident: vi.fn(),
    dispatchPlan: vi.fn().mockResolvedValue(fakePlannerResult),
  };
}

// ── Module reset ───────────────────────────────────────────────────────────

beforeEach(() => {
  _resetTaskRunnersForTest();
});

// ── getRunnerState ─────────────────────────────────────────────────────────

describe("getRunnerState", () => {
  it("returns null for unknown task", () => {
    expect(getRunnerState("nonexistent")).toBeNull();
  });

  it("returns state after hydrateRunner", () => {
    const task = makeRunningTask("task-1");
    const plan = makeTestPlan("task-1");
    hydrateRunner(task, plan);
    const state = getRunnerState("task-1");
    expect(state).not.toBeNull();
    expect(state!.task.id).toBe("task-1");
  });
});

// ── listActiveRunnerIds ────────────────────────────────────────────────────

describe("listActiveRunnerIds", () => {
  it("returns empty array when no runners", () => {
    expect(listActiveRunnerIds()).toEqual([]);
  });

  it("includes hydrated runner IDs", () => {
    const task1 = makeRunningTask("task-1");
    const task2 = makeRunningTask("task-2");
    hydrateRunner(task1, makeTestPlan("task-1"));
    hydrateRunner(task2, makeTestPlan("task-2"));
    const ids = listActiveRunnerIds();
    expect(ids).toContain("task-1");
    expect(ids).toContain("task-2");
  });
});

// ── hydrateRunner ──────────────────────────────────────────────────────────

describe("hydrateRunner", () => {
  it("stores task and plan in runner state", () => {
    const task = makeRunningTask("task-1");
    const plan = makeTestPlan("task-1");
    hydrateRunner(task, plan);
    const state = getRunnerState("task-1");
    expect(state!.task.id).toBe("task-1");
    expect(state!.plan.steps).toHaveLength(1);
  });

  it("sets activeStepId to null (no step is running after hydration)", () => {
    const task = makeRunningTask("task-1");
    hydrateRunner(task, makeTestPlan("task-1"));
    expect(getRunnerState("task-1")!.activeStepId).toBeNull();
  });

  it("sets pauseRequested to false", () => {
    const task = makeRunningTask("task-1");
    hydrateRunner(task, makeTestPlan("task-1"));
    expect(getRunnerState("task-1")!.pauseRequested).toBe(false);
  });

  it("overwrites prior state on second hydration", () => {
    const task = makeRunningTask("task-1");
    const plan1 = makeTestPlan("task-1", 1);
    const plan2 = makeTestPlan("task-1", 2);
    hydrateRunner(task, plan1);
    hydrateRunner(task, plan2);
    expect(getRunnerState("task-1")!.plan.steps).toHaveLength(2);
  });
});

// ── pauseTask ──────────────────────────────────────────────────────────────

describe("pauseTask", () => {
  it("returns false for unknown task", () => {
    expect(pauseTask("nonexistent")).toBe(false);
  });

  it("returns true and sets pauseRequested for known runner", () => {
    const task = makeRunningTask("task-1");
    hydrateRunner(task, makeTestPlan("task-1"));
    const result = pauseTask("task-1");
    expect(result).toBe(true);
    expect(getRunnerState("task-1")!.pauseRequested).toBe(true);
  });

  it("is idempotent — calling twice returns true both times", () => {
    const task = makeRunningTask("task-1");
    hydrateRunner(task, makeTestPlan("task-1"));
    expect(pauseTask("task-1")).toBe(true);
    expect(pauseTask("task-1")).toBe(true);
    expect(getRunnerState("task-1")!.pauseRequested).toBe(true);
  });
});

// ── cancelTask ────────────────────────────────────────────────────────────

describe("cancelTask", () => {
  it("returns false for unknown task", () => {
    const callbacks = makeNoopCallbacks();
    expect(cancelTask("nonexistent", callbacks)).toBe(false);
  });

  it("returns true for known runner and removes it from map", () => {
    const task = makeRunningTask("task-1");
    hydrateRunner(task, makeTestPlan("task-1"));
    const callbacks = makeNoopCallbacks();
    const result = cancelTask("task-1", callbacks);
    expect(result).toBe(true);
    expect(getRunnerState("task-1")).toBeNull();
  });

  it("calls onTaskUpdate with cancelled status", () => {
    const task = makeRunningTask("task-1");
    hydrateRunner(task, makeTestPlan("task-1"));
    const callbacks = makeNoopCallbacks();
    cancelTask("task-1", callbacks);
    expect(callbacks.onTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" })
    );
  });
});

// ── isTaskRunning ──────────────────────────────────────────────────────────

describe("isTaskRunning", () => {
  it("returns false for unknown task", () => {
    expect(isTaskRunning("nonexistent")).toBe(false);
  });

  it("returns true for hydrated runner with running status", () => {
    const task = makeRunningTask("task-1"); // status: "running"
    hydrateRunner(task, makeTestPlan("task-1"));
    // isTaskRunning = !!state && !isTaskTerminal(status); running is non-terminal
    expect(isTaskRunning("task-1")).toBe(true);
  });

  it("returns false for hydrated runner with cancelled status (terminal)", () => {
    const task = { ...makeRunningTask("task-2"), status: "cancelled" as const };
    hydrateRunner(task, makeTestPlan("task-2"));
    // cancelled is terminal → isTaskRunning returns false
    expect(isTaskRunning("task-2")).toBe(false);
  });
});

// ── getActiveStepId ────────────────────────────────────────────────────────

describe("getActiveStepId", () => {
  it("returns null for unknown task", () => {
    expect(getActiveStepId("nonexistent")).toBeNull();
  });

  it("returns null after hydration (no active step)", () => {
    const task = makeRunningTask("task-1");
    hydrateRunner(task, makeTestPlan("task-1"));
    expect(getActiveStepId("task-1")).toBeNull();
  });
});

// ── _resetTaskRunnersForTest ────────────────────────────────────────────────

describe("_resetTaskRunnersForTest", () => {
  it("clears all registered runners", () => {
    hydrateRunner(makeRunningTask("task-1"), makeTestPlan("task-1"));
    hydrateRunner(makeRunningTask("task-2"), makeTestPlan("task-2"));
    _resetTaskRunnersForTest();
    expect(listActiveRunnerIds()).toHaveLength(0);
  });
});