/**
 * permission-engine.ts — Canonical permission resolution engine for Permission Center V1.
 *
 * Resolution order (highest specificity wins):
 *   1. Session grant (ALLOW_SESSION — in-memory, cleared on restart)
 *   2. Project override (ALLOW_PROJECT or explicit DENY/ALWAYS_ALLOW for project)
 *   3. Global override (DENY / ALWAYS_ALLOW set by user)
 *   4. Preset baseline (SAFE / ASK / FULL_ACCESS)
 *   5. Capability defaultPolicy
 *
 * INVARIANT: Policy storage is the single source of truth.
 * Session grants are never persisted.
 * Permission checks are deterministic given the same store + session state.
 */
import { randomUUID } from "crypto";
import type {
  CapabilityPolicy,
  PermissionDecision,
  PermissionResult,
  PermissionCheckContext,
  PermissionCheckRecord,
} from "../../shared/types.js";
import { getCapability, isKnownCapability } from "./capability-registry.js";
import { loadStore, saveStore } from "./permission-store.js";
import { forgeLogger } from "../telemetry/logger.js";

// ── Module-level in-memory session grants ───────────────────────────────────

/** session grants: capabilityId → Set<projectId | "__global__"> */
const _sessionGrants = new Map<string, Set<string>>();

/** Recent permission check records for Dev Panel (ring buffer, max 200) */
const _checkRecords: PermissionCheckRecord[] = [];
const MAX_CHECK_RECORDS = 200;

// ── Preset resolution ────────────────────────────────────────────────────────

/**
 * Resolve the effective policy for a capability from a preset.
 * Returns null if preset does not override this capability.
 */
function resolveFromPreset(
  capabilityId: string,
  preset: "SAFE" | "ASK" | "FULL_ACCESS"
): CapabilityPolicy | null {
  const cap = getCapability(capabilityId);
  if (!cap) return null;

  if (preset === "FULL_ACCESS") {
    // FULL_ACCESS: allow everything that is not DENY by default (hard limits stay)
    // CRITICAL risk capabilities keep their default (DENY)
    if (cap.risk === "CRITICAL") return cap.defaultPolicy;
    if (cap.defaultPolicy === "DENY") return "DENY"; // hard block stays
    return "ALWAYS_ALLOW";
  }

  if (preset === "ASK") {
    // ASK: LOW risk reads are ALWAYS_ALLOW; everything else is ASK
    if (cap.defaultPolicy === "DENY") return "DENY"; // hard blocks stay
    if (cap.risk === "LOW" && !cap.isDestructive) return "ALWAYS_ALLOW";
    return "ASK";
  }

  if (preset === "SAFE") {
    if (cap.defaultPolicy === "DENY") return "DENY";
    if (cap.risk === "LOW" && !cap.isDestructive) return "ALWAYS_ALLOW";
    if (cap.risk === "CRITICAL") return "DENY";
    if (cap.isDestructive) return "DENY";
    // MEDIUM / HIGH: ASK
    return "ASK";
  }

  return null;
}

// ── Policy → Decision mapping ─────────────────────────────────────────────

function policyToDecision(policy: CapabilityPolicy): PermissionDecision {
  switch (policy) {
    case "DENY":          return "DENY";
    case "ASK":           return "ASK";
    case "ALLOW_SESSION": return "ALLOW";
    case "ALLOW_PROJECT": return "ALLOW";
    case "ALWAYS_ALLOW":  return "ALLOW";
  }
}

// ── Core resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the effective permission for a capability given the current policy store
 * and session state.
 *
 * This is the single canonical entry point. All subsystems must call this.
 * Do NOT implement separate policy resolution in terminal, git, or browser code.
 */
export function resolvePermission(ctx: PermissionCheckContext): PermissionResult {
  const start = Date.now();
  const { capabilityId, projectId } = ctx;

  // Guard: unknown capability
  if (!isKnownCapability(capabilityId)) {
    const result: PermissionResult = {
      decision: "DENY",
      source: "default",
      capabilityId,
      reason: `Unknown capability: "${capabilityId}"`,
    };
    _recordCheck(ctx, result, start);
    forgeLogger.warn("permission", "PERMISSION_UNKNOWN_CAPABILITY", {
      metadata: { capabilityId, decision: "DENY", reason: "unknown capability" },
    });
    return result;
  }

  const cap = getCapability(capabilityId)!;
  const store = loadStore();

  // ── 1. Session grant ───────────────────────────────────────────────────────
  {
    const grantSet = _sessionGrants.get(capabilityId);
    if (grantSet) {
      const key = projectId ?? "__global__";
      if (grantSet.has(key) || grantSet.has("__global__")) {
        const result: PermissionResult = {
          decision: "ALLOW",
          source: "session",
          capabilityId,
          reason: "Session grant active",
        };
        _recordCheck(ctx, result, start);
        _emitAllowed(ctx, result);
        return result;
      }
    }
  }

  // ── 2. Project override ───────────────────────────────────────────────────
  if (projectId) {
    const projectPolicies = store.projectOverrides[projectId];
    if (projectPolicies && capabilityId in projectPolicies) {
      const policy = projectPolicies[capabilityId]!;
      const decision = policyToDecision(policy);
      const result: PermissionResult = {
        decision,
        source: "project",
        capabilityId,
        reason: `Project override: ${policy}`,
      };
      _recordCheck(ctx, result, start);
      _emitByDecision(ctx, result);
      return result;
    }
  }

  // ── 3. Global override ────────────────────────────────────────────────────
  if (capabilityId in store.globalPolicies) {
    const policy = store.globalPolicies[capabilityId]!;
    const decision = policyToDecision(policy);
    const result: PermissionResult = {
      decision,
      source: "global",
      capabilityId,
      reason: `Global override: ${policy}`,
    };
    _recordCheck(ctx, result, start);
    _emitByDecision(ctx, result);
    return result;
  }

  // ── 4. Preset ─────────────────────────────────────────────────────────────
  if (store.preset) {
    const presetPolicy = resolveFromPreset(capabilityId, store.preset);
    if (presetPolicy !== null) {
      const decision = policyToDecision(presetPolicy);
      const result: PermissionResult = {
        decision,
        source: "preset",
        capabilityId,
        reason: `Preset ${store.preset}: ${presetPolicy}`,
      };
      _recordCheck(ctx, result, start);
      _emitByDecision(ctx, result);
      return result;
    }
  }

  // ── 5. Capability default ─────────────────────────────────────────────────
  const decision = policyToDecision(cap.defaultPolicy);
  const result: PermissionResult = {
    decision,
    source: "default",
    capabilityId,
    reason: `Capability default: ${cap.defaultPolicy}`,
  };
  _recordCheck(ctx, result, start);
  _emitByDecision(ctx, result);
  return result;
}

// ── Session grant management ──────────────────────────────────────────────

/**
 * Create a session grant for a capability.
 * Optionally scoped to a projectId (null = global session grant).
 * Session grants are never persisted — cleared on restart.
 */
export function grantSession(capabilityId: string, projectId?: string): void {
  if (!isKnownCapability(capabilityId)) return;
  let grantSet = _sessionGrants.get(capabilityId);
  if (!grantSet) {
    grantSet = new Set();
    _sessionGrants.set(capabilityId, grantSet);
  }
  const key = projectId ?? "__global__";
  grantSet.add(key);
  forgeLogger.info("permission", "PERMISSION_SESSION_GRANT_CREATED", {
    metadata: { capabilityId, key },
  });
}

/**
 * Revoke a session grant for a capability.
 */
export function revokeSession(capabilityId: string, projectId?: string): void {
  const grantSet = _sessionGrants.get(capabilityId);
  if (!grantSet) return;
  const key = projectId ?? "__global__";
  grantSet.delete(key);
  if (grantSet.size === 0) _sessionGrants.delete(capabilityId);
}

/**
 * Get all active session grants.
 * Returns map of capabilityId → array of project keys (or "__global__").
 */
export function getSessionGrants(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [capId, keys] of _sessionGrants) {
    result[capId] = [...keys];
  }
  return result;
}

/**
 * Clear all session grants. Called on app restart / permission engine reset.
 */
export function clearAllSessionGrants(): void {
  _sessionGrants.clear();
}

// ── Persistent policy management ─────────────────────────────────────────

/**
 * Set a global policy override for a capability.
 */
export function setGlobalPolicy(capabilityId: string, policy: CapabilityPolicy): void {
  if (!isKnownCapability(capabilityId)) return;
  const store = loadStore();
  store.globalPolicies[capabilityId] = policy;
  saveStore(store);
  forgeLogger.info("permission", "PERMISSION_GLOBAL_POLICY_SET", {
    metadata: { scope: "global", capabilityId, policy },
  });
}

/**
 * Remove a global policy override for a capability (reverts to preset/default).
 */
export function clearGlobalPolicy(capabilityId: string): void {
  const store = loadStore();
  delete store.globalPolicies[capabilityId];
  saveStore(store);
}

/**
 * Set a project-scoped policy override for a capability.
 */
export function setProjectPolicy(
  projectId: string,
  capabilityId: string,
  policy: CapabilityPolicy
): void {
  if (!isKnownCapability(capabilityId)) return;
  const store = loadStore();
  if (!store.projectOverrides[projectId]) {
    store.projectOverrides[projectId] = {};
  }
  store.projectOverrides[projectId]![capabilityId] = policy;
  saveStore(store);
  forgeLogger.info("permission", "PERMISSION_OVERRIDE_CHANGED", {
    metadata: { scope: "project", projectId, capabilityId, policy },
    });
}

/**
 * Remove a project-scoped policy override for a capability.
 */
export function clearProjectPolicy(projectId: string, capabilityId: string): void {
  const store = loadStore();
  const projectPolicies = store.projectOverrides[projectId];
  if (!projectPolicies) return;
  delete projectPolicies[capabilityId];
  if (Object.keys(projectPolicies).length === 0) {
    delete store.projectOverrides[projectId];
  }
  saveStore(store);
}

/**
 * Set the active preset.
 * Per-capability explicit overrides are NOT cleared by preset changes.
 */
export function setPreset(preset: "SAFE" | "ASK" | "FULL_ACCESS"): void {
  const store = loadStore();
  store.preset = preset;
  saveStore(store);
  forgeLogger.info("permission", "PERMISSION_OVERRIDE_CHANGED", {
    metadata: { scope: "preset", preset },
    });
}

/**
 * Clear the active preset (revert to capability defaults).
 */
export function clearPreset(): void {
  const store = loadStore();
  delete store.preset;
  saveStore(store);
}

/**
 * Reset all global policies to defaults.
 * Project overrides and preset are NOT affected.
 */
export function resetGlobalPolicies(): void {
  const store = loadStore();
  store.globalPolicies = {};
  saveStore(store);
}

/**
 * Reset all project-specific overrides for a project.
 */
export function resetProjectPolicies(projectId: string): void {
  const store = loadStore();
  delete store.projectOverrides[projectId];
  saveStore(store);
}

// ── Dev Panel ring buffer ────────────────────────────────────────────────

function _recordCheck(
  ctx: PermissionCheckContext,
  result: PermissionResult,
  startMs: number
): void {
  const record: PermissionCheckRecord = {
    id: randomUUID(),
    capabilityId: ctx.capabilityId,
    decision: result.decision,
    source: result.source,
    reason: result.reason,
    ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
    conversationId: ctx.conversationId,
    requestId: ctx.requestId,
    agentRunId: ctx.agentRunId,
    durationMs: Date.now() - startMs,
    checkedAt: Date.now(),
  };
  _checkRecords.push(record);
  if (_checkRecords.length > MAX_CHECK_RECORDS) {
    _checkRecords.splice(0, _checkRecords.length - MAX_CHECK_RECORDS);
  }
}

function _emitAllowed(ctx: PermissionCheckContext, result: PermissionResult): void {
  forgeLogger.debug("permission", "PERMISSION_CHECKED", {
    metadata: { capabilityId: ctx.capabilityId, source: result.source },
    });
}

function _emitByDecision(ctx: PermissionCheckContext, result: PermissionResult): void {
  if (result.decision === "ALLOW") {
    forgeLogger.debug("permission", "PERMISSION_CHECKED", {
      metadata: { capabilityId: ctx.capabilityId, source: result.source },
    });
  } else if (result.decision === "DENY") {
    forgeLogger.info("permission", "PERMISSION_OVERRIDE_CHANGED", {
      metadata: { capabilityId: ctx.capabilityId, source: result.source, reason: result.reason },
    });
  } else {
    forgeLogger.info("permission", "PERMISSION_OVERRIDE_CHANGED", {
      metadata: { capabilityId: ctx.capabilityId, source: result.source },
    });
  }
}

/**
 * Get recent permission check records (for Dev Panel).
 */
export function getRecentChecks(limit = 100): PermissionCheckRecord[] {
  const start = Math.max(0, _checkRecords.length - limit);
  return _checkRecords.slice(start).reverse();
}

// ── Test helpers ─────────────────────────────────────────────────────────

/** @internal For tests only */
export function _resetPermissionEngineForTest(): void {
  _sessionGrants.clear();
  _checkRecords.length = 0;
}