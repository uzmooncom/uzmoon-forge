/**
 * task-state-machine.test.ts
 * Covers: isTaskTerminal, isStepTerminal, isTaskActive, hasPlanCycle, topoSort,
 *         getReadySteps (including interrupted), validatePlannerOutput,
 *         extractStepResult, inferStepResult, makeTask, makeStep, makePlan
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

// ── isTaskTerminal ────────────────────────────────────────────────────────

describe("isTaskTerminal", () => {
  it("returns true for completed", () => expect(isTaskTerminal("completed")).toBe(true));
  it("returns true for failed",    () => expect(isTaskTerminal("failed")).toBe(true));
  it("returns true for cancelled", () => expect(isTaskTerminal("cancelled")).toBe(true));
  it("returns false for running",  () => expect(isTaskTerminal("running")).toBe(false));
  it("returns false for paused",   () => expect(isTaskTerminal("paused")).toBe(false));
  it("returns false for planning", () => expect(isTaskTerminal("planning")).toBe(false));
  it("returns false for verifying",() => expect(isTaskTerminal("verifying")).toBe(false));
  it("returns false for draft",    () => expect(isTaskTerminal("draft")).toBe(false));
});

// ── isStepTerminal ────────────────────────────────────────────────────────

describe("isStepTerminal", () => {
  it("returns true for completed",   () => expect(isStepTerminal("completed")).toBe(true));
  it("returns true for failed",      () => expect(isStepTerminal("failed")).toBe(true));
  it("returns true for skipped",     () => expect(isStepTerminal("skipped")).toBe(true));
  it("returns true for cancelled",   () => expect(isStepTerminal("cancelled")).toBe(true));
  it("returns false for blocked",    () => expect(isStepTerminal("blocked")).toBe(false)); // blocked is not in TERMINAL_STEP_STATUSES
  it("returns false for running",    () => expect(isStepTerminal("running")).toBe(false));
  it("returns false for pending",    () => expect(isStepTerminal("pending")).toBe(false));
  it("returns false for interrupted",() => expect(isStepTerminal("interrupted")).toBe(false));
});

// ── isTaskActive ──────────────────────────────────────────────────────────

describe("isTaskActive", () => {
  it("returns true for running",   () => expect(isTaskActive("running")).toBe(true));
  it("returns true for planning",  () => expect(isTaskActive("planning")).toBe(true));
  it("returns true for verifying", () => expect(isTaskActive("verifying")).toBe(true));
  it("returns false for paused",   () => expect(isTaskActive("paused")).toBe(false));
  it("returns false for completed",() => expect(isTaskActive("completed")).toBe(false));
});

// ── hasPlanCycle ──────────────────────────────────────────────────────────

describe("hasPlanCycle", () => {
  it("returns false for empty steps", () => {
    expect(hasPlanCycle([])).toBe(false);
  });

  it("returns false for linear dependency chain", () => {
    const steps: ForgeTaskStep[] = [
      makeStep("s1", "t1", "Step 1", "generic", [], {}),
      makeStep("s2", "t1", "Step 2", "generic", ["s1"], {}),
      makeStep("s3", "t1", "Step 3", "generic", ["s2"], {}),
    ];
    expect(hasPlanCycle(steps)).toBe(false);
  });

  it("returns true for direct cycle A → B → A", () => {
    const a = makeStep("sA", "t1", "A", "generic", ["sB"], {});
    const b = makeStep("sB", "t1", "B", "generic", ["sA"], {});
    expect(hasPlanCycle([a, b])).toBe(true);
  });

  it("returns false for parallel independent steps", () => {
    const steps: ForgeTaskStep[] = [
      makeStep("s1", "t1", "S1", "generic", [], {}),
      makeStep("s2", "t1", "S2", "generic", [], {}),
    ];
    expect(hasPlanCycle(steps)).toBe(false);
  });
});

// ── topoSort ──────────────────────────────────────────────────────────────

describe("topoSort", () => {
  it("sorts steps in dependency order", () => {
    const steps: ForgeTaskStep[] = [
      makeStep("s3", "t1", "S3", "generic", ["s2"], {}),
      makeStep("s1", "t1", "S1", "generic", [], {}),
      makeStep("s2", "t1", "S2", "generic", ["s1"], {}),
    ];
    const order = topoSort(steps);
    const s1Idx = order.indexOf("s1");
    const s2Idx = order.indexOf("s2");
    const s3Idx = order.indexOf("s3");
    expect(s1Idx).toBeLessThan(s2Idx);
    expect(s2Idx).toBeLessThan(s3Idx);
  });
});

// ── getReadySteps ─────────────────────────────────────────────────────────

describe("getReadySteps", () => {
  it("returns pending steps with no dependencies", () => {
    const steps: ForgeTaskStep[] = [
      makeStep("s1", "t1", "S1", "generic", [], {}),
    ];
    expect(getReadySteps(steps)).toHaveLength(1);
    expect(getReadySteps(steps)[0]!.id).toBe("s1");
  });

  it("returns pending step when all dependencies are completed", () => {
    const steps: ForgeTaskStep[] = [
      { ...makeStep("s1", "t1", "S1", "generic", [], {}), status: "completed" },
      makeStep("s2", "t1", "S2", "generic", ["s1"], {}),
    ];
    const ready = getReadySteps(steps);
    expect(ready.map(s => s.id)).toContain("s2");
  });

  it("does NOT return pending step when dependency is not complete", () => {
    const steps: ForgeTaskStep[] = [
      makeStep("s1", "t1", "S1", "generic", [], {}),
      makeStep("s2", "t1", "S2", "generic", ["s1"], {}),
    ];
    const ready = getReadySteps(steps);
    expect(ready.map(s => s.id)).not.toContain("s2");
  });

  it("treats 'interrupted' steps as retryable (ready)", () => {
    const steps: ForgeTaskStep[] = [
      {
        ...makeStep("s1", "t1", "S1", "generic", [], {}),
        status: "interrupted",
      },
    ];
    const ready = getReadySteps(steps);
    expect(ready.map(s => s.id)).toContain("s1");
  });

  it("does NOT return running steps", () => {
    const steps: ForgeTaskStep[] = [
      {
        ...makeStep("s1", "t1", "S1", "generic", [], {}),
        status: "running",
      },
    ];
    expect(getReadySteps(steps)).toHaveLength(0);
  });

  it("does NOT return completed/failed/blocked steps", () => {
    const terminal: ForgeTaskStep[] = ["completed", "failed", "blocked", "cancelled", "skipped"].map(
      (st, i) => ({ ...makeStep(`s${i}`, "t1", `S${i}`, "generic", [], {}), status: st as ForgeTaskStep["status"] })
    );
    expect(getReadySteps(terminal)).toHaveLength(0);
  });
});

// ── validatePlannerOutput ─────────────────────────────────────────────────

describe("validatePlannerOutput", () => {
  const validOutput = {
    goalSummary: "Build a feature",
    steps: [
      { id: "s1", title: "Research", type: "generic", dependencies: [], capabilityHints: ["filesystem"] },
      { id: "s2", title: "Implement", type: "generic", dependencies: ["s1"], capabilityHints: ["filesystem"] },
    ],
  };

  it("accepts valid output", () => {
    const result = validatePlannerOutput(validOutput);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects missing goalSummary", () => {
    const result = validatePlannerOutput({ steps: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects step missing capabilityHints", () => {
    const bad = {
      goalSummary: "g",
      steps: [{ id: "s1", title: "X", type: "generic", dependencies: [] }],
    };
    const result = validatePlannerOutput(bad);
    expect(result.valid).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validatePlannerOutput(null).valid).toBe(false);
    expect(validatePlannerOutput("string").valid).toBe(false);
    expect(validatePlannerOutput(42).valid).toBe(false);
  });

  it("warns but does not fail for 26-step plan (above warning threshold)", () => {
    const steps = Array.from({ length: 26 }, (_, i) => ({
      id: `s${i}`,
      title: `Step ${i}`,
      type: "generic",
      dependencies: i === 0 ? [] : [`s${i - 1}`],
      capabilityHints: ["filesystem"],
    }));
    const result = validatePlannerOutput({ goalSummary: "big plan", steps });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ── extractStepResult ─────────────────────────────────────────────────────

describe("extractStepResult", () => {
  it("parses a valid forge_step_result fence", () => {
    const text = [
      "Some intro text",
      "```forge_step_result",
      JSON.stringify({ status: "completed", summary: "All done", evidenceRefs: [] }),
      "```",
    ].join("\n");
    const result = extractStepResult(text);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("completed");
    expect(result?.summary).toBe("All done");
  });

  it("returns null when no fence present", () => {
    expect(extractStepResult("No fence here")).toBeNull();
  });

  it("returns null for invalid JSON inside fence", () => {
    const text = "```forge_step_result\ninvalid json\n```";
    expect(extractStepResult(text)).toBeNull();
  });

  it("parses status: replan_required", () => {
    const text = [
      "```forge_step_result",
      JSON.stringify({ status: "replan_required", summary: "Cannot proceed" }),
      "```",
    ].join("\n");
    const result = extractStepResult(text);
    expect(result?.status).toBe("replan_required");
  });
});

// ── inferStepResult ───────────────────────────────────────────────────────

describe("inferStepResult", () => {
  it("returns failed result when agentRunFailed is true", () => {
    const result = inferStepResult("Something went wrong", true);
    expect(result.status).toBe("failed");
  });

  it("detects blocked keywords in text", () => {
    const result = inferStepResult("I cannot proceed without credentials", false);
    expect(["blocked", "needs_replan", "failed"]).toContain(result.status);
  });

  it("returns completed for normal prose with no failure signals", () => {
    const result = inferStepResult("The task was completed successfully.", false);
    expect(result.status).toBe("completed");
  });
});

// ── makeTask ──────────────────────────────────────────────────────────────

describe("makeTask", () => {
  it("creates a task with required fields", () => {
    const task = makeTask("conv-1", "Build the feature");
    expect(task.conversationId).toBe("conv-1");
    expect(task.goal).toBe("Build the feature");
    expect(task.status).toBe("draft");
    expect(task.planVersion).toBe(0);
  });

  it("sets requiresVerification: false and verificationPolicy: 'none' by default", () => {
    const task = makeTask("conv-1", "Test goal");
    expect(task.requiresVerification).toBe(false);
    expect(task.verificationPolicy).toBe("none");
  });

  it("accepts optional projectId and triggerMessageId", () => {
    const task = makeTask("conv-1", "goal", "proj-1", "msg-42");
    expect(task.metadata).toBeDefined();
  });

  it("generates a unique id each call", () => {
    const t1 = makeTask("conv-1", "g");
    const t2 = makeTask("conv-1", "g");
    expect(t1.id).not.toBe(t2.id);
  });
});

// ── makePlan ──────────────────────────────────────────────────────────────

describe("makePlan", () => {
  it("creates a plan with version 1", () => {
    const plan = makePlan("task-1", [
      { id: "s1", title: "Step 1", type: "generic" as const, dependencies: [], capabilityHints: [] },
    ]);
    expect(plan.taskId).toBe("task-1");
    expect(plan.version).toBe(1);
    expect(plan.steps).toHaveLength(1);
  });

  it("creates steps with correct taskId", () => {
    const plan = makePlan("my-task", [
      { id: "s1", title: "S1", type: "generic" as const, dependencies: [], capabilityHints: ["filesystem"] },
    ]);
    expect(plan.steps[0]!.taskId).toBe("my-task");
  });
});
// ── inferStepResult — adversarial negation guard ──────────────────────────

describe("inferStepResult — adversarial negation guard", () => {
  it("positive: 'cannot proceed' → blocked", () => {
    const r = inferStepResult("I cannot proceed with this step.", false);
    expect(r.status).toBe("blocked");
  });

  it("positive: 'requires human' → blocked", () => {
    const r = inferStepResult("This requires human verification before continuing.", false);
    expect(r.status).toBe("blocked");
  });

  it("positive: 'blocked by' pattern → blocked", () => {
    const r = inferStepResult("Step is blocked by missing authentication token.", false);
    expect(r.status).toBe("blocked");
  });

  it("positive: 'missing credential' → blocked", () => {
    const r = inferStepResult("Missing credential for GitHub API access.", false);
    expect(r.status).toBe("blocked");
  });

  // Adversarial — negation guard must prevent false positives
  it("adversarial: 'Nothing is blocked anymore' → completed (not blocked)", () => {
    const r = inferStepResult("Nothing is blocked anymore, everything is working.", false);
    expect(r.status).toBe("completed");
  });

  it("adversarial: 'no longer blocked' → completed", () => {
    const r = inferStepResult("The issue is no longer blocked after the fix was applied.", false);
    expect(r.status).toBe("completed");
  });

  it("adversarial: 'not blocked' → completed", () => {
    const r = inferStepResult("We are not blocked — the PR has been merged.", false);
    expect(r.status).toBe("completed");
  });

  it("adversarial: 'We do not need to replan' → completed (not replan_required)", () => {
    // inferStepResult does not produce replan_required from text, but the adversarial
    // pattern of negated language should still produce completed
    const r = inferStepResult("We do not need to replan. The current steps are sufficient.", false);
    expect(r.status).toBe("completed");
  });

  it("adversarial: 'The previous attempt failed but the fix works' → completed", () => {
    const r = inferStepResult(
      "The previous attempt failed, but the fix now works correctly. All tests pass.",
      false
    );
    // Past-tense failure in subordinate clause — current outcome is completed
    expect(r.status).toBe("completed");
  });

  it("adversarial: 'cannot be blocked' → completed (negated modal)", () => {
    const r = inferStepResult("The workflow cannot be blocked by this configuration.", false);
    // 'cannot be blocked' has 'cannot be' before 'blocked' — negation applies
    expect(r.status).toBe("completed");
  });

  it("agentRunFailed=true always → failed (overrides text content)", () => {
    const r = inferStepResult("Step completed successfully with all evidence attached.", true);
    expect(r.status).toBe("failed");
  });

  it("empty text + agentRunFailed=false → completed", () => {
    const r = inferStepResult("", false);
    expect(r.status).toBe("completed");
  });
});
