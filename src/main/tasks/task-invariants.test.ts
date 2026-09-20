/**
 * task-invariants.test.ts — Unit tests for task-invariants.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { registerTaskInvariants } from "./task-invariants.js";
import { getInvariant, getAllInvariants } from "../reliability/invariants.js";

// Register once before tests
beforeAll(() => {
  registerTaskInvariants();
});

const EXPECTED_TASK_INVARIANT_IDS = [
  "TASK_CURRENT_STEP_BELONGS_TO_TASK",
  "READY_STEP_DEPENDENCIES_COMPLETE",
  "ONE_ACTIVE_STEP_PER_TASK_V1",
  "TASK_COMPLETE_REQUIRES_VERIFICATION_WHEN_REQUIRED",
  "TASK_BUDGET_STEPS_NOT_EXCEEDED",
  "TASK_BUDGET_REVISIONS_NOT_EXCEEDED",
  "TASK_STALLED",
  "TASK_TERMINAL_EXACTLY_ONCE",
  "TASK_PLAN_NO_CYCLES",
  "TASK_PLAN_STEP_IDS_UNIQUE",
  "TASK_COMPLETED_STEPS_IMMUTABLE",
];

describe("registerTaskInvariants", () => {
  it("registers all 11 task invariants", () => {
    const all = getAllInvariants();
    const taskInvariants = all.filter((inv) => inv.category === "TASK_RUNTIME");
    expect(taskInvariants.length).toBeGreaterThanOrEqual(11);
  });

  it("is idempotent — calling twice does not throw", () => {
    expect(() => registerTaskInvariants()).not.toThrow();
  });

  for (const id of EXPECTED_TASK_INVARIANT_IDS) {
    it(`registers invariant ${id}`, () => {
      const inv = getInvariant(id);
      expect(inv).toBeDefined();
      expect(inv!.id).toBe(id);
      expect(inv!.category).toBe("TASK_RUNTIME");
    });
  }

  it("all task invariants have valid severity", () => {
    const taskInvariants = getAllInvariants().filter((inv) => inv.category === "TASK_RUNTIME");
    for (const inv of taskInvariants) {
      expect(["low", "medium", "high", "critical"]).toContain(inv.severity);
    }
  });

  it("all task invariants have maxHealingLevel of 1", () => {
    const taskInvariants = getAllInvariants().filter((inv) => inv.category === "TASK_RUNTIME");
    for (const inv of taskInvariants) {
      expect(inv.maxHealingLevel).toBe(1);
    }
  });

  it("structural invariants are critical severity", () => {
    const criticalIds = [
      "TASK_CURRENT_STEP_BELONGS_TO_TASK",
      "ONE_ACTIVE_STEP_PER_TASK_V1",
      "TASK_TERMINAL_EXACTLY_ONCE",
      "TASK_PLAN_NO_CYCLES",
      "TASK_PLAN_STEP_IDS_UNIQUE",
      "TASK_COMPLETED_STEPS_IMMUTABLE",
      "READY_STEP_DEPENDENCIES_COMPLETE",
    ];
    for (const id of criticalIds) {
      const inv = getInvariant(id);
      expect(inv?.severity).toBe("critical");
    }
  });

  it("budget and stall invariants are high severity", () => {
    const highIds = [
      "TASK_BUDGET_STEPS_NOT_EXCEEDED",
      "TASK_BUDGET_REVISIONS_NOT_EXCEEDED",
      "TASK_STALLED",
      "TASK_COMPLETE_REQUIRES_VERIFICATION_WHEN_REQUIRED",
    ];
    for (const id of highIds) {
      const inv = getInvariant(id);
      expect(inv?.severity).toBe("high");
    }
  });

  it("all task invariants have non-empty descriptions", () => {
    const taskInvariants = getAllInvariants().filter((inv) => inv.category === "TASK_RUNTIME");
    for (const inv of taskInvariants) {
      expect(inv.description.length).toBeGreaterThan(0);
    }
  });
});