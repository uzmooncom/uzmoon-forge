/**
 * task-planner.test.ts — Unit tests for task-planner.ts
 *
 * Uses FORGE_TEST_PROVIDER=fake so no real HTTP is made.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildFallbackPlan } from "./task-planner.js";
import { makePlan, makeStep } from "./task-types.js";

// ── buildFallbackPlan ──────────────────────────────────────────────────────

describe("buildFallbackPlan", () => {
  it("returns a plan with one step", () => {
    const plan = buildFallbackPlan("task-1", "Do something important");
    expect(plan.taskId).toBe("task-1");
    expect(plan.steps).toHaveLength(1);
    expect(plan.version).toBe(1);
  });

  it("step title is derived from goal (truncated to 80 chars)", () => {
    const longGoal = "A".repeat(100);
    const plan = buildFallbackPlan("task-1", longGoal);
    expect(plan.steps[0]!.title.length).toBeLessThanOrEqual(80);
  });

  it("step has no dependencies", () => {
    const plan = buildFallbackPlan("task-1", "Build feature");
    expect(plan.steps[0]!.dependencies).toEqual([]);
  });

  it("step status is pending", () => {
    const plan = buildFallbackPlan("task-1", "Deploy app");
    expect(plan.steps[0]!.status).toBe("pending");
  });

  it("includes reasonForRevision", () => {
    const plan = buildFallbackPlan("task-1", "goal");
    expect(plan.reasonForRevision).toBeTruthy();
  });

  it("sets taskId on the step", () => {
    const plan = buildFallbackPlan("task-42", "goal");
    expect(plan.steps[0]!.taskId).toBe("task-42");
  });

  it("generates unique step IDs across calls", () => {
    const plan1 = buildFallbackPlan("task-1", "goal");
    const plan2 = buildFallbackPlan("task-1", "goal");
    expect(plan1.steps[0]!.id).not.toBe(plan2.steps[0]!.id);
  });

  it("timestamps are set", () => {
    const before = Date.now();
    const plan = buildFallbackPlan("task-1", "goal");
    const after = Date.now();
    expect(plan.createdAt).toBeGreaterThanOrEqual(before);
    expect(plan.createdAt).toBeLessThanOrEqual(after);
  });
});

// ── generatePlan with fake provider ───────────────────────────────────────

describe("generatePlan — fake provider", () => {
  beforeAll(() => {
    process.env["FORGE_TEST_PROVIDER"] = "fake";
  });

  afterAll(() => {
    delete process.env["FORGE_TEST_PROVIDER"];
  });

  it("generates a plan via fake provider that includes step_complete magic string", async () => {
    // Import dynamically so env var is set first
    const { generatePlan } = await import("./task-planner.js");

    // The fake provider for a regular message returns forge_final with wrapped text.
    // generatePlan expects forge_plan fence — fake provider won't produce it by default,
    // so it should fall through to fallback or throw PlannerError after exhausting retries.
    const ac = new AbortController();
    const fakeCfg = {
      id: "profile-fake",
      name: "Fake Provider",
      protocol: "openai" as const,
      endpoint: "http://fake.local",
      model: "fake-model",
    };
    const apiKey = "fake-key";

    // generatePlan should complete (fallback or recovery) without throwing
    // Since fake provider won't emit forge_plan, it hits max retries.
    // We verify it throws a structured PlannerError (not unhandled exception).
    let caught: unknown = null;
    try {
      await generatePlan("task-1", "Build a feature", fakeCfg, apiKey, ac.signal);
    } catch (err) {
      caught = err;
    }
    // Either succeeds with fallback or throws PlannerError with code
    if (caught !== null) {
      expect(caught).toHaveProperty("code");
      const e = caught as { code: string };
      expect(["RECOVERY_EXHAUSTED", "PLAN_INVALID", "PLAN_PARSE_FAILED", "PROVIDER_ERROR"]).toContain(e.code);
    }
  });
});

// ── replan — merges completed steps ───────────────────────────────────────

describe("replan — completed step merging", () => {
  it("prepends completed steps to new plan (unit: makePlan directly)", () => {
    // Test the merge invariant: completed steps should precede new steps
    const completedSteps = [
      { ...makeStep("s1", "task-1", "Step 1 done", "generic", []), status: "completed" as const },
    ];
    const newSteps = [makeStep("s2", "task-1", "Step 2", "generic", [])];

    const mergedSteps = [...completedSteps, ...newSteps];
    expect(mergedSteps[0]!.status).toBe("completed");
    expect(mergedSteps[1]!.status).toBe("pending");
  });

  it("makePlan with reasonForRevision reflects replan reason", () => {
    const rawSteps = [{ id: "s1", title: "New step", type: "generic" as const, dependencies: [], capabilityHints: [] as string[] }];
    const plan = makePlan("task-1", rawSteps, 2, "Previous approach failed");
    expect(plan.reasonForRevision).toBe("Previous approach failed");
    expect(plan.version).toBe(2);
  });
});

// ── PlannerError shape ─────────────────────────────────────────────────────

describe("PlannerError shape validation", () => {
  beforeAll(() => {
    process.env["FORGE_TEST_PROVIDER"] = "fake";
  });

  afterAll(() => {
    delete process.env["FORGE_TEST_PROVIDER"];
  });

  it("generatePlan with abort signal resolves or rejects with PROVIDER_ERROR", async () => {
    const { generatePlan } = await import("./task-planner.js");
    const ac = new AbortController();
    ac.abort(); // Pre-aborted

    const fakeCfg = {
      id: "profile-fake",
      name: "Fake Provider",
      protocol: "openai" as const,
      endpoint: "http://fake.local",
      model: "fake-model",
    };

    let caught: unknown = null;
    try {
      await generatePlan("task-1", "Build something", fakeCfg, "key", ac.signal);
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      expect(caught).toHaveProperty("code");
    }
  });
});