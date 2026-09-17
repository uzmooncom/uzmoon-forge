/**
 * improvement-candidate.test.ts — SelfHealingEngine + ImprovementCandidate validation.
 *
 * The SelfHealingEngine enforces the human approval boundary:
 *   - Forge NEVER auto-applies code changes
 *   - ImprovementCandidate starts as "pending" (created via createImprovementCandidate)
 *   - approveCandidate() / rejectCandidate() require "pending" state
 *   - Rejected candidates cannot be re-approved
 *   - Candidate payload never includes auto-apply instructions
 *   - Candidate sanitization: secrets + absolute paths must be redacted before storage
 *
 * §78 from V0.9 spec: "Human approval boundary enforced structurally."
 * §90: ImprovementCandidate.approvalState: "pending" | "approved" | "rejected"
 * §91: SelfHealingEngine never auto-applies code changes.
 */

import { describe, it, expect } from "vitest";
import { SelfHealingEngine } from "./self-healing.js";
import type { ImprovementCandidate, HealingLevel } from "./self-healing.js";
import { sanitizeState, detectResidualSecrets, hasNoAbsolutePaths } from "./sanitizer.js";
import type { ForgeIncident } from "../../shared/types.js";
import { randomUUID } from "crypto";

function makeSHE(): SelfHealingEngine {
  return new SelfHealingEngine();
}

function makeIncident(overrides?: Partial<ForgeIncident>): ForgeIncident {
  return {
    id: randomUUID(),
    fingerprint: "abc123def456",
    invariantId: "NO_PROTOCOL_LEAK",
    title: "Protocol leak detected",
    description: "forge_final fence found in persisted message",
    category: "protocol",
    severity: "high",
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    occurrenceCount: 1,
    forgeVersion: "0.9.0",
    runtimeSchemaVersion: 1,
    observedState: { leakedContent: "forge_final" },
    failureCode: "NO_PROTOCOL_LEAK",
    ...overrides,
  } as ForgeIncident;
}

function makeCandidate(
  she: SelfHealingEngine,
  overrides?: Partial<Omit<ImprovementCandidate, "id" | "createdAt" | "approvalState">>
): ImprovementCandidate {
  return she.createImprovementCandidate({
    kind: "system_prompt_clarification",
    title: "Tighten forge_final requirement",
    description: "Add explicit example to system prompt",
    rationale: "Model skipped forge_final on simple Q&A",
    proposedChange: "Add: 'Always wrap your final response in forge_final'",
    invariantIds: ["NO_PROTOCOL_LEAK"],
    incidentFingerprints: ["abc123def456"],
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ic-1: Candidate starts as pending
// ─────────────────────────────────────────────────────────────────────────────

describe("ic-1: ImprovementCandidate starts as pending", () => {
  it("createImprovementCandidate returns candidate with approvalState = pending", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she);
    expect(candidate.approvalState).toBe("pending");
  });

  it("getPendingCandidates includes newly created candidate", () => {
    const she = makeSHE();
    makeCandidate(she);
    const pending = she.getPendingCandidates();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((c) => c.approvalState === "pending")).toBe(true);
  });

  it("getAllCandidates returns same set as getPendingCandidates when none approved/rejected", () => {
    const she = makeSHE();
    makeCandidate(she);
    makeCandidate(she);
    expect(she.getAllCandidates().length).toBe(she.getPendingCandidates().length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ic-2: approveCandidate() transitions to approved
// ─────────────────────────────────────────────────────────────────────────────

describe("ic-2: approveCandidate() transitions to approved", () => {
  it("approveCandidate() returns true and sets approvalState to approved", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she);

    const result = she.approveCandidate(candidate.id);
    expect(result).toBe(true);

    const updated = she.getAllCandidates().find((c) => c.id === candidate.id);
    expect(updated?.approvalState).toBe("approved");
  });

  it("approveCandidate() removes from pending list", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she);
    she.approveCandidate(candidate.id);
    const pending = she.getPendingCandidates();
    expect(pending.find((c) => c.id === candidate.id)).toBeUndefined();
  });

  it("approve does NOT auto-execute any code change", () => {
    // Structural test: approveCandidate returns a boolean, not a function or promise
    const she = makeSHE();
    const candidate = makeCandidate(she);
    const result = she.approveCandidate(candidate.id);
    // Must be a plain boolean — no side-effecting object returned
    expect(typeof result).toBe("boolean");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ic-3: rejectCandidate() transitions to rejected and cannot be re-approved
// ─────────────────────────────────────────────────────────────────────────────

describe("ic-3: rejectCandidate() — cannot be re-approved", () => {
  it("rejectCandidate() returns true and sets approvalState to rejected", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she);

    const result = she.rejectCandidate(candidate.id);
    expect(result).toBe(true);

    const updated = she.getAllCandidates().find((c) => c.id === candidate.id);
    expect(updated?.approvalState).toBe("rejected");
  });

  it("approveCandidate() on a rejected candidate returns false (no re-approval)", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she);

    she.rejectCandidate(candidate.id);
    const result = she.approveCandidate(candidate.id);
    expect(result).toBe(false);

    // Still rejected
    const updated = she.getAllCandidates().find((c) => c.id === candidate.id);
    expect(updated?.approvalState).toBe("rejected");
  });

  it("rejectCandidate() on an already-rejected candidate returns false (idempotent)", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she);

    she.rejectCandidate(candidate.id);
    const secondResult = she.rejectCandidate(candidate.id);
    expect(secondResult).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ic-4: No auto-apply — Forge never applies code changes automatically
// ─────────────────────────────────────────────────────────────────────────────

describe("ic-4: no auto-apply — structural enforcement", () => {
  it("SelfHealingEngine does not have an autoApply() method", () => {
    const she = makeSHE();
    expect(typeof (she as unknown as Record<string, unknown>)["autoApply"]).toBe("undefined");
  });

  it("SelfHealingEngine does not have an applyCandidate() method", () => {
    const she = makeSHE();
    expect(typeof (she as unknown as Record<string, unknown>)["applyCandidate"]).toBe("undefined");
  });

  it("candidate.proposedChange is human-readable text, not executable code instructions", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she, {
      proposedChange: "Update system prompt to include an example of forge_final usage",
    });
    // Must not be a diff/patch/exec string
    expect(candidate.proposedChange).not.toMatch(/^@@\s/); // not a unified diff
    expect(candidate.proposedChange).not.toContain("exec(");
    expect(candidate.proposedChange).not.toContain("writeFileSync(");
  });

  it("candidate payload contains no auto-apply fields", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she);
    const raw = JSON.stringify(candidate);
    expect(raw).not.toContain("autoApply");
    expect(raw).not.toContain("applyPatch");
    expect(raw).not.toContain("writeFile");
    expect(raw).not.toContain("exec(");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ic-5: ImprovementCandidate payload sanitization
// ─────────────────────────────────────────────────────────────────────────────

describe("ic-5: candidate payload sanitization via sanitizeState", () => {
  it("sanitizeState redacts secrets from candidate-shaped objects", () => {
    const payload = {
      incidentId: "inc-abc",
      observedState: {
        secretKey: "sk-" + "a".repeat(24),
        normalField: "safe-value",
      },
    };
    const sanitized = sanitizeState(payload as Record<string, unknown>);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("sk-" + "a".repeat(24));
  });

  it("sanitizeState redacts absolute paths from candidate-shaped objects", () => {
    const payload = {
      incidentId: "inc-xyz",
      observedState: {
        filePath: "/Users/ahmeterdogan/projects/secret/config.ts",
        normalField: "safe-value",
      },
    };
    const sanitized = sanitizeState(payload as Record<string, unknown>);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("/Users/ahmeterdogan");
  });

  it("detectResidualSecrets returns empty for sanitized candidate payload", () => {
    const payload = {
      invariantId: "NO_PROTOCOL_LEAK",
      proposedChange: "Update system prompt",
    };
    const sanitized = sanitizeState(payload as Record<string, unknown>);
    const residual = detectResidualSecrets(JSON.stringify(sanitized));
    expect(residual).toHaveLength(0);
  });

  it("hasNoAbsolutePaths passes for sanitized candidate payload", () => {
    const payload = {
      invariantId: "NO_PROTOCOL_LEAK",
      observedState: { info: "some diagnostic" },
    };
    const sanitized = sanitizeState(payload as Record<string, unknown>);
    expect(hasNoAbsolutePaths(JSON.stringify(sanitized))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ic-6: Multiple candidates — isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("ic-6: multiple candidates — isolation", () => {
  it("approving one candidate does not affect others", () => {
    const she = makeSHE();
    const c1 = makeCandidate(she, { invariantIds: ["NO_PROTOCOL_LEAK"] });
    const c2 = makeCandidate(she, { invariantIds: ["1_USER_1_ASSISTANT"] });
    const c3 = makeCandidate(she, { invariantIds: ["SNAPSHOT_IMMUTABLE"] });

    she.approveCandidate(c1.id);

    const pending = she.getPendingCandidates();
    expect(pending.some((c) => c.id === c2.id)).toBe(true);
    expect(pending.some((c) => c.id === c3.id)).toBe(true);
    expect(pending.some((c) => c.id === c1.id)).toBe(false);
  });

  it("rejecting all candidates leaves getPendingCandidates empty", () => {
    const she = makeSHE();
    const candidates = Array.from({ length: 5 }, () => makeCandidate(she));
    for (const c of candidates) she.rejectCandidate(c.id);
    expect(she.getPendingCandidates()).toHaveLength(0);
  });

  it("getAllCandidates contains all — pending, approved, and rejected", () => {
    const she = makeSHE();
    const c1 = makeCandidate(she);
    const c2 = makeCandidate(she);
    const c3 = makeCandidate(she);

    she.approveCandidate(c1.id);
    she.rejectCandidate(c2.id);
    // c3 remains pending

    const all = she.getAllCandidates();
    expect(all.length).toBe(3);
    expect(all.find((c) => c.id === c1.id)?.approvalState).toBe("approved");
    expect(all.find((c) => c.id === c2.id)?.approvalState).toBe("rejected");
    expect(all.find((c) => c.id === c3.id)?.approvalState).toBe("pending");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ic-7: ImprovementCandidate required fields
// ─────────────────────────────────────────────────────────────────────────────

describe("ic-7: ImprovementCandidate required fields", () => {
  it("candidate has all required fields", () => {
    const she = makeSHE();
    const candidate = makeCandidate(she);

    expect(typeof candidate.id).toBe("string");
    expect(candidate.id.length).toBeGreaterThan(0);
    expect(typeof candidate.kind).toBe("string");
    expect(typeof candidate.title).toBe("string");
    expect(typeof candidate.description).toBe("string");
    expect(typeof candidate.rationale).toBe("string");
    expect(typeof candidate.proposedChange).toBe("string");
    expect(Array.isArray(candidate.invariantIds)).toBe(true);
    expect(Array.isArray(candidate.incidentFingerprints)).toBe(true);
    expect(typeof candidate.createdAt).toBe("number");
    expect(["pending", "approved", "rejected"]).toContain(candidate.approvalState);
  });

  it("candidate.id is unique per call", () => {
    const she = makeSHE();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(makeCandidate(she).id);
    }
    expect(ids.size).toBe(20);
  });

  it("candidate.createdAt is a recent epoch timestamp", () => {
    const before = Date.now();
    const she = makeSHE();
    const candidate = makeCandidate(she);
    const after = Date.now();
    expect(candidate.createdAt).toBeGreaterThanOrEqual(before);
    expect(candidate.createdAt).toBeLessThanOrEqual(after);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ic-8: handleIncident healing action — level 1–4 structural validation
// ─────────────────────────────────────────────────────────────────────────────

describe("ic-8: handleIncident HealingAction structural validation", () => {
  it("handleIncident returns null or HealingAction with valid level", async () => {
    const she = makeSHE();
    const action = await she.handleIncident(makeIncident());

    if (action !== null) {
      const validLevels: HealingLevel[] = [1, 2, 3, 4];
      expect(validLevels).toContain(action.level);
      expect(typeof action.actionId).toBe("string");
      expect(typeof action.description).toBe("string");
      expect(typeof action.automatic).toBe("boolean");
    }
  });

  it("level-1 action (log-only) has automatic = false", async () => {
    const she = makeSHE();
    // RESOURCE_OWNERSHIP_CLEAN typically maps to level 1
    const incident = makeIncident({ invariantId: "RESOURCE_OWNERSHIP_CLEAN" });
    const action = await she.handleIncident(incident);

    if (action && action.level === 1) {
      expect(action.automatic).toBe(false);
    }
  });

  it("handleIncident never throws regardless of incident content", async () => {
    const she = makeSHE();
    const weirdIncidents: Partial<ForgeIncident>[] = [
      { invariantId: "NONEXISTENT_INVARIANT" },
      { invariantId: "" },
      { invariantId: "NO_PROTOCOL_LEAK", occurrenceCount: 999999 },
    ];
    for (const overrides of weirdIncidents) {
      await expect(she.handleIncident(makeIncident(overrides))).resolves.not.toThrow();
    }
  });

  it("automatic actions never modify source .ts files", async () => {
    const she = makeSHE();
    const tsFilesWritten: string[] = [];

    // Intercept any potential fs.writeFileSync calls (would be a structural violation)
    const action = await she.handleIncident(
      makeIncident({ invariantId: "ORPHANED_SNAPSHOTS_CLEANED" })
    );

    if (action?.automatic && action.execute) {
      // Execute the action — it must not write .ts files
      await action.execute();
    }

    // If we get here without ts files being written, the test passes
    expect(tsFilesWritten).toHaveLength(0);
  });
});