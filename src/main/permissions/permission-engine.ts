/**
 * permission-engine.ts — Canonical permission resolution engine for Permission Center V1.
 *
 * Resolution order (highest specificity wins):
 *   1. Allow-once grants (run-scoped: requestId+toolCallId, cleared after single use)
 *   2. Session grants (in-memory, cleared on restart)
 *   3. Project override
 *   4. Global override
 *   5. Preset baseline (SAFE / ASK / FULL_ACCESS)
 *   6. Capability defaultPolicy
 *
 * INVARIANT: Policy storage is the single source of truth.
 * Session grants are never persisted.
 * Allow-once grants are per-operation and consumed on use.
 * Permission checks are deterministic given the same store + session state.
 */
import { randomUUID } from "crypto";
import type {
  CapabilityPolicy,
  PermissionDecision,
  PermissionResult,
  PermissionCheckContext,
  PermissionCheckRecord,
  PermissionApprovalRequest,
  PermissionApprovalResponse,
  PermissionApprovalAction,
} from "../../shared/types.js";
import { getCapability, isKnownCapability } from "./capability-registry.js";
import { loadStore, saveStore } from "./permission-store.js";
import { forgeLogger } from "../telemetry/logger.js";

// ── Module-level state ───────────────────────────────────────────────────────

/** Session grants: capabilityId → Set<projectId | "__global__"> */
const _sessionGrants = new Map<string, Set<string>>();

/**
 * Allow-once grants: key = `${requestId}:${toolCallId}:${capabilityId}` → boolean (consumed marker).
 * These are ephemeral and consumed on first use.
 */
const _allowOnceGrants = new Map<string, boolean>();

/**
 * Pending approval requests: approvalId → { resolve, reject, capabilityId, requestId? }
 * Used for ASK flow suspend/resume.
 */
const _pendingApprovals = new Map<string, {
  resolve: (action: PermissionApprovalAction) => void;
  reject: (reason: Error) => void;
  capabilityId: string;
  requestId?: string;
  agentRunId?: string;
  toolCallId?: string;
}>();

/** Recent permission check records for Dev Panel (ring buffer, max 200) */
const _checkRecords: PermissionCheckRecord[] = [];
const MAX_CHECK_RECORDS = 200;

/**
 * Main-process sender function for IPC push events.
 * Injected by registerHandlers() to avoid circular dependency.
 */
type IpcSenderFn = (channel: string, payload: unknown) => void;
let _ipcSender: IpcSenderFn | null = null;

export function setPermissionIpcSender(fn: IpcSenderFn): void {
  _ipcSender = fn;
}

// ── Preset resolution ────────────────────────────────────────────────────────

function resolveFromPreset(
  capabilityId: string,
  preset: "SAFE" | "ASK" | "FULL_ACCESS"
): CapabilityPolicy | null {
  const cap = getCapability(capabilityId);
  if (!cap) return null;

  if (preset === "FULL_ACCESS") {
    if (cap.risk === "CRITICAL") return cap.defaultPolicy;
    if (cap.defaultPolicy === "DENY") return "DENY";
    return "ALWAYS_ALLOW";
  }

  if (preset === "ASK") {
    if (cap.defaultPolicy === "DENY") return "DENY";
    if (cap.risk === "LOW" && !cap.isDestructive) return "ALWAYS_ALLOW";
    return "ASK";
  }

  if (preset === "SAFE") {
    if (cap.defaultPolicy === "DENY") return "DENY";
    if (cap.risk === "LOW" && !cap.isDestructive) return "ALWAYS_ALLOW";
    if (cap.risk === "CRITICAL") return "DENY";
    if (cap.isDestructive) return "DENY";
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

// ── Allow-once key ───────────────────────────────────────────────────────────

function _allowOnceKey(requestId: string, toolCallId: string, capabilityId: string): string {
  return `${requestId}:${toolCallId}:${capabilityId}`;
}

// ── Core synchronous resolution ──────────────────────────────────────────────

/**
 * Resolve the effective permission for a capability given the current policy store
 * and session state. Synchronous — does NOT trigger the approval dialog.
 *
 * When decision === "ASK", callers must call requestPermissionApproval() to
 * suspend and wait for user input, then act on the response.
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

  // ── 1. Allow-once grant ────────────────────────────────────────────────────
  if (ctx.requestId && ctx.toolCallId) {
    const key = _allowOnceKey(ctx.requestId, ctx.toolCallId, capabilityId);
    if (_allowOnceGrants.has(key)) {
      _allowOnceGrants.delete(key); // consumed — single use only
      const result: PermissionResult = {
        decision: "ALLOW",
        source: "session",
        capabilityId,
        reason: "Allow-once grant (consumed)",
      };
      _recordCheck(ctx, result, start);
      forgeLogger.debug("permission", "PERMISSION_ALLOWED", {
        metadata: { capabilityId, source: "allow_once" },
      });
      return result;
    }
  }

  // ── 2. Session grant ───────────────────────────────────────────────────────
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

  // ── 3. Project override ───────────────────────────────────────────────────
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

  // ── 4. Global override ────────────────────────────────────────────────────
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

  // ── 5. Preset ─────────────────────────────────────────────────────────────
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

  // ── 6. Capability default ─────────────────────────────────────────────────
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

// ── Async ASK approval flow ──────────────────────────────────────────────────

/**
 * Request user approval for a capability when resolvePermission() returns ASK.
 *
 * Sends PERMISSION_IPC.APPROVAL_REQUEST to renderer, suspends until the user responds,
 * then applies the user's action (Allow Once / Session / Project / Always / Deny).
 *
 * Returns the final PermissionResult after user action.
 * Rejects if the approval is cancelled (e.g. Stop button pressed).
 */
export async function requestPermissionApproval(
  ctx: PermissionCheckContext,
  reason: string
): Promise<PermissionResult> {
  const cap = getCapability(ctx.capabilityId);
  if (!cap) {
    return {
      decision: "DENY",
      source: "default",
      capabilityId: ctx.capabilityId,
      reason: "Unknown capability",
    };
  }

  const approvalId = randomUUID();

  const approvalRequest: PermissionApprovalRequest = {
    approvalId,
    capabilityId: ctx.capabilityId,
    capabilityName: cap.name,
    reason,
    ...(ctx.projectId !== undefined && { projectId: ctx.projectId }),
    ...(ctx.conversationId !== undefined && { conversationId: ctx.conversationId }),
    ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    ...(ctx.agentRunId !== undefined && { agentRunId: ctx.agentRunId }),
    ...(ctx.toolCallId !== undefined && { toolCallId: ctx.toolCallId }),
  };

  forgeLogger.info("permission", "PERMISSION_APPROVAL_REQUESTED", {
    metadata: { capabilityId: ctx.capabilityId, approvalId, reason },
  });

  return new Promise<PermissionResult>((resolve, reject) => {
    _pendingApprovals.set(approvalId, {
      resolve: (action: PermissionApprovalAction) => {
        const result = _applyApprovalAction(action, ctx);
        forgeLogger.info("permission", action === "deny" ? "PERMISSION_APPROVAL_DENIED" : "PERMISSION_APPROVAL_GRANTED", {
          metadata: { capabilityId: ctx.capabilityId, approvalId, action },
        });
        resolve(result);
      },
      reject,
      capabilityId: ctx.capabilityId,
      ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
      ...(ctx.agentRunId !== undefined && { agentRunId: ctx.agentRunId }),
      ...(ctx.toolCallId !== undefined && { toolCallId: ctx.toolCallId }),
    });

    // Push to renderer
    _ipcSender?.("permission:approvalRequest", approvalRequest);
  });
}

/**
 * Apply a user's approval action, modifying state as needed.
 * Called internally when the user responds to an approval prompt.
 */
function _applyApprovalAction(
  action: PermissionApprovalAction,
  ctx: PermissionCheckContext
): PermissionResult {
  switch (action) {
    case "allow_once": {
      // Record allow-once grant. The grant key is consumed by the NEXT resolvePermission call
      // for the same requestId+toolCallId — the caller should re-call resolvePermission after this.
      if (ctx.requestId && ctx.toolCallId) {
        const key = _allowOnceKey(ctx.requestId, ctx.toolCallId, ctx.capabilityId);
        _allowOnceGrants.set(key, true);
      }
      return {
        decision: "ALLOW",
        source: "session",
        capabilityId: ctx.capabilityId,
        reason: "Allow-once approved by user",
      };
    }
    case "allow_session": {
      grantSession(ctx.capabilityId, ctx.projectId);
      return {
        decision: "ALLOW",
        source: "session",
        capabilityId: ctx.capabilityId,
        reason: "Session grant approved by user",
      };
    }
    case "allow_project": {
      if (ctx.projectId) {
        setProjectPolicy(ctx.projectId, ctx.capabilityId, "ALLOW_PROJECT");
      } else {
        grantSession(ctx.capabilityId, undefined);
      }
      return {
        decision: "ALLOW",
        source: ctx.projectId ? "project" : "session",
        capabilityId: ctx.capabilityId,
        reason: "Project grant approved by user",
      };
    }
    case "always_allow": {
      setGlobalPolicy(ctx.capabilityId, "ALWAYS_ALLOW");
      return {
        decision: "ALLOW",
        source: "global",
        capabilityId: ctx.capabilityId,
        reason: "Global allow set by user",
      };
    }
    case "deny":
    default: {
      return {
        decision: "DENY",
        source: "session",
        capabilityId: ctx.capabilityId,
        reason: "Denied by user",
      };
    }
  }
}

/**
 * Respond to a pending approval (called from IPC handler when renderer responds).
 */
export function respondToApproval(response: PermissionApprovalResponse): void {
  const entry = _pendingApprovals.get(response.approvalId);
  if (!entry) {
    forgeLogger.warn("permission", "PERMISSION_WARN", {
      metadata: { event: "stale_approval_response", approvalId: response.approvalId },
    });
    return;
  }
  _pendingApprovals.delete(response.approvalId);
  entry.resolve(response.action);
}

/**
 * Cancel all pending approvals for a given agentRunId or requestId.
 * Called when Stop is pressed — mirrors browser cancelApprovalsForRequest.
 */
export function cancelPendingApprovals(opts: { requestId?: string; agentRunId?: string }): void {
  for (const [approvalId, entry] of _pendingApprovals) {
    const matches =
      (opts.requestId && entry.requestId === opts.requestId) ||
      (opts.agentRunId && entry.agentRunId === opts.agentRunId);
    if (matches) {
      _pendingApprovals.delete(approvalId);
      entry.reject(new Error("CANCELLED"));
      // Notify renderer that approval was dismissed
      _ipcSender?.("permission:approvalCancelled", { approvalId });
      forgeLogger.info("permission", "PERMISSION_WARN", {
        metadata: { event: "approval_cancelled", approvalId, capabilityId: entry.capabilityId },
      });
    }
  }
}

/**
 * Get count of pending approvals (for diagnostics).
 */
export function getPendingApprovalCount(): number {
  return _pendingApprovals.size;
}

// ── Session grant management ──────────────────────────────────────────────

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

export function revokeSession(capabilityId: string, projectId?: string): void {
  const grantSet = _sessionGrants.get(capabilityId);
  if (!grantSet) return;
  const key = projectId ?? "__global__";
  grantSet.delete(key);
  if (grantSet.size === 0) _sessionGrants.delete(capabilityId);
}

export function getSessionGrants(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [capId, keys] of _sessionGrants) {
    result[capId] = [...keys];
  }
  return result;
}

export function clearAllSessionGrants(): void {
  _sessionGrants.clear();
}

// ── Persistent policy management ─────────────────────────────────────────

export function setGlobalPolicy(capabilityId: string, policy: CapabilityPolicy): void {
  if (!isKnownCapability(capabilityId)) return;
  const store = loadStore();
  store.globalPolicies[capabilityId] = policy;
  saveStore(store);
  forgeLogger.info("permission", "PERMISSION_GLOBAL_GRANT_CREATED", {
    metadata: { scope: "global", capabilityId, policy },
  });
}

export function clearGlobalPolicy(capabilityId: string): void {
  const store = loadStore();
  delete store.globalPolicies[capabilityId];
  saveStore(store);
  forgeLogger.info("permission", "PERMISSION_OVERRIDE_CHANGED", {
    metadata: { scope: "global", capabilityId, action: "clear" },
  });
}

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
  forgeLogger.info("permission", "PERMISSION_PROJECT_GRANT_CREATED", {
    metadata: { scope: "project", projectId, capabilityId, policy },
  });
}

export function clearProjectPolicy(projectId: string, capabilityId: string): void {
  const store = loadStore();
  const projectPolicies = store.projectOverrides[projectId];
  if (!projectPolicies) return;
  delete projectPolicies[capabilityId];
  if (Object.keys(projectPolicies).length === 0) {
    delete store.projectOverrides[projectId];
  }
  saveStore(store);
  forgeLogger.info("permission", "PERMISSION_OVERRIDE_CHANGED", {
    metadata: { scope: "project", projectId, capabilityId, action: "clear" },
  });
}

export function setPreset(preset: "SAFE" | "ASK" | "FULL_ACCESS"): void {
  const store = loadStore();
  store.preset = preset;
  saveStore(store);
  forgeLogger.info("permission", "PERMISSION_OVERRIDE_CHANGED", {
    metadata: { scope: "preset", preset },
  });
}

export function clearPreset(): void {
  const store = loadStore();
  delete store.preset;
  saveStore(store);
}

export function resetGlobalPolicies(): void {
  const store = loadStore();
  store.globalPolicies = {};
  saveStore(store);
}

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
    ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
    ...(ctx.agentRunId !== undefined ? { agentRunId: ctx.agentRunId } : {}),
    durationMs: Date.now() - startMs,
    checkedAt: Date.now(),
  };
  _checkRecords.push(record);
  if (_checkRecords.length > MAX_CHECK_RECORDS) {
    _checkRecords.splice(0, _checkRecords.length - MAX_CHECK_RECORDS);
  }
}

function _emitAllowed(_ctx: PermissionCheckContext, result: PermissionResult): void {
  forgeLogger.debug("permission", "PERMISSION_ALLOWED", {
    metadata: { capabilityId: result.capabilityId, source: result.source },
  });
}

function _emitByDecision(ctx: PermissionCheckContext, result: PermissionResult): void {
  if (result.decision === "ALLOW") {
    forgeLogger.debug("permission", "PERMISSION_ALLOWED", {
      metadata: { capabilityId: ctx.capabilityId, source: result.source },
    });
  } else if (result.decision === "DENY") {
    forgeLogger.info("permission", "PERMISSION_DENIED", {
      metadata: { capabilityId: ctx.capabilityId, source: result.source, reason: result.reason },
    });
  } else {
    forgeLogger.info("permission", "PERMISSION_CHECKED", {
      metadata: { capabilityId: ctx.capabilityId, source: result.source, decision: "ASK" },
    });
  }
}

export function getRecentChecks(limit = 100): PermissionCheckRecord[] {
  const start = Math.max(0, _checkRecords.length - limit);
  return _checkRecords.slice(start).reverse();
}

// ── Test helpers ─────────────────────────────────────────────────────────

/** @internal For tests only */
export function _resetPermissionEngineForTest(): void {
  _sessionGrants.clear();
  _allowOnceGrants.clear();
  _pendingApprovals.clear();
  _checkRecords.length = 0;
  _ipcSender = null;
}

/** @internal For tests only — get pending approval count */
export function _getPendingApprovalsForTest(): Map<string, unknown> {
  return _pendingApprovals as Map<string, unknown>;
}