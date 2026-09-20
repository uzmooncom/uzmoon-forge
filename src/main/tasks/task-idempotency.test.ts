/**
 * task-idempotency.test.ts
 * Covers: isStepAlreadyDispatched, markStepDispatched, clearStepDispatch,
 *         clearTaskDispatches, _resetIdempotencyRegistryForTest
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  isStepAlreadyDispatched,
  markStepDispatched,
  clearStepDispatch,
  clearTaskDispatches,
  _resetIdempotencyRegistryForTest,
} from "./step-idempotency.js";

const T = "task-1";
const S = "step-1";

beforeEach(() => {
  _resetIdempotencyRegistryForTest();
});

// ── Basic dispatch tracking ───────────────────────────────────────────────

describe("isStepAlreadyDispatched / markStepDispatched", () => {
  it("returns false before marking", () => {
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(false);
  });

  it("returns true after marking", () => {
    markStepDispatched(T, S, 1);
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(true);
  });

  it("tracks (task, step, attempt) independently — different attempt", () => {
    markStepDispatched(T, S, 1);
    // attempt 2 is not marked
    expect(isStepAlreadyDispatched(T, S, 2)).toBe(false);
  });

  it("tracks (task, step, attempt) independently — different step", () => {
    markStepDispatched(T, S, 1);
    expect(isStepAlreadyDispatched(T, "step-2", 1)).toBe(false);
  });

  it("tracks (task, step, attempt) independently — different task", () => {
    markStepDispatched(T, S, 1);
    expect(isStepAlreadyDispatched("task-2", S, 1)).toBe(false);
  });

  it("marking twice is idempotent (no error, still returns true)", () => {
    markStepDispatched(T, S, 1);
    markStepDispatched(T, S, 1);
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(true);
  });
});

// ── clearStepDispatch ─────────────────────────────────────────────────────

describe("clearStepDispatch", () => {
  it("removes the dispatch record for the specific attempt", () => {
    markStepDispatched(T, S, 1);
    clearStepDispatch(T, S, 1);
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(false);
  });

  it("does not affect other attempts for the same step", () => {
    markStepDispatched(T, S, 1);
    markStepDispatched(T, S, 2);
    clearStepDispatch(T, S, 1);
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(false);
    expect(isStepAlreadyDispatched(T, S, 2)).toBe(true);
  });

  it("is safe to call on a key that was never registered", () => {
    expect(() => clearStepDispatch(T, S, 99)).not.toThrow();
  });
});

// ── clearTaskDispatches ───────────────────────────────────────────────────

describe("clearTaskDispatches", () => {
  it("removes all dispatch records for the given task", () => {
    markStepDispatched(T, "s1", 1);
    markStepDispatched(T, "s2", 1);
    markStepDispatched(T, "s1", 2);
    clearTaskDispatches(T);
    expect(isStepAlreadyDispatched(T, "s1", 1)).toBe(false);
    expect(isStepAlreadyDispatched(T, "s2", 1)).toBe(false);
    expect(isStepAlreadyDispatched(T, "s1", 2)).toBe(false);
  });

  it("does not affect records from a different task", () => {
    markStepDispatched(T, S, 1);
    markStepDispatched("task-other", S, 1);
    clearTaskDispatches(T);
    expect(isStepAlreadyDispatched("task-other", S, 1)).toBe(true);
  });

  it("is safe to call on a task with no records", () => {
    expect(() => clearTaskDispatches("nonexistent-task")).not.toThrow();
  });
});

// ── _resetIdempotencyRegistryForTest ──────────────────────────────────────

describe("_resetIdempotencyRegistryForTest", () => {
  it("clears all records across tasks", () => {
    markStepDispatched("t1", "s1", 1);
    markStepDispatched("t2", "s2", 3);
    _resetIdempotencyRegistryForTest();
    expect(isStepAlreadyDispatched("t1", "s1", 1)).toBe(false);
    expect(isStepAlreadyDispatched("t2", "s2", 3)).toBe(false);
  });
});

// ── Interaction: mark → clear → re-dispatch ───────────────────────────────

describe("re-dispatch after interrupted", () => {
  it("allows re-dispatch of same step+attempt after clear (resume pattern)", () => {
    markStepDispatched(T, S, 1);
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(true);

    // Step gets interrupted → clear dispatch record for safe re-entry
    clearStepDispatch(T, S, 1);
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(false);

    // Re-dispatched on resume
    markStepDispatched(T, S, 1);
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(true);
  });

  it("allows new attempt (attempt+1) without clearing old attempt", () => {
    markStepDispatched(T, S, 1);
    // New attempt doesn't require clearing old one
    expect(isStepAlreadyDispatched(T, S, 2)).toBe(false);
    markStepDispatched(T, S, 2);
    expect(isStepAlreadyDispatched(T, S, 2)).toBe(true);
    // Old attempt still tracked
    expect(isStepAlreadyDispatched(T, S, 1)).toBe(true);
  });
});