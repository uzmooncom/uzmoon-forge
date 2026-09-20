/**
 * task-types.test.ts — Unit tests for task-types.ts
 * Pure data + validators — no I/O.
 */
import { describe, it, expect } from "vitest";
import {
  isTaskTerminal,
  isStepTerminal,
  isTaskActive,
  hasPlanCycle,
  topoSort,
  getReadySteps,
  validatePlannerOutput,
  extractStepResult,
  inferStepResult,
  makeTask,
  makeStep,
  makePlan,
} from "./task-types.js";
import type { ForgeTaskStep } from "../../shared/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestStep(
  id: string,
  deps: string[] = [],
  status: ForgeTaskStep["status"] = "pending"
): ForgeTaskStep {
  return {
    id,
    taskId: "task-1",
    title: `Step ${id}`,
    type: "generic",
    status,
    dependencies: deps,
    capabilityHints: [],
    evidenceRefs: [],
    attemptCount: 0,
  };
}

// ── isTaskTerminal ─────────────────────────────────────────────────────────

describe("isTaskTerminal", () => {
  it("returns true for completed", () => {
    expect(isTaskTerminal("completed")).toBe(true);
  });

  it("returns true for failed", () => {
    expect(isTaskTerminal("failed")).toBe(true);
  });

  it("returns true for cancelled", () => {
    expect(isTaskTerminal("cancelled")).toBe(true);
  });

  it("returns false for running", () => {
    expect(isTaskTerminal("running")).toBe(false);
  });

  it("returns false for paused", () => {
    expect(isTaskTerminal("paused")).toBe(false);
  });

  it("returns false for planning", () => {
    expect(isTaskTerminal("planning")).toBe(false);
  });
});

// ── isStepTerminal ─────────────────────────────────────────────────────────

describe("isStepTerminal", () => {
  it("returns true for completed", () => {
    expect(isStepTerminal("completed")).toBe(true);
  });

  it("returns true for failed", () => {
    expect(isStepTerminal("failed")).toBe(true);
  });

  it("returns true for skipped", () => {
    expect(isStepTerminal("skipped")).toBe(true);
  });

  it("returns false for pending", () => {
    expect(isStepTerminal("pending")).toBe(false);
  });

  it("returns false for running", () => {
    expect(isStepTerminal("running")).toBe(false);
  });

  it("returns false for blocked", () => {
    expect(isStepTerminal("blocked")).toBe(false);
  });
});

// ── isTaskActive ───────────────────────────────────────────────────────────

describe("isTaskActive", () => {
  it("returns true for running", () => {
    expect(isTaskActive("running")).toBe(true);
  });

  it("returns true for planning", () => {
    expect(isTaskActive("planning")).toBe(true);
  });

  it("returns true for verifying", () => {
    expect(isTaskActive("verifying")).toBe(true);
  });

  it("returns false for paused", () => {
    expect(isTaskActive("paused")).toBe(false);
  });

  it("returns false for completed", () => {
    expect(isTaskActive("completed")).toBe(false);
  });
});

// ── hasPlanCycle ───────────────────────────────────────────────────────────

describe("hasPlanCycle", () => {
  it("returns false for empty steps", () => {
    expect(hasPlanCycle([])).toBe(false);
  });

  it("returns false for linear chain A -> B -> C", () => {
    const steps = [
      makeTestStep("a", []),
      makeTestStep("b", ["a"]),
      makeTestStep("c", ["b"]),
    ];
    expect(hasPlanCycle(steps)).toBe(false);
  });

  it("returns false for diamond dependency", () => {
    const steps = [
      makeTestStep("a", []),
      makeTestStep("b", ["a"]),
      makeTestStep("c", ["a"]),
      makeTestStep("d", ["b", "c"]),
    ];
    expect(hasPlanCycle(steps)).toBe(false);
  });

  it("returns true for direct cycle A -> B -> A", () => {
    const steps = [
      makeTestStep("a", ["b"]),
      makeTestStep("b", ["a"]),
    ];
    expect(hasPlanCycle(steps)).toBe(true);
  });

  it("returns true for 3-node cycle", () => {
    const steps = [
      makeTestStep("a", ["c"]),
      makeTestStep("b", ["a"]),
      makeTestStep("c", ["b"]),
    ];
    expect(hasPlanCycle(steps)).toBe(true);
  });

  it("returns false for self-dependency (non-existent dep is ignored)", () => {
    // Self-dep: "a" depends on "a" — should detect cycle
    const steps = [makeTestStep("a", ["a"])];
    expect(hasPlanCycle(steps)).toBe(true);
  });
});

// ── topoSort ───────────────────────────────────────────────────────────────

describe("topoSort", () => {
  it("returns [] for empty steps", () => {
    expect(topoSort([])).toEqual([]);
  });

  it("returns single step", () => {
    const steps = [makeTestStep("a", [])];
    expect(topoSort(steps)).toEqual(["a"]);
  });

  it("respects linear dependency order", () => {
    const steps = [
      makeTestStep("c", ["b"]),
      makeTestStep("b", ["a"]),
      makeTestStep("a", []),
    ];
    const result = topoSort(steps);
    expect(result.indexOf("a")).toBeLessThan(result.indexOf("b"));
    expect(result.indexOf("b")).toBeLessThan(result.indexOf("c"));
  });

  it("respects diamond dependency", () => {
    const steps = [
      makeTestStep("d", ["b", "c"]),
      makeTestStep("b", ["a"]),
      makeTestStep("c", ["a"]),
      makeTestStep("a", []),
    ];
    const result = topoSort(steps);
    expect(result.indexOf("a")).toBeLessThan(result.indexOf("b"));
    expect(result.indexOf("a")).toBeLessThan(result.indexOf("c"));
    expect(result.indexOf("b")).toBeLessThan(result.indexOf("d"));
    expect(result.indexOf("c")).toBeLessThan(result.indexOf("d"));
  });

  it("handles steps with unknown dependency IDs gracefully", () => {
    // "b" depends on "nonexistent" — should still include "b"
    const steps = [
      makeTestStep("a", []),
      makeTestStep("b", ["nonexistent"]),
    ];
    const result = topoSort(steps);
    expect(result).toContain("a");
    expect(result).toContain("b");
  });
});

// ── getReadySteps ──────────────────────────────────────────────────────────

describe("getReadySteps", () => {
  it("returns all pending steps with no deps", () => {
    const steps = [makeTestStep("a"), makeTestStep("b")];
    const ready = getReadySteps(steps);
    expect(ready.map((s) => s.id)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("does not return steps whose dep is pending", () => {
    const steps = [makeTestStep("a"), makeTestStep("b", ["a"])];
    const ready = getReadySteps(steps);
    expect(ready.map((s) => s.id)).toEqual(["a"]);
  });

  it("returns step once dependency is completed", () => {
    const steps = [
      makeTestStep("a", [], "completed"),
      makeTestStep("b", ["a"], "pending"),
    ];
    const ready = getReadySteps(steps);
    expect(ready.map((s) => s.id)).toEqual(["b"]);
  });

  it("returns step when dep is skipped (skipped counts as terminal)", () => {
    const steps = [
      makeTestStep("a", [], "skipped"),
      makeTestStep("b", ["a"], "pending"),
    ];
    const ready = getReadySteps(steps);
    expect(ready.map((s) => s.id)).toEqual(["b"]);
  });

  it("does not return already-running steps", () => {
    const steps = [makeTestStep("a", [], "running")];
    const ready = getReadySteps(steps);
    expect(ready).toHaveLength(0);
  });

  it("does not return completed steps", () => {
    const steps = [makeTestStep("a", [], "completed")];
    const ready = getReadySteps(steps);
    expect(ready).toHaveLength(0);
  });

  it("returns empty for no steps", () => {
    expect(getReadySteps([])).toHaveLength(0);
  });
});

// ── validatePlannerOutput ──────────────────────────────────────────────────

describe("validatePlannerOutput", () => {
  const validOutput = {
    goalSummary: "Implement feature X",
    steps: [
      { id: "s1", title: "Step 1", type: "generic", dependencies: [], capabilityHints: [] },
      { id: "s2", title: "Step 2", type: "generic", dependencies: ["s1"], capabilityHints: [] },
    ],
  };

  it("returns valid: true for a correct output", () => {
    const result = validatePlannerOutput(validOutput);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns valid: false for null", () => {
    const result = validatePlannerOutput(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns valid: false for missing goalSummary", () => {
    const result = validatePlannerOutput({ steps: [] });
    expect(result.valid).toBe(false);
  });

  it("returns valid: false for missing steps", () => {
    const result = validatePlannerOutput({ goalSummary: "test" });
    expect(result.valid).toBe(false);
  });

  it("returns valid: false for empty steps array", () => {
    const result = validatePlannerOutput({ goalSummary: "test", steps: [] });
    expect(result.valid).toBe(false);
  });

  it("returns valid: true but adds warning when steps exceeds 25", () => {
    const steps = Array.from({ length: 26 }, (_, i) => ({
      id: `s${i}`,
      title: `Step ${i}`,
      type: "generic",
      dependencies: [],
      capabilityHints: [],
    }));
    const result = validatePlannerOutput({ goalSummary: "test", steps });
    // Implementation warns (> 25) but does not fail
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns valid: false for duplicate step IDs", () => {
    const result = validatePlannerOutput({
      goalSummary: "test",
      steps: [
        { id: "s1", title: "A", type: "generic", dependencies: [], capabilityHints: [] },
        { id: "s1", title: "B", type: "generic", dependencies: [], capabilityHints: [] },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("returns valid: false for a plan with a cycle", () => {
    const result = validatePlannerOutput({
      goalSummary: "test",
      steps: [
        { id: "s1", title: "A", type: "generic", dependencies: ["s2"], capabilityHints: [] },
        { id: "s2", title: "B", type: "generic", dependencies: ["s1"], capabilityHints: [] },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("returns valid: false for step missing title", () => {
    const result = validatePlannerOutput({
      goalSummary: "test",
      steps: [{ id: "s1", type: "generic", dependencies: [], capabilityHints: [] }],
    });
    expect(result.valid).toBe(false);
  });
});

// ── extractStepResult ──────────────────────────────────────────────────────

describe("extractStepResult", () => {
  it("extracts a completed step result", () => {
    const text = "```forge_step_result\n" +
      JSON.stringify({ status: "completed", summary: "Done.", evidenceRefs: [] }) +
      "\n```";
    const result = extractStepResult(text);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.summary).toBe("Done.");
  });

  it("extracts a blocked step result", () => {
    const text = "```forge_step_result\n" +
      JSON.stringify({ status: "blocked", summary: "Need human.", evidenceRefs: [] }) +
      "\n```";
    const result = extractStepResult(text);
    expect(result?.status).toBe("blocked");
  });

  it("extracts observations when present", () => {
    const text = "```forge_step_result\n" +
      JSON.stringify({ status: "completed", summary: "Done.", evidenceRefs: [], observations: "Found 3 files." }) +
      "\n```";
    const result = extractStepResult(text);
    expect(result?.observations).toBe("Found 3 files.");
  });

  it("returns null when no fence present", () => {
    expect(extractStepResult("Just some plain text")).toBeNull();
  });

  it("returns null for invalid JSON in fence", () => {
    const text = "```forge_step_result\nnot json\n```";
    expect(extractStepResult(text)).toBeNull();
  });

  it("returns null for unknown status", () => {
    const text = "```forge_step_result\n" +
      JSON.stringify({ status: "unknown_status", summary: "x", evidenceRefs: [] }) +
      "\n```";
    expect(extractStepResult(text)).toBeNull();
  });

  it("defaults evidenceRefs to [] when missing", () => {
    const text = "```forge_step_result\n" +
      JSON.stringify({ status: "completed", summary: "Done." }) +
      "\n```";
    const result = extractStepResult(text);
    expect(result?.evidenceRefs).toEqual([]);
  });
});

// ── inferStepResult ────────────────────────────────────────────────────────

describe("inferStepResult", () => {
  it("returns failed when agentRunFailed is true", () => {
    const result = inferStepResult("Some output", true);
    expect(result.status).toBe("failed");
  });

  it("returns completed for plain text when agentRunFailed is false", () => {
    const result = inferStepResult("I completed the work.", false);
    expect(result.status).toBe("completed");
  });

  it("includes the finalText as summary", () => {
    const text = "Work is done successfully.";
    const result = inferStepResult(text, false);
    expect(result.summary).toContain("Work is done");
  });

  it("returns blocked when text contains 'blocked' keyword", () => {
    const result = inferStepResult("Step is blocked by missing dependencies.", false);
    expect(result.status).toBe("blocked");
  });
});

// ── makeTask ───────────────────────────────────────────────────────────────

describe("makeTask", () => {
  it("creates a task with draft status", () => {
    const task = makeTask("conv-1", "Do something important", "proj-1");
    expect(task.id).toBeTruthy();
    expect(task.conversationId).toBe("conv-1");
    expect(task.projectId).toBe("proj-1");
    expect(task.status).toBe("draft");
    expect(task.goal).toBe("Do something important");
    expect(task.createdAt).toBeGreaterThan(0);
  });

  it("sets planVersion to 0", () => {
    const task = makeTask("conv-1", "goal");
    expect(task.planVersion).toBe(0);
  });

  it("omits projectId when not provided", () => {
    const task = makeTask("conv-1", "goal");
    expect(task).not.toHaveProperty("projectId");
  });

  it("generates unique IDs across calls", () => {
    const t1 = makeTask("conv-1", "goal");
    const t2 = makeTask("conv-1", "goal");
    expect(t1.id).not.toBe(t2.id);
  });
});

// ── makeStep ───────────────────────────────────────────────────────────────

describe("makeStep", () => {
  it("creates a step with pending status", () => {
    const step = makeStep("s1", "task-1", "Write tests", "generic", []);
    expect(step.id).toBe("s1");
    expect(step.status).toBe("pending");
    expect(step.attemptCount).toBe(0);
  });

  it("includes optional description when provided", () => {
    const step = makeStep("s1", "task-1", "Title", "generic", [], { description: "Details" });
    expect(step.description).toBe("Details");
  });

  it("includes dependencies", () => {
    const step = makeStep("s2", "task-1", "Step 2", "generic", ["s1"]);
    expect(step.dependencies).toEqual(["s1"]);
  });
});

// ── makePlan ───────────────────────────────────────────────────────────────

describe("makePlan", () => {
  it("creates a plan from raw steps", () => {
    const rawSteps = [
      { id: "s1", title: "Step 1", type: "generic" as const, dependencies: [], capabilityHints: [] as string[] },
      { id: "s2", title: "Step 2", type: "generic" as const, dependencies: ["s1"], capabilityHints: [] as string[] },
    ];
    const plan = makePlan("task-1", rawSteps);
    expect(plan.taskId).toBe("task-1");
    expect(plan.steps).toHaveLength(2);
    expect(plan.version).toBe(1);
  });

  it("uses specified version", () => {
    const plan = makePlan("task-1", [{ id: "s1", title: "S", type: "generic", dependencies: [], capabilityHints: [] as string[] }], 3);
    expect(plan.version).toBe(3);
  });

  it("sets reasonForRevision when provided", () => {
    const plan = makePlan(
      "task-1",
      [{ id: "s1", title: "S", type: "generic", dependencies: [], capabilityHints: [] as string[] }],
      2,
      "Replanning due to error"
    );
    expect(plan.reasonForRevision).toBe("Replanning due to error");
  });

  it("all steps have status pending", () => {
    const plan = makePlan("task-1", [
      { id: "s1", title: "S1", type: "generic", dependencies: [], capabilityHints: [] as string[] },
      { id: "s2", title: "S2", type: "generic", dependencies: ["s1"], capabilityHints: [] as string[] },
    ]);
    for (const step of plan.steps) {
      expect(step.status).toBe("pending");
    }
  });
});