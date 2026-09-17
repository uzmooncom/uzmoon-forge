/**
 * replay.test.ts — ReplayHarness and fixture validation tests.
 */

import { describe, it, expect } from "vitest";
import {
  ReplayHarness,
  ALL_FIXTURES,
  REPLAY_SCHEMA_VERSION,
  FIXTURE_SIMPLE_FINAL,
  FIXTURE_PROTOCOL_RECOVERY_THEN_FINAL,
  FIXTURE_RECOVERY_EXHAUSTED,
  FIXTURE_PROVIDER_DISCONNECT,
  FIXTURE_MULTI_BLOCK_PROPOSAL,
  FIXTURE_TOOL_BUDGET_EXHAUSTED,
  FIXTURE_GLOBAL_CHAT_PROSE,
  FIXTURE_MALFORMED_FINAL_ENVELOPE,
  FIXTURE_MULTIPLE_FINAL_ENVELOPES,
  FIXTURE_EMPTY_FINAL_CONTENT,
  FIXTURE_PROVIDER_IGNORES_THEN_RECOVERS,
} from "./replay.js";

describe("ALL_FIXTURES manifest", () => {
  it("exports at least 11 fixtures", () => {
    expect(ALL_FIXTURES.length).toBeGreaterThanOrEqual(11);
  });

  it("all fixtures have unique IDs", () => {
    const ids = ALL_FIXTURES.map((f) => f.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it("all fixtures have correct schema version", () => {
    for (const f of ALL_FIXTURES) {
      expect(f.schemaVersion, `Fixture ${f.id} has wrong schemaVersion`).toBe(REPLAY_SCHEMA_VERSION);
    }
  });

  it("all fixtures have non-empty name, description, and userMessage", () => {
    for (const f of ALL_FIXTURES) {
      expect(f.name.trim().length, `Fixture ${f.id}: empty name`).toBeGreaterThan(0);
      expect(f.description.trim().length, `Fixture ${f.id}: empty description`).toBeGreaterThan(0);
      expect(f.userMessage.trim().length, `Fixture ${f.id}: empty userMessage`).toBeGreaterThan(0);
    }
  });

  it("all fixtures have at least one turn", () => {
    for (const f of ALL_FIXTURES) {
      expect(f.turns.length, `Fixture ${f.id}: no turns`).toBeGreaterThan(0);
    }
  });

  it("all fixtures have valid protocol", () => {
    const validProtocols = new Set(["openai_native", "anthropic_native", "forge_fallback"]);
    for (const f of ALL_FIXTURES) {
      expect(validProtocols.has(f.protocol), `Fixture ${f.id}: invalid protocol ${f.protocol}`).toBe(true);
    }
  });

  it("all fixtures have valid expectedOutcome", () => {
    const validOutcomes = new Set(["completed", "failed", "cancelled"]);
    for (const f of ALL_FIXTURES) {
      expect(
        validOutcomes.has(f.expectedOutcome),
        `Fixture ${f.id}: invalid outcome ${f.expectedOutcome}`,
      ).toBe(true);
    }
  });

  it("failed fixtures with expectedFailureCode have a valid string code", () => {
    // Some failed fixtures omit expectedFailureCode when exact code is not checked
    for (const f of ALL_FIXTURES) {
      if (f.expectedOutcome === "failed" && f.expectedFailureCode !== undefined) {
        expect(
          typeof f.expectedFailureCode,
          `Fixture ${f.id}: expectedFailureCode must be a string`,
        ).toBe("string");
        expect(
          f.expectedFailureCode.length,
          `Fixture ${f.id}: expectedFailureCode must be non-empty`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("Individual fixture validation", () => {
  it("FIXTURE_SIMPLE_FINAL — isProjectMode + forge_final on first turn", () => {
    expect(FIXTURE_SIMPLE_FINAL.isProjectMode).toBe(true);
    expect(FIXTURE_SIMPLE_FINAL.turns.length).toBe(1);
    expect(FIXTURE_SIMPLE_FINAL.turns[0]!.text).toContain("forge_final");
    expect(FIXTURE_SIMPLE_FINAL.expectedOutcome).toBe("completed");
    expect(FIXTURE_SIMPLE_FINAL.invariantIds).toContain("SIMPLE_FINAL_WITHOUT_TOOLS");
    expect(FIXTURE_SIMPLE_FINAL.forbiddenContentPatterns).toContain("forge_final");
  });

  it("FIXTURE_PROTOCOL_RECOVERY_THEN_FINAL — 3 turns, ends with forge_final", () => {
    expect(FIXTURE_PROTOCOL_RECOVERY_THEN_FINAL.isProjectMode).toBe(true);
    expect(FIXTURE_PROTOCOL_RECOVERY_THEN_FINAL.turns.length).toBe(3);
    const lastTurn = FIXTURE_PROTOCOL_RECOVERY_THEN_FINAL.turns[2]!;
    expect(lastTurn.text).toContain("forge_final");
    expect(FIXTURE_PROTOCOL_RECOVERY_THEN_FINAL.expectedOutcome).toBe("completed");
  });

  it("FIXTURE_RECOVERY_EXHAUSTED — 4 turns of naked prose, should fail", () => {
    expect(FIXTURE_RECOVERY_EXHAUSTED.expectedOutcome).toBe("failed");
    expect(FIXTURE_RECOVERY_EXHAUSTED.expectedFailureCode).toBe("PROTOCOL_RECOVERY_EXHAUSTED");
    expect(FIXTURE_RECOVERY_EXHAUSTED.turns.length).toBe(4);
    // None of the turns should have forge_final
    for (const turn of FIXTURE_RECOVERY_EXHAUSTED.turns) {
      expect(turn.text).not.toContain("forge_final");
    }
    expect(FIXTURE_RECOVERY_EXHAUSTED.invariantIds).toContain("RECOVERY_BOUNDED");
  });

  it("FIXTURE_PROVIDER_DISCONNECT — first turn is disconnect", () => {
    expect(FIXTURE_PROVIDER_DISCONNECT.turns[0]!.disconnect).toBe(true);
    expect(FIXTURE_PROVIDER_DISCONNECT.expectedOutcome).toBe("failed");
    expect(FIXTURE_PROVIDER_DISCONNECT.expectedFailureCode).toBe("PROVIDER_ERROR");
    expect(FIXTURE_PROVIDER_DISCONNECT.invariantIds).toContain("PROVIDER_DISCONNECT_HANDLED");
  });

  it("FIXTURE_MULTI_BLOCK_PROPOSAL — two forge_edit_proposal blocks in single turn", () => {
    const firstTurn = FIXTURE_MULTI_BLOCK_PROPOSAL.turns[0]!.text;
    const count = (firstTurn.match(/```forge_edit_proposal/g) ?? []).length;
    expect(count).toBe(2);
    expect(FIXTURE_MULTI_BLOCK_PROPOSAL.expectedOutcome).toBe("completed");
    expect(FIXTURE_MULTI_BLOCK_PROPOSAL.invariantIds).toContain("INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES");
  });

  it("FIXTURE_TOOL_BUDGET_EXHAUSTED — 25 forge_tool turns + 1 forge_final", () => {
    // 25 tool turns + 1 finalization turn = 26 total
    expect(FIXTURE_TOOL_BUDGET_EXHAUSTED.turns.length).toBe(26);
    expect(FIXTURE_TOOL_BUDGET_EXHAUSTED.turns[25]!.text).toContain("forge_final");
    expect(FIXTURE_TOOL_BUDGET_EXHAUSTED.expectedOutcome).toBe("completed");
    expect(FIXTURE_TOOL_BUDGET_EXHAUSTED.invariantIds).toContain("TOOL_BUDGET_ENFORCED");
  });

  it("FIXTURE_GLOBAL_CHAT_PROSE — isProjectMode=false, accepts naked prose", () => {
    expect(FIXTURE_GLOBAL_CHAT_PROSE.isProjectMode).toBe(false);
    expect(FIXTURE_GLOBAL_CHAT_PROSE.expectedOutcome).toBe("completed");
    expect(FIXTURE_GLOBAL_CHAT_PROSE.forbiddenContentPatterns).toContain("forge_tool");
    expect(FIXTURE_GLOBAL_CHAT_PROSE.forbiddenContentPatterns).toContain("forge_final");
  });

  it("FIXTURE_MALFORMED_FINAL_ENVELOPE — first turn malformed JSON, second valid", () => {
    expect(FIXTURE_MALFORMED_FINAL_ENVELOPE.turns[0]!.text).toContain("{broken json");
    expect(FIXTURE_MALFORMED_FINAL_ENVELOPE.turns[1]!.text).toContain("forge_final");
    expect(FIXTURE_MALFORMED_FINAL_ENVELOPE.expectedOutcome).toBe("completed");
  });

  it("FIXTURE_MULTIPLE_FINAL_ENVELOPES — two forge_final blocks, non-recoverable failure", () => {
    const text = FIXTURE_MULTIPLE_FINAL_ENVELOPES.turns[0]!.text;
    const count = (text.match(/```forge_final/g) ?? []).length;
    expect(count).toBe(2);
    expect(FIXTURE_MULTIPLE_FINAL_ENVELOPES.expectedOutcome).toBe("failed");
  });

  it("FIXTURE_EMPTY_FINAL_CONTENT — empty content, then valid", () => {
    expect(FIXTURE_EMPTY_FINAL_CONTENT.turns[0]!.text).toContain('"content": ""');
    expect(FIXTURE_EMPTY_FINAL_CONTENT.turns[1]!.text).toContain("forge_final");
    expect(FIXTURE_EMPTY_FINAL_CONTENT.expectedOutcome).toBe("completed");
  });

  it("FIXTURE_PROVIDER_IGNORES_THEN_RECOVERS — naked prose then forge_final", () => {
    expect(FIXTURE_PROVIDER_IGNORES_THEN_RECOVERS.turns[0]!.text).not.toContain("forge_final");
    expect(FIXTURE_PROVIDER_IGNORES_THEN_RECOVERS.turns[1]!.text).toContain("forge_final");
    expect(FIXTURE_PROVIDER_IGNORES_THEN_RECOVERS.expectedOutcome).toBe("completed");
    expect(FIXTURE_PROVIDER_IGNORES_THEN_RECOVERS.invariantIds).toContain("RECOVERY_BOUNDED");
  });
});

describe("ReplayHarness", () => {
  const harness = new ReplayHarness();

  it("getFixture() returns fixture by ID", () => {
    const f = harness.getFixture("regression_simple_final");
    expect(f).toBeDefined();
    expect(f!.id).toBe("regression_simple_final");
  });

  it("getFixture() returns undefined for unknown ID", () => {
    expect(harness.getFixture("unknown_fixture_xyz")).toBeUndefined();
  });

  it("getAllFixtures() returns all fixtures", () => {
    const all = harness.getAllFixtures();
    expect(all.length).toBe(ALL_FIXTURES.length);
  });

  it("getAllFixtures() returns a copy (mutations don't affect internal state)", () => {
    const copy = harness.getAllFixtures();
    copy.push({} as never);
    expect(harness.getAllFixtures().length).toBe(ALL_FIXTURES.length);
  });

  describe("validateResult()", () => {
    it("returns passed=true when actual matches expected", () => {
      const fixture = FIXTURE_RECOVERY_EXHAUSTED;
      const result = harness.validateResult(fixture, {
        outcome: "failed",
        failureCode: "PROTOCOL_RECOVERY_EXHAUSTED",
        messagesProduced: 2,
        recoveryTriggered: 3,
        toolStepsConsumed: 0,
        invariantViolations: [],
      });
      expect(result.passed).toBe(true);
      expect(result.failureReason).toBeUndefined();
    });

    it("returns passed=false when outcome mismatches", () => {
      const fixture = FIXTURE_RECOVERY_EXHAUSTED;
      const result = harness.validateResult(fixture, {
        outcome: "completed", // wrong
        messagesProduced: 2,
        recoveryTriggered: 3,
        toolStepsConsumed: 0,
        invariantViolations: [],
      });
      expect(result.passed).toBe(false);
      expect(result.failureReason).toContain("Outcome mismatch");
    });

    it("returns passed=false when failureCode mismatches", () => {
      const fixture = FIXTURE_RECOVERY_EXHAUSTED;
      const result = harness.validateResult(fixture, {
        outcome: "failed",
        failureCode: "PROVIDER_ERROR", // wrong code
        messagesProduced: 2,
        recoveryTriggered: 3,
        toolStepsConsumed: 0,
        invariantViolations: [],
      });
      expect(result.passed).toBe(false);
      expect(result.failureReason).toContain("FailureCode mismatch");
    });

    it("returns passed=false when message count mismatches", () => {
      const fixture = FIXTURE_RECOVERY_EXHAUSTED;
      const result = harness.validateResult(fixture, {
        outcome: "failed",
        failureCode: "PROTOCOL_RECOVERY_EXHAUSTED",
        messagesProduced: 5, // wrong
        recoveryTriggered: 3,
        toolStepsConsumed: 0,
        invariantViolations: [],
      });
      expect(result.passed).toBe(false);
      expect(result.failureReason).toContain("Message count mismatch");
    });

    it("returns passed=false when expected invariant violation did not fire", () => {
      const fixture: typeof FIXTURE_SIMPLE_FINAL = {
        ...FIXTURE_SIMPLE_FINAL,
        expectedInvariantViolations: ["RECOVERY_BOUNDED"],
      };
      const result = harness.validateResult(fixture, {
        outcome: "completed",
        messagesProduced: 2,
        recoveryTriggered: 0,
        toolStepsConsumed: 0,
        invariantViolations: [], // missing RECOVERY_BOUNDED
      });
      expect(result.passed).toBe(false);
      expect(result.failureReason).toContain("RECOVERY_BOUNDED");
    });

    it("accumulates multiple failure reasons", () => {
      const fixture = FIXTURE_RECOVERY_EXHAUSTED;
      const result = harness.validateResult(fixture, {
        outcome: "completed",     // wrong
        failureCode: "CANCELLED", // wrong
        messagesProduced: 99,     // wrong
        recoveryTriggered: 0,
        toolStepsConsumed: 0,
        invariantViolations: [],
      });
      expect(result.passed).toBe(false);
      // Should contain multiple reasons joined by "; "
      expect(result.failureReason!.split(";").length).toBeGreaterThanOrEqual(3);
    });

    it("includes fixtureId in result", () => {
      const fixture = FIXTURE_SIMPLE_FINAL;
      const result = harness.validateResult(fixture, {
        outcome: "completed",
        messagesProduced: 2,
        recoveryTriggered: 0,
        toolStepsConsumed: 0,
        invariantViolations: [],
      });
      expect(result.fixtureId).toBe(fixture.id);
    });
  });
});

describe("ReplayHarness with custom fixtures", () => {
  it("accepts custom fixture list", () => {
    const customFixture = {
      ...FIXTURE_SIMPLE_FINAL,
      id: "custom_fixture_001",
    };
    const harness = new ReplayHarness([customFixture]);
    expect(harness.getAllFixtures().length).toBe(1);
    expect(harness.getFixture("custom_fixture_001")).toBeDefined();
    expect(harness.getFixture("regression_simple_final")).toBeUndefined();
  });
});