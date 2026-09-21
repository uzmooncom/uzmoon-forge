/**
 * Multi-Agent Reconciler
 *
 * Mirrors the existing reconcileInterruptedTasks() in task-manager.ts
 * but for MA-level entities: AgentInstances and AgentWorkItems.
 *
 * Called once at app startup, after task reconciliation runs.
 *
 * Safety rules:
 *   - Never auto-resume; only mark interrupted items as retryable (pending/interrupted).
 *   - AgentInstances in working/reviewing/waiting states → idle_reuse (releasable).
 *   - AgentWorkItems in running/assigned/reviewing states → interrupted (retryable).
 *   - Release all resource leases (in-memory only — leases are never persisted).
 *   - Terminal work items and instances are NOT modified.
 */

import { forgeLogger } from "../../telemetry/logger.js";
import { listInterruptedWorkItems, listAllAgentInstances } from "../../database/db.js";
import { hydrateTaskMAState, updateWorkItem, updateInstance } from "./ma-store.js";
import { resetResourceManager } from "./resource-manager.js";

/**
 * Reconcile all interrupted multi-agent state at app startup.
 * Must be called AFTER reconcileInterruptedTasks() (which handles ForgeTask status).
 */
export function reconcileInterruptedMAState(): void {
  // Clear all runtime-only resource leases (they are never persisted)
  resetResourceManager();

  // Load interrupted work items from DB
  const interruptedWorkItems = listInterruptedWorkItems(true);
  const interruptedInstances = _findInterruptedInstances();

  if (interruptedWorkItems.length === 0 && interruptedInstances.length === 0) {
    forgeLogger.debug("task", "MA_RECONCILED", {
      metadata: { workItems: 0, instances: 0 },
    });
    return;
  }

  // Group by taskId for efficient hydration
  const taskIds = new Set<string>();
  for (const wi of interruptedWorkItems) taskIds.add(wi.taskId);
  for (const inst of interruptedInstances) taskIds.add(inst.taskId);

  // Hydrate each affected task's MA state into memory
  for (const taskId of taskIds) {
    hydrateTaskMAState(taskId);
  }

  // Patch interrupted work items → "interrupted" (if not already)
  // running, assigned, reviewing, waiting_for_human, waiting_for_approval → interrupted
  let patchedItems = 0;
  for (const wi of interruptedWorkItems) {
    updateWorkItem(wi.id, { status: "interrupted" });
    patchedItems++;
  }

  // Patch interrupted instances → idle_reuse
  // working, reviewing, waiting_for_human, waiting_for_approval → idle_reuse
  let patchedInstances = 0;
  for (const inst of interruptedInstances) {
    updateInstance(inst.id, {
      status: "idle_reuse",
      currentWorkItemId: null,
      activeAgentRunId: null,
    });
    patchedInstances++;
  }

  forgeLogger.info("task", "MA_RECONCILED", {
    metadata: {
      workItems: patchedItems,
      instances: patchedInstances,
      taskIds: Array.from(taskIds),
    },
  });
}

// ── Private helpers ────────────────────────────────────────────────────────

function _findInterruptedInstances() {
  const all = listAllAgentInstances(true);
  return all.filter(
    (inst) =>
      inst.status === "working" ||
      inst.status === "reviewing" ||
      inst.status === "waiting_for_human" ||
      inst.status === "waiting_for_approval"
  );
}