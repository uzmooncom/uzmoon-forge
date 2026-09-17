/**
 * invariants.test.ts — Canonical Invariant Registry tests.
 */

import { describe, it, expect, vi } from "vitest";
import {
  getAllInvariants,
  getInvariant,
  assertInvariant,
  assertInvariantStrict,
  registerViolationHandler,
  INV_ONE_RUN_ONE_VISIBLE_FAILURE,
  INV_TERMINAL_TURN_ONLY,
  INV_RECOVERY_BOUNDED,
  INV_STATE_TRANSITIONS_VALID,
  INV_TOOL_BUDGET_ENFORCED,
  INV_SIMPLE_FINAL_WITHOUT_TOOLS,
  INV_NO_CROSS_RUN_CONTAMINATION,
  INV_SNAPSHOT_IMMUTABLE,
  INV_INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES,
  INV_STALE_BASE_PROTECTION,
  INV_APPLY_REQUIRES_APPROVAL,
  INV_EDIT_AMBIGUITY_BLOCKED,
  INV_NO_SECRET_IN_INCIDENT,
  INV_NO_ABSOLUTE_PATH_IN_REPORT,
  INV_NO_AUTO_CRITICAL_SELF_MODIFICATION,
} from "./invariants.js";
import type { InvariantViolation } from "./invariants.js";

describe("Invariant Registry", () => {
  it("should register all expected invariants", () => {
    const all = getAllInvariants();
    const ids = all.map((d) => d.id);

    const requiredIds = [
      "ONE_RUN_ONE_VISIBLE_FAILURE",
      "TERMINAL_TURN_ONLY",
      "RECOVERY_BOUNDED",
      "STATE_TRANSITIONS_VALID",
      "TOOL_BUDGET_ENFORCED",
      "SIMPLE_FINAL_WITHOUT_TOOLS",
      "NO_CROSS_RUN_CONTAMINATION",
      "STREAM_ID_FILTER_ENFORCED",
      "NAVIGATION_STATE_RESTORED",
      "NO_STALE_HYDRATION_OVERWRITE",
      "1_USER_1_ASSISTANT",
      "NO_PROTOCOL_LEAK",
      "SNAPSHOT_IMMUTABLE",
      "ORPHANED_SNAPSHOTS_CLEANED",
      "RESOURCE_OWNERSHIP_CLEAN",
      "INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES",
      "STALE_BASE_PROTECTION",
      "APPLY_REQUIRES_APPROVAL",
      "EDIT_AMBIGUITY_BLOCKED",
      "ROLLBACK_CORRECTNESS",
      "PROVIDER_DISCONNECT_HANDLED",
      "NAKED_PROSE_PROJECT_MODE_BLOCKED",
      "NO_SECRET_IN_INCIDENT",
      "NO_ABSOLUTE_PATH_IN_REPORT",
      "NO_PROMPT_IN_REPORT",
      "NO_AUTO_CRITICAL_SELF_MODIFICATION",
      "STREAM_EVENT_ROUTING",
    ];

    for (const id of requiredIds) {
      expect(ids, `Missing invariant: ${id}`).toContain(id);
    }
  });

  it("should have no duplicate invariant IDs", () => {
    const all = getAllInvariants();
    const ids = all.map((d) => d.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it("should look up invariant by ID", () => {
    const def = getInvariant("ONE_RUN_ONE_VISIBLE_FAILURE");
    expect(def).toBeDefined();
    expect(def!.id).toBe("ONE_RUN_ONE_VISIBLE_FAILURE");
    expect(def!.category).toBe("AGENT_RUNTIME");
    expect(def!.severity).toBe("high");
  });

  it("should return undefined for unknown invariant ID", () => {
    expect(getInvariant("NONEXISTENT_XYZ")).toBeUndefined();
  });

  it("should assign valid severities to all invariants", () => {
    const validSeverities = new Set(["critical", "high", "medium", "low"]);
    for (const def of getAllInvariants()) {
      expect(validSeverities.has(def.severity), `Bad severity for ${def.id}: ${def.severity}`).toBe(true);
    }
  });

  it("should assign valid healing levels (1-4) to all invariants", () => {
    for (const def of getAllInvariants()) {
      expect([1, 2, 3, 4]).toContain(def.maxHealingLevel);
    }
  });

  it("should mark security invariants as critical or high severity", () => {
    const securityInvariants = [
      "NO_SECRET_IN_INCIDENT",
      "NO_ABSOLUTE_PATH_IN_REPORT",
      "NO_AUTO_CRITICAL_SELF_MODIFICATION",
      "APPLY_REQUIRES_APPROVAL",
      "STALE_BASE_PROTECTION",
      "INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES",
    ];
    for (const id of securityInvariants) {
      const def = getInvariant(id);
      expect(def, `Missing security invariant: ${id}`).toBeDefined();
      expect(
        ["critical", "high"].includes(def!.severity),
        `Security invariant ${id} must be critical or high, got ${def!.severity}`,
      ).toBe(true);
    }
  });

  it("should mark NO_AUTO_CRITICAL_SELF_MODIFICATION as maxHealingLevel 1", () => {
    const def = getInvariant("NO_AUTO_CRITICAL_SELF_MODIFICATION");
    expect(def!.maxHealingLevel).toBe(1);
  });
});

describe("assertInvariant — passing condition", () => {
  it("returns true and does not fire violation handler when condition is true", () => {
    const handler = vi.fn();
    registerViolationHandler(handler);

    const result = assertInvariant(
      "ONE_RUN_ONE_VISIBLE_FAILURE",
      true,
      { test: "passing" },
    );
    expect(result).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns false and fires violation handler when condition is false", () => {
    const violations: InvariantViolation[] = [];
    registerViolationHandler((v) => violations.push(v));

    const result = assertInvariant(
      "RECOVERY_BOUNDED",
      false,
      { recoveryCount: 10, max: 3 },
      { requestId: "req-123", conversationId: "conv-456" },
    );

    expect(result).toBe(false);
    expect(violations.length).toBe(1);
    expect(violations[0]!.invariantId).toBe("RECOVERY_BOUNDED");
    expect(violations[0]!.observedState).toEqual({ recoveryCount: 10, max: 3 });
    expect(violations[0]!.requestId).toBe("req-123");
    expect(violations[0]!.conversationId).toBe("conv-456");
    expect(violations[0]!.timestamp).toBeGreaterThan(0);
  });
});

describe("assertInvariantStrict", () => {
  it("does not throw when condition is true", () => {
    expect(() =>
      assertInvariantStrict("SNAPSHOT_IMMUTABLE", true, { hash: "abc" })
    ).not.toThrow();
  });

  it("throws with invariant ID and description when condition is false", () => {
    expect(() =>
      assertInvariantStrict("EDIT_AMBIGUITY_BLOCKED", false, {
        actualOccurrences: 3,
        expectedOccurrences: 1,
      })
    ).toThrow(/EDIT_AMBIGUITY_BLOCKED/);
  });
});

describe("Specific invariant properties", () => {
  it("INV_ONE_RUN_ONE_VISIBLE_FAILURE is AGENT_RUNTIME/high", () => {
    expect(INV_ONE_RUN_ONE_VISIBLE_FAILURE.category).toBe("AGENT_RUNTIME");
    expect(INV_ONE_RUN_ONE_VISIBLE_FAILURE.severity).toBe("high");
  });

  it("INV_RECOVERY_BOUNDED is AGENT_RUNTIME/critical", () => {
    expect(INV_RECOVERY_BOUNDED.category).toBe("AGENT_RUNTIME");
    expect(INV_RECOVERY_BOUNDED.severity).toBe("critical");
  });

  it("INV_INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES is SAFE_EDITING/critical", () => {
    expect(INV_INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES.category).toBe("SAFE_EDITING");
    expect(INV_INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES.severity).toBe("critical");
  });

  it("INV_STALE_BASE_PROTECTION is SAFE_EDITING/critical", () => {
    expect(INV_STALE_BASE_PROTECTION.category).toBe("SAFE_EDITING");
    expect(INV_STALE_BASE_PROTECTION.severity).toBe("critical");
  });

  it("INV_NO_CROSS_RUN_CONTAMINATION is CONCURRENCY/critical", () => {
    expect(INV_NO_CROSS_RUN_CONTAMINATION.category).toBe("CONCURRENCY");
    expect(INV_NO_CROSS_RUN_CONTAMINATION.severity).toBe("critical");
  });

  it("INV_APPLY_REQUIRES_APPROVAL is SAFE_EDITING/critical/maxHealingLevel 1", () => {
    expect(INV_APPLY_REQUIRES_APPROVAL.severity).toBe("critical");
    expect(INV_APPLY_REQUIRES_APPROVAL.maxHealingLevel).toBe(1);
  });

  it("INV_SNAPSHOT_IMMUTABLE is RESOURCE_LIFECYCLE/critical", () => {
    expect(INV_SNAPSHOT_IMMUTABLE.category).toBe("RESOURCE_LIFECYCLE");
    expect(INV_SNAPSHOT_IMMUTABLE.severity).toBe("critical");
  });

  it("INV_SIMPLE_FINAL_WITHOUT_TOOLS is PROTOCOL/high", () => {
    expect(INV_SIMPLE_FINAL_WITHOUT_TOOLS.category).toBe("PROTOCOL");
    expect(INV_SIMPLE_FINAL_WITHOUT_TOOLS.severity).toBe("high");
  });

  it("INV_TERMINAL_TURN_ONLY is AGENT_RUNTIME/high", () => {
    expect(INV_TERMINAL_TURN_ONLY.category).toBe("AGENT_RUNTIME");
    expect(INV_TERMINAL_TURN_ONLY.severity).toBe("high");
  });

  it("INV_STATE_TRANSITIONS_VALID is AGENT_RUNTIME/critical", () => {
    expect(INV_STATE_TRANSITIONS_VALID.category).toBe("AGENT_RUNTIME");
    expect(INV_STATE_TRANSITIONS_VALID.severity).toBe("critical");
  });

  it("INV_TOOL_BUDGET_ENFORCED is AGENT_RUNTIME/critical", () => {
    expect(INV_TOOL_BUDGET_ENFORCED.category).toBe("AGENT_RUNTIME");
    expect(INV_TOOL_BUDGET_ENFORCED.severity).toBe("critical");
  });

  it("INV_NO_SECRET_IN_INCIDENT is SECURITY_INVARIANT/critical/maxHealingLevel 1", () => {
    expect(INV_NO_SECRET_IN_INCIDENT.category).toBe("SECURITY_INVARIANT");
    expect(INV_NO_SECRET_IN_INCIDENT.severity).toBe("critical");
    expect(INV_NO_SECRET_IN_INCIDENT.maxHealingLevel).toBe(1);
  });

  it("INV_NO_ABSOLUTE_PATH_IN_REPORT is SECURITY_INVARIANT/high", () => {
    expect(INV_NO_ABSOLUTE_PATH_IN_REPORT.category).toBe("SECURITY_INVARIANT");
    expect(INV_NO_ABSOLUTE_PATH_IN_REPORT.severity).toBe("high");
  });

  it("INV_NO_AUTO_CRITICAL_SELF_MODIFICATION is SECURITY_INVARIANT/critical/level 1", () => {
    expect(INV_NO_AUTO_CRITICAL_SELF_MODIFICATION.category).toBe("SECURITY_INVARIANT");
    expect(INV_NO_AUTO_CRITICAL_SELF_MODIFICATION.severity).toBe("critical");
    expect(INV_NO_AUTO_CRITICAL_SELF_MODIFICATION.maxHealingLevel).toBe(1);
  });

  it("INV_EDIT_AMBIGUITY_BLOCKED is SAFE_EDITING/critical", () => {
    expect(INV_EDIT_AMBIGUITY_BLOCKED.category).toBe("SAFE_EDITING");
    expect(INV_EDIT_AMBIGUITY_BLOCKED.severity).toBe("critical");
  });
});