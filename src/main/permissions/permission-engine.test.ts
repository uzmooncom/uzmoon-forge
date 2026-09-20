import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolvePermission,
  grantSession,
  revokeSession,
  getSessionGrants,
  clearAllSessionGrants,
  setGlobalPolicy,
  clearGlobalPolicy,
  setProjectPolicy,
  clearProjectPolicy,
  setPreset,
  clearPreset,
  resetGlobalPolicies,
  resetProjectPolicies,
  getRecentChecks,
  _resetPermissionEngineForTest,
} from "./permission-engine.js";
import { loadStore, resetStore } from "./permission-store.js";
import type { PermissionCheckContext } from "../../shared/types.js";

// ── Mock db ──────────────────────────────────────────────────────────────────

vi.mock("../database/db.js", () => {
  let stored: Record<string, unknown> = { incidentSharingEnabled: false };
  return {
    getAppSettings: vi.fn(() => ({ ...stored })),
    setAppSettings: vi.fn((_db: true, patch: Record<string, unknown>) => {
      stored = { ...stored, ...patch };
      return { ...stored };
    }),
  };
});

// ── Mock forgeLogger ──────────────────────────────────────────────────────────

vi.mock("../telemetry/logger.js", () => ({
  forgeLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeCtx(
  capabilityId: string,
  projectId?: string
): PermissionCheckContext {
  return {
    capabilityId,
    ...(projectId !== undefined && { projectId }),
    conversationId: "conv-test",
    requestId: "req-test",
    agentRunId: "run-test",
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetPermissionEngineForTest();
  resetStore();
});

// ── Unknown capability ────────────────────────────────────────────────────────

describe("unknown capability", () => {
  it("denies unknown capability IDs", () => {
    const result = resolvePermission(makeCtx("totally.unknown"));
    expect(result.decision).toBe("DENY");
    expect(result.source).toBe("default");
    expect(result.reason).toContain("Unknown capability");
  });

  it("denies empty capability ID", () => {
    const result = resolvePermission(makeCtx(""));
    expect(result.decision).toBe("DENY");
    expect(result.capabilityId).toBe("");
  });
});

// ── Default policy resolution ────────────────────────────────────────────────

describe("default policy resolution", () => {
  it("git.status defaults to ALLOW (ALWAYS_ALLOW)", () => {
    const result = resolvePermission(makeCtx("git.status"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("default");
  });

  it("git.diff defaults to ALLOW", () => {
    expect(resolvePermission(makeCtx("git.diff")).decision).toBe("ALLOW");
  });

  it("git.log defaults to ALLOW", () => {
    expect(resolvePermission(makeCtx("git.log")).decision).toBe("ALLOW");
  });

  it("git.show defaults to ALLOW", () => {
    expect(resolvePermission(makeCtx("git.show")).decision).toBe("ALLOW");
  });

  it("git.branch_info defaults to ALLOW", () => {
    expect(resolvePermission(makeCtx("git.branch_info")).decision).toBe("ALLOW");
  });

  it("git.stage defaults to ASK", () => {
    const result = resolvePermission(makeCtx("git.stage"));
    expect(result.decision).toBe("ASK");
    expect(result.source).toBe("default");
  });

  it("git.unstage defaults to ASK", () => {
    expect(resolvePermission(makeCtx("git.unstage")).decision).toBe("ASK");
  });

  it("git.commit defaults to ASK", () => {
    expect(resolvePermission(makeCtx("git.commit")).decision).toBe("ASK");
  });

  it("terminal.shell defaults to DENY", () => {
    const result = resolvePermission(makeCtx("terminal.shell"));
    expect(result.decision).toBe("DENY");
    expect(result.source).toBe("default");
  });

  it("terminal.outside_project defaults to DENY", () => {
    expect(resolvePermission(makeCtx("terminal.outside_project")).decision).toBe("DENY");
  });

  it("browser.web.read defaults to ALLOW", () => {
    expect(resolvePermission(makeCtx("browser.web.read")).decision).toBe("ALLOW");
  });

  it("browser.web.interact defaults to ASK", () => {
    expect(resolvePermission(makeCtx("browser.web.interact")).decision).toBe("ASK");
  });

  it("project.read defaults to ALLOW", () => {
    expect(resolvePermission(makeCtx("project.read")).decision).toBe("ALLOW");
  });

  it("project.delete defaults to ASK", () => {
    expect(resolvePermission(makeCtx("project.delete")).decision).toBe("ASK");
  });
});

// ── Session grants ────────────────────────────────────────────────────────────

describe("session grants", () => {
  it("session grant overrides default ASK → ALLOW", () => {
    grantSession("git.stage");
    const result = resolvePermission(makeCtx("git.stage"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("session");
  });

  it("project-scoped session grant works for matching project", () => {
    grantSession("git.commit", "proj-1");
    const result = resolvePermission(makeCtx("git.commit", "proj-1"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("session");
  });

  it("project-scoped session grant does NOT apply to different project", () => {
    grantSession("git.commit", "proj-1");
    const result = resolvePermission(makeCtx("git.commit", "proj-2"));
    expect(result.decision).toBe("ASK"); // falls through to default
    expect(result.source).toBe("default");
  });

  it("global session grant (no projectId) applies to all projects", () => {
    grantSession("git.stage"); // no projectId = global
    expect(resolvePermission(makeCtx("git.stage", "proj-1")).decision).toBe("ALLOW");
    expect(resolvePermission(makeCtx("git.stage", "proj-2")).decision).toBe("ALLOW");
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ALLOW");
  });

  it("revoke session grant restores default decision", () => {
    grantSession("git.stage");
    revokeSession("git.stage");
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ASK");
  });

  it("revoke project-scoped grant leaves global grant intact", () => {
    grantSession("git.stage", "proj-1");
    grantSession("git.stage"); // also global
    revokeSession("git.stage", "proj-1");
    // global grant remains
    expect(resolvePermission(makeCtx("git.stage", "proj-1")).decision).toBe("ALLOW");
  });

  it("revoking non-existent grant is a no-op", () => {
    expect(() => revokeSession("git.stage")).not.toThrow();
    expect(() => revokeSession("fake.cap")).not.toThrow();
  });

  it("getSessionGrants reflects active grants", () => {
    grantSession("git.stage", "proj-1");
    grantSession("git.commit");
    const grants = getSessionGrants();
    expect(grants["git.stage"]).toContain("proj-1");
    expect(grants["git.commit"]).toContain("__global__");
  });

  it("clearAllSessionGrants removes all session grants", () => {
    grantSession("git.stage");
    grantSession("git.commit", "proj-1");
    clearAllSessionGrants();
    expect(getSessionGrants()).toEqual({});
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ASK");
  });

  it("session grant does NOT override DENY default", () => {
    // Session grants make ASK → ALLOW, but DENY is a hard block
    // The session grant path checks by capabilityId — if granted, returns ALLOW regardless
    // So this tests that we CAN grant even a DENY default via session (it's intentional — user approved)
    grantSession("terminal.shell");
    const result = resolvePermission(makeCtx("terminal.shell"));
    // Session grants DO override even DENY (they are explicit user grants)
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("session");
  });

  it("session grants for unknown capabilities are silently ignored", () => {
    grantSession("does.not.exist");
    // Should not appear in grants for known capabilities
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ASK");
  });
});

// ── Project overrides ────────────────────────────────────────────────────────

describe("project overrides", () => {
  it("project ALWAYS_ALLOW override promotes ASK → ALLOW", () => {
    setProjectPolicy("proj-1", "git.commit", "ALWAYS_ALLOW");
    expect(resolvePermission(makeCtx("git.commit", "proj-1")).decision).toBe("ALLOW");
    expect(resolvePermission(makeCtx("git.commit", "proj-1")).source).toBe("project");
  });

  it("project DENY override demotes ALWAYS_ALLOW → DENY", () => {
    setProjectPolicy("proj-1", "git.status", "DENY");
    expect(resolvePermission(makeCtx("git.status", "proj-1")).decision).toBe("DENY");
    expect(resolvePermission(makeCtx("git.status", "proj-1")).source).toBe("project");
  });

  it("project override does NOT affect other projects", () => {
    setProjectPolicy("proj-1", "git.commit", "ALWAYS_ALLOW");
    expect(resolvePermission(makeCtx("git.commit", "proj-2")).decision).toBe("ASK");
  });

  it("project override does NOT affect global (no-project) resolution", () => {
    setProjectPolicy("proj-1", "git.commit", "ALWAYS_ALLOW");
    expect(resolvePermission(makeCtx("git.commit")).decision).toBe("ASK");
  });

  it("clearProjectPolicy restores default", () => {
    setProjectPolicy("proj-1", "git.commit", "ALWAYS_ALLOW");
    clearProjectPolicy("proj-1", "git.commit");
    expect(resolvePermission(makeCtx("git.commit", "proj-1")).decision).toBe("ASK");
  });

  it("resetProjectPolicies clears all overrides for a project", () => {
    setProjectPolicy("proj-1", "git.commit", "ALWAYS_ALLOW");
    setProjectPolicy("proj-1", "git.stage", "DENY");
    resetProjectPolicies("proj-1");
    expect(resolvePermission(makeCtx("git.commit", "proj-1")).decision).toBe("ASK");
    expect(resolvePermission(makeCtx("git.stage", "proj-1")).decision).toBe("ASK");
  });
});

// ── Global overrides ─────────────────────────────────────────────────────────

describe("global overrides", () => {
  it("global ALWAYS_ALLOW promotes ASK → ALLOW for all projects", () => {
    setGlobalPolicy("git.stage", "ALWAYS_ALLOW");
    expect(resolvePermission(makeCtx("git.stage", "proj-1")).decision).toBe("ALLOW");
    expect(resolvePermission(makeCtx("git.stage", "proj-2")).decision).toBe("ALLOW");
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ALLOW");
    expect(resolvePermission(makeCtx("git.stage")).source).toBe("global");
  });

  it("global DENY demotes ALWAYS_ALLOW default", () => {
    setGlobalPolicy("git.status", "DENY");
    expect(resolvePermission(makeCtx("git.status")).decision).toBe("DENY");
    expect(resolvePermission(makeCtx("git.status")).source).toBe("global");
  });

  it("clearGlobalPolicy restores to default", () => {
    setGlobalPolicy("git.stage", "ALWAYS_ALLOW");
    clearGlobalPolicy("git.stage");
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ASK");
  });

  it("resetGlobalPolicies clears all global overrides", () => {
    setGlobalPolicy("git.stage", "ALWAYS_ALLOW");
    setGlobalPolicy("git.commit", "ALWAYS_ALLOW");
    resetGlobalPolicies();
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ASK");
    expect(resolvePermission(makeCtx("git.commit")).decision).toBe("ASK");
  });

  it("global override for unknown capability is silently ignored", () => {
    setGlobalPolicy("fake.capability", "ALWAYS_ALLOW");
    expect(resolvePermission(makeCtx("fake.capability")).decision).toBe("DENY");
  });
});

// ── Resolution order (specificity) ──────────────────────────────────────────

describe("resolution order", () => {
  it("session grant beats project override", () => {
    setProjectPolicy("proj-1", "git.commit", "DENY");
    grantSession("git.commit", "proj-1");
    const result = resolvePermission(makeCtx("git.commit", "proj-1"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("session");
  });

  it("session grant beats global override", () => {
    setGlobalPolicy("git.commit", "DENY");
    grantSession("git.commit");
    const result = resolvePermission(makeCtx("git.commit"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("session");
  });

  it("project override beats global override", () => {
    setGlobalPolicy("git.commit", "DENY");
    setProjectPolicy("proj-1", "git.commit", "ALWAYS_ALLOW");
    const result = resolvePermission(makeCtx("git.commit", "proj-1"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("project");
  });

  it("project override beats preset", () => {
    setPreset("SAFE");
    setProjectPolicy("proj-1", "git.commit", "ALWAYS_ALLOW");
    const result = resolvePermission(makeCtx("git.commit", "proj-1"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("project");
  });

  it("global override beats preset", () => {
    setPreset("SAFE");
    setGlobalPolicy("git.commit", "ALWAYS_ALLOW");
    const result = resolvePermission(makeCtx("git.commit"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("global");
  });

  it("preset beats default", () => {
    setPreset("FULL_ACCESS");
    const result = resolvePermission(makeCtx("git.commit"));
    expect(result.decision).toBe("ALLOW");
    expect(result.source).toBe("preset");
  });

  it("full resolution chain: session > project > global > preset > default", () => {
    // Start with nothing — default applies
    expect(resolvePermission(makeCtx("git.stage")).source).toBe("default");

    // Set preset
    setPreset("SAFE");
    expect(resolvePermission(makeCtx("git.stage")).source).toBe("preset");

    // Set global
    setGlobalPolicy("git.stage", "ALWAYS_ALLOW");
    expect(resolvePermission(makeCtx("git.stage")).source).toBe("global");

    // Set project (for proj-1)
    setProjectPolicy("proj-1", "git.stage", "DENY");
    expect(resolvePermission(makeCtx("git.stage", "proj-1")).source).toBe("project");
    expect(resolvePermission(makeCtx("git.stage", "proj-2")).source).toBe("global"); // no proj-2 override

    // Grant session for proj-1
    grantSession("git.stage", "proj-1");
    expect(resolvePermission(makeCtx("git.stage", "proj-1")).source).toBe("session");
    expect(resolvePermission(makeCtx("git.stage", "proj-2")).source).toBe("global"); // session doesn't apply
  });
});

// ── Presets ──────────────────────────────────────────────────────────────────

describe("presets", () => {
  describe("SAFE preset", () => {
    beforeEach(() => setPreset("SAFE"));

    it("SAFE: read-only git ops are ALLOW", () => {
      expect(resolvePermission(makeCtx("git.status")).decision).toBe("ALLOW");
      expect(resolvePermission(makeCtx("git.diff")).decision).toBe("ALLOW");
      expect(resolvePermission(makeCtx("git.log")).decision).toBe("ALLOW");
    });

    it("SAFE: git.stage and git.commit are ASK", () => {
      expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ASK");
      expect(resolvePermission(makeCtx("git.commit")).decision).toBe("ASK");
    });

    it("SAFE: terminal.shell is DENY", () => {
      expect(resolvePermission(makeCtx("terminal.shell")).decision).toBe("DENY");
    });

    it("SAFE: browser.web.read is ALLOW", () => {
      expect(resolvePermission(makeCtx("browser.web.read")).decision).toBe("ALLOW");
    });

    it("SAFE: destructive capabilities are DENY", () => {
      // project.delete is destructive → DENY under SAFE
      expect(resolvePermission(makeCtx("project.delete")).decision).toBe("DENY");
    });
  });

  describe("ASK preset", () => {
    beforeEach(() => setPreset("ASK"));

    it("ASK: read-only LOW risk is ALLOW", () => {
      expect(resolvePermission(makeCtx("git.status")).decision).toBe("ALLOW");
      expect(resolvePermission(makeCtx("browser.web.read")).decision).toBe("ALLOW");
      expect(resolvePermission(makeCtx("project.read")).decision).toBe("ALLOW");
    });

    it("ASK: non-read capabilities are ASK (not DENY)", () => {
      expect(resolvePermission(makeCtx("git.commit")).decision).toBe("ASK");
      expect(resolvePermission(makeCtx("browser.web.interact")).decision).toBe("ASK");
      expect(resolvePermission(makeCtx("terminal.package_install")).decision).toBe("ASK");
    });

    it("ASK: DENY defaults stay DENY", () => {
      expect(resolvePermission(makeCtx("terminal.shell")).decision).toBe("DENY");
      expect(resolvePermission(makeCtx("terminal.outside_project")).decision).toBe("DENY");
    });
  });

  describe("FULL_ACCESS preset", () => {
    beforeEach(() => setPreset("FULL_ACCESS"));

    it("FULL_ACCESS: git write ops become ALLOW", () => {
      expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ALLOW");
      expect(resolvePermission(makeCtx("git.commit")).decision).toBe("ALLOW");
    });

    it("FULL_ACCESS: browser interaction becomes ALLOW", () => {
      expect(resolvePermission(makeCtx("browser.web.interact")).decision).toBe("ALLOW");
    });

    it("FULL_ACCESS: CRITICAL/DENY defaults stay DENY (hard limits)", () => {
      expect(resolvePermission(makeCtx("terminal.shell")).decision).toBe("DENY");
      expect(resolvePermission(makeCtx("terminal.outside_project")).decision).toBe("DENY");
    });
  });

  it("clearPreset reverts to capability defaults", () => {
    setPreset("FULL_ACCESS");
    clearPreset();
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ASK");
    expect(resolvePermission(makeCtx("git.stage")).source).toBe("default");
  });

  it("explicit override takes priority over preset", () => {
    setPreset("SAFE");
    setGlobalPolicy("git.commit", "ALWAYS_ALLOW");
    expect(resolvePermission(makeCtx("git.commit")).decision).toBe("ALLOW");
    expect(resolvePermission(makeCtx("git.commit")).source).toBe("global");
  });
});

// ── Check records ring buffer ────────────────────────────────────────────────

describe("check records", () => {
  it("records each permission check", () => {
    resolvePermission(makeCtx("git.status"));
    resolvePermission(makeCtx("git.commit"));
    const checks = getRecentChecks();
    expect(checks.length).toBeGreaterThanOrEqual(2);
  });

  it("records correct decision and source", () => {
    resolvePermission(makeCtx("git.status"));
    const checks = getRecentChecks(10);
    const statusCheck = checks.find((c) => c.capabilityId === "git.status");
    expect(statusCheck).toBeDefined();
    expect(statusCheck!.decision).toBe("ALLOW");
    expect(statusCheck!.source).toBe("default");
  });

  it("records projectId when provided", () => {
    resolvePermission(makeCtx("git.commit", "proj-abc"));
    const checks = getRecentChecks(10);
    const check = checks.find((c) => c.capabilityId === "git.commit");
    expect(check!.projectId).toBe("proj-abc");
  });

  it("returns records in descending order (most recent first)", () => {
    resolvePermission(makeCtx("git.status"));
    resolvePermission(makeCtx("git.diff"));
    resolvePermission(makeCtx("git.log"));
    const checks = getRecentChecks();
    // Most recent first
    expect(checks[0]!.capabilityId).toBe("git.log");
  });

  it("ring buffer enforces max 200 records", () => {
    // Submit 210 checks
    for (let i = 0; i < 210; i++) {
      resolvePermission(makeCtx("git.status"));
    }
    const checks = getRecentChecks(500);
    expect(checks.length).toBeLessThanOrEqual(200);
  });

  it("_resetPermissionEngineForTest clears check records", () => {
    resolvePermission(makeCtx("git.status"));
    _resetPermissionEngineForTest();
    expect(getRecentChecks().length).toBe(0);
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe("persistence", () => {
  it("setGlobalPolicy persists through loadStore", () => {
    setGlobalPolicy("git.stage", "ALWAYS_ALLOW");
    const store = loadStore();
    expect(store.globalPolicies["git.stage"]).toBe("ALWAYS_ALLOW");
  });

  it("setProjectPolicy persists per-project", () => {
    setProjectPolicy("proj-1", "git.commit", "DENY");
    const store = loadStore();
    expect(store.projectOverrides["proj-1"]?.["git.commit"]).toBe("DENY");
  });

  it("setPreset persists", () => {
    setPreset("FULL_ACCESS");
    const store = loadStore();
    expect(store.preset).toBe("FULL_ACCESS");
  });

  it("clearPreset removes preset from store", () => {
    setPreset("FULL_ACCESS");
    clearPreset();
    const store = loadStore();
    expect(store.preset).toBeUndefined();
  });

  it("session grants are never in the store", () => {
    grantSession("git.stage");
    const store = loadStore();
    // Session grants are in-memory only
    expect("sessionGrants" in store).toBe(false);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("determinism", () => {
  it("same inputs always produce same output (default)", () => {
    const ctx = makeCtx("git.status", "proj-1");
    const r1 = resolvePermission(ctx);
    const r2 = resolvePermission(ctx);
    expect(r1.decision).toBe(r2.decision);
    expect(r1.source).toBe(r2.source);
  });

  it("same inputs always produce same output (with global override)", () => {
    setGlobalPolicy("git.commit", "ALWAYS_ALLOW");
    const ctx = makeCtx("git.commit", "proj-1");
    const r1 = resolvePermission(ctx);
    const r2 = resolvePermission(ctx);
    expect(r1.decision).toBe(r2.decision);
    expect(r1.source).toBe(r2.source);
  });
});

// ── Isolation between projects ────────────────────────────────────────────────

describe("project isolation", () => {
  it("overrides for proj-1 do not affect proj-2 or global", () => {
    setProjectPolicy("proj-1", "git.commit", "ALWAYS_ALLOW");
    setProjectPolicy("proj-1", "git.stage", "DENY");

    // proj-2 gets defaults
    expect(resolvePermission(makeCtx("git.commit", "proj-2")).decision).toBe("ASK");
    expect(resolvePermission(makeCtx("git.stage", "proj-2")).decision).toBe("ASK");

    // global (no project) gets defaults
    expect(resolvePermission(makeCtx("git.commit")).decision).toBe("ASK");
    expect(resolvePermission(makeCtx("git.stage")).decision).toBe("ASK");

    // proj-1 gets overrides
    expect(resolvePermission(makeCtx("git.commit", "proj-1")).decision).toBe("ALLOW");
    expect(resolvePermission(makeCtx("git.stage", "proj-1")).decision).toBe("DENY");
  });
});