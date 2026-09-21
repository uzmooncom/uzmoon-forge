/**
 * Multi-Agent Resource Manager
 *
 * Manages concurrency safety for shared resources across concurrent worker AgentRuns.
 * Leases are runtime-only (not persisted) — they are reacquired after restart
 * as workers resume execution through normal reconciliation.
 *
 * Semantics:
 *   read     — multiple readers coexist; conflicts with write/exclusive
 *   write    — one writer; conflicts with write/exclusive/other readers
 *   exclusive — one holder only; conflicts with everything
 *
 * Integration points (correction #11):
 *   - Safe File Editing mutations acquire file write lease
 *   - Git stage/unstage/commit acquire project git-index exclusive lease
 *   - Browser tab ownership: delegated to BrowserManager (not duplicated)
 *   - DevProcessManager: delegated to existing ownership model
 *
 * Permissions are separate from leases:
 *   lease  = concurrency safety (this module)
 *   permission = authorization (Permission Center)
 */

import { randomUUID } from "crypto";
import { forgeLogger } from "../../telemetry/logger.js";
import type { ResourceLease, ResourceLeaseMode, ResourceLeaseSnapshot } from "./ma-types.js";

// ── In-memory lease store ─────────────────────────────────────────────────

/** Leases keyed by lease id */
const _leases = new Map<string, ResourceLease>();

// ── Key builders (canonical resource key format) ──────────────────────────

/**
 * Canonical key for a filesystem path.
 * Normalize to absolute, lowercase on case-insensitive systems.
 */
export function fileResourceKey(absolutePath: string): string {
  return `file:${absolutePath}`;
}

/**
 * Canonical key for a git project index (stage/commit operations).
 */
export function gitIndexResourceKey(projectId: string): string {
  return `git-index:${projectId}`;
}

/**
 * Canonical key for a dev process owned by a session.
 */
export function devProcessResourceKey(processId: string): string {
  return `dev-process:${processId}`;
}

// ── Conflict detection ────────────────────────────────────────────────────

function _hasConflict(
  existingLeases: ResourceLease[],
  mode: ResourceLeaseMode,
  requesterAgentId: string
): { conflict: boolean; conflictOwnerAgentId?: string } {
  for (const lease of existingLeases) {
    // Same owner may upgrade/refresh their own lease
    if (lease.ownerAgentId === requesterAgentId) continue;

    if (mode === "read" && lease.mode === "read") {
      // Multiple readers allowed
      continue;
    }
    // All other combinations conflict
    return { conflict: true, conflictOwnerAgentId: lease.ownerAgentId };
  }
  return { conflict: false };
}

// ── Public API ────────────────────────────────────────────────────────────

export interface AcquireLeaseResult {
  acquired: boolean;
  leaseId: string | null;
  conflictOwnerAgentId: string | null;
  conflictOwnerWorkItemId: string | null;
}

/**
 * Attempt to acquire a resource lease.
 * Returns immediately — does NOT block/wait.
 * The caller must retry or propagate the conflict to the coordinator.
 */
export function acquireLease(
  resourceKey: string,
  ownerAgentId: string,
  ownerWorkItemId: string,
  taskId: string,
  mode: ResourceLeaseMode
): AcquireLeaseResult {
  const existing = _getLeasesForKey(resourceKey);

  // Check if this agent already holds a compatible lease
  const ownExisting = existing.find((l) => l.ownerAgentId === ownerAgentId);
  if (ownExisting) {
    // Refresh / upgrade
    if (ownExisting.mode === mode || (ownExisting.mode === "exclusive" && mode !== "exclusive")) {
      forgeLogger.debug("task", "MA_RESOURCE_REFRESH", {
        metadata: { resourceKey, ownerAgentId, mode },
      });
      return { acquired: true, leaseId: ownExisting.id, conflictOwnerAgentId: null, conflictOwnerWorkItemId: null };
    }
    // Upgrade to a stronger mode — release old, re-check
    _leases.delete(ownExisting.id);
    existing.splice(existing.indexOf(ownExisting), 1);
  }

  const conflictResult = _hasConflict(existing, mode, ownerAgentId);
  if (conflictResult.conflict) {
    const conflictLease = existing.find((l) => l.ownerAgentId === conflictResult.conflictOwnerAgentId);
    forgeLogger.warn("task", "MA_RESOURCE_CONFLICT", {
      metadata: {
        resourceKey,
        ownerAgentId,
        mode,
        conflictOwnerAgentId: conflictResult.conflictOwnerAgentId,
      },
    });
    return {
      acquired: false,
      leaseId: null,
      conflictOwnerAgentId: conflictResult.conflictOwnerAgentId ?? null,
      conflictOwnerWorkItemId: conflictLease?.ownerWorkItemId ?? null,
    };
  }

  const lease: ResourceLease = {
    id: randomUUID(),
    resourceKey,
    ownerAgentId,
    ownerWorkItemId,
    taskId,
    mode,
    acquiredAt: Date.now(),
  };

  _leases.set(lease.id, lease);

  forgeLogger.debug("task", "MA_RESOURCE_ACQUIRED", {
    metadata: { resourceKey, ownerAgentId, mode, leaseId: lease.id },
  });

  return { acquired: true, leaseId: lease.id, conflictOwnerAgentId: null, conflictOwnerWorkItemId: null };
}

/**
 * Release a specific lease by id.
 */
export function releaseLease(leaseId: string): boolean {
  const lease = _leases.get(leaseId);
  if (!lease) return false;
  _leases.delete(leaseId);
  forgeLogger.debug("task", "MA_RESOURCE_RELEASED", {
    metadata: { resourceKey: lease.resourceKey, ownerAgentId: lease.ownerAgentId, leaseId },
  });
  return true;
}

/**
 * Release all leases owned by a specific agent.
 * Call when a work item completes, fails, is interrupted, or is cancelled.
 */
export function releaseAllLeasesForAgent(ownerAgentId: string): number {
  let released = 0;
  for (const [id, lease] of _leases.entries()) {
    if (lease.ownerAgentId === ownerAgentId) {
      _leases.delete(id);
      released++;
    }
  }
  if (released > 0) {
    forgeLogger.debug("task", "MA_RESOURCE_AGENT_LEASES_RELEASED", {
      metadata: { ownerAgentId, released },
    });
  }
  return released;
}

/**
 * Release all leases owned by a specific work item.
 */
export function releaseAllLeasesForWorkItem(ownerWorkItemId: string): number {
  let released = 0;
  for (const [id, lease] of _leases.entries()) {
    if (lease.ownerWorkItemId === ownerWorkItemId) {
      _leases.delete(id);
      released++;
    }
  }
  return released;
}

/**
 * Release all leases for a task (used on cancel/terminal).
 */
export function releaseAllLeasesForTask(taskId: string): number {
  let released = 0;
  for (const [id, lease] of _leases.entries()) {
    if (lease.taskId === taskId) {
      _leases.delete(id);
      released++;
    }
  }
  if (released > 0) {
    forgeLogger.info("task", "MA_RESOURCE_TASK_LEASES_RELEASED", {
      metadata: { taskId, released },
    });
  }
  return released;
}

/**
 * Check if a resource has any conflicting leases for a proposed acquisition.
 * Non-mutating — for planning/validation only.
 */
export function hasConflict(
  resourceKey: string,
  mode: ResourceLeaseMode,
  requesterAgentId: string
): boolean {
  const existing = _getLeasesForKey(resourceKey);
  return _hasConflict(existing, mode, requesterAgentId).conflict;
}

/**
 * Get all active leases for a task (for snapshot).
 */
export function listLeasesForTask(taskId: string): ResourceLeaseSnapshot[] {
  return Array.from(_leases.values())
    .filter((l) => l.taskId === taskId)
    .map(({ resourceKey, ownerAgentId, ownerWorkItemId, mode, acquiredAt }) => ({
      resourceKey,
      ownerAgentId,
      ownerWorkItemId,
      mode,
      acquiredAt,
    }));
}

/**
 * Get all active leases (for DevPanel).
 */
export function listAllLeases(): ResourceLeaseSnapshot[] {
  return Array.from(_leases.values()).map(({ resourceKey, ownerAgentId, ownerWorkItemId, mode, acquiredAt }) => ({
    resourceKey,
    ownerAgentId,
    ownerWorkItemId,
    mode,
    acquiredAt,
  }));
}

/**
 * Clear all leases — for test isolation.
 */
export function resetResourceManager(): void {
  _leases.clear();
}

// ── Private helpers ────────────────────────────────────────────────────────

function _getLeasesForKey(resourceKey: string): ResourceLease[] {
  return Array.from(_leases.values()).filter((l) => l.resourceKey === resourceKey);
}