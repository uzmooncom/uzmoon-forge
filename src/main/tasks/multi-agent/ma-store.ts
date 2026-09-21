/**
 * Multi-Agent Store
 *
 * Single source of truth for all MA runtime state within a process.
 * Uses in-memory maps for fast access + DB persistence for durability.
 *
 * All public mutators persist immediately via db.ts.
 * All readers return deep clones — callers may not mutate returned objects.
 */

import { randomUUID, createHash } from "crypto";
import {
  saveAgentInstance,
  getAgentInstance as dbGetInstance,
  updateAgentInstance,
  listAgentInstances,
  saveWorkItem,
  getWorkItem as dbGetWorkItem,
  updateWorkItem as dbUpdateWorkItem,
  listWorkItems,
  saveSubtaskProposal,
  updateSubtaskProposal,
  listSubtaskProposals,
  saveReviewResult,
  listReviewResults,
  saveAssignmentHistory,
  updateAssignmentHistory,
  listAssignmentHistory,
} from "../../database/db.js";
import { forgeLogger } from "../../telemetry/logger.js";
import { assertInvariant } from "../../reliability/invariants.js";
import { listLeasesForTask, releaseAllLeasesForTask } from "./resource-manager.js";
import type {
  AgentInstance,
  AgentWorkItem,
  SubtaskProposal,
  ReviewResult,
  AssignmentHistoryEntry,
  MultiAgentTaskSnapshot,
  WorkItemStatus,
  AgentRole,
  WorkItemKind,
  WorkItemCreatedByType,
  WorkItemDependency,
  MABudgetCounters,
  TaskExecutionMode,
} from "./ma-types.js";
import {
  MA_MAX_WORK_ITEMS,
  MA_MAX_SPAWN_DEPTH,
  MA_MAX_WORKERS,
} from "./ma-types.js";

// ── In-memory caches ────────────────────────────────────────────────────────

/** AgentInstance cache keyed by id */
const _instances = new Map<string, AgentInstance>();
/** AgentWorkItem cache keyed by id */
const _workItems = new Map<string, AgentWorkItem>();
/** SubtaskProposal cache keyed by id */
const _proposals = new Map<string, SubtaskProposal>();
/** ReviewResult cache keyed by `workItemId:attempt` */
const _reviews = new Map<string, ReviewResult>();
/** AssignmentHistoryEntry cache keyed by id */
const _assignments = new Map<string, AssignmentHistoryEntry>();
/** Budget counters keyed by taskId */
const _counters = new Map<string, MABudgetCounters>();
/** Snapshot revision keyed by taskId */
const _revisions = new Map<string, number>();
/** Execution mode keyed by taskId */
const _executionMode = new Map<string, TaskExecutionMode>();

// ── Initialization ──────────────────────────────────────────────────────────

/**
 * Hydrate all MA state for a task from DB into in-memory caches.
 * Called at startup (for each task) and on first access.
 * Correction #21: startup must fully hydrate before building snapshots.
 */
export function hydrateTaskMAState(taskId: string): void {
  const instances = listAgentInstances(true, taskId);
  for (const inst of instances) {
    _instances.set(inst.id, inst);
  }

  const workItems = listWorkItems(true, taskId);
  for (const wi of workItems) {
    _workItems.set(wi.id, wi);
  }

  const proposals = listSubtaskProposals(true, taskId);
  for (const p of proposals) {
    _proposals.set(p.id, p);
  }

  const reviews = listReviewResults(true, taskId);
  for (const r of reviews) {
    const key = `${r.targetWorkItemId}:${r.reviewedAttempt}`;
    _reviews.set(key, r);
  }

  const assignments = listAssignmentHistory(true, taskId);
  for (const a of assignments) {
    _assignments.set(a.id, a);
  }

  if (!_counters.has(taskId)) {
    _counters.set(taskId, _makeEmptyCounters());
  }
  if (!_revisions.has(taskId)) {
    _revisions.set(taskId, 0);
  }

  forgeLogger.debug("task", "MA_STARTUP_HYDRATED", {
    metadata: {
      taskId,
      instances: instances.length,
      workItems: workItems.length,
      proposals: proposals.length,
    },
  });
}

// ── Execution mode ──────────────────────────────────────────────────────────

export function setExecutionMode(taskId: string, mode: TaskExecutionMode): void {
  _executionMode.set(taskId, mode);
}

export function getExecutionMode(taskId: string): TaskExecutionMode {
  return _executionMode.get(taskId) ?? "single_agent";
}

// ── AgentInstance ────────────────────────────────────────────────────────────

export interface CreateInstanceOptions {
  taskId: string;
  role: AgentRole;
  profileId: string | null;
}

export function createInstance(opts: CreateInstanceOptions): AgentInstance {
  // INV: MA_COORDINATOR_EXCLUDED_FROM_WORKER_LIMIT
  if (opts.role !== "coordinator") {
    const activeWorkers = getActiveWorkerCount(opts.taskId);
    assertInvariant(
      "MA_WORKER_COUNT_WITHIN_BUDGET",
      activeWorkers < MA_MAX_WORKERS,
      { taskId: opts.taskId, activeWorkers, limit: MA_MAX_WORKERS },
      { hint: "Worker count budget exceeded" }
    );
  }

  const inst: AgentInstance = {
    id: randomUUID(),
    taskId: opts.taskId,
    role: opts.role,
    profileId: opts.profileId,
    status: "idle",
    currentWorkItemId: null,
    completedWorkItems: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeAgentRunId: null,
  };

  _instances.set(inst.id, inst);
  saveAgentInstance(true, inst);
  _bumpCounters(opts.taskId, { workersCreated: 1 });
  _bumpRevision(opts.taskId);

  forgeLogger.info("task", "MA_INSTANCE_CREATED", {
    metadata: { taskId: opts.taskId, instanceId: inst.id, role: inst.role },
  });

  return structuredClone(inst);
}

export function getInstanceById(id: string): AgentInstance | null {
  return structuredClone(_instances.get(id) ?? null);
}

export function updateInstance(id: string, patch: Partial<AgentInstance>): AgentInstance | null {
  const existing = _instances.get(id);
  if (!existing) return null;
  const updated: AgentInstance = { ...existing, ...patch, updatedAt: Date.now() };
  _instances.set(id, updated);
  updateAgentInstance(true, id, patch);
  _bumpRevision(existing.taskId);
  return structuredClone(updated);
}

export function getCoordinatorInstance(taskId: string): AgentInstance | null {
  for (const inst of _instances.values()) {
    if (inst.taskId === taskId && inst.role === "coordinator") {
      return structuredClone(inst);
    }
  }
  return null;
}

export function getActiveWorkerCount(taskId: string): number {
  let count = 0;
  for (const inst of _instances.values()) {
    if (
      inst.taskId === taskId &&
      inst.role !== "coordinator" &&
      (inst.status === "working" || inst.status === "reviewing" ||
       inst.status === "waiting_for_human" || inst.status === "waiting_for_approval")
    ) {
      count++;
    }
  }
  return count;
}

export function getPeakConcurrentWorkers(taskId: string): number {
  return _counters.get(taskId)?.peakConcurrentWorkers ?? 0;
}

/** Find an idle worker instance with compatible role (for reuse, correction #13) */
export function findReusableInstance(taskId: string, role: AgentRole): AgentInstance | null {
  for (const inst of _instances.values()) {
    if (
      inst.taskId === taskId &&
      inst.role === role &&
      inst.status === "idle_reuse"
    ) {
      return structuredClone(inst);
    }
  }
  return null;
}

// ── AgentWorkItem ─────────────────────────────────────────────────────────────

export interface CreateWorkItemOptions {
  taskId: string;
  taskStepId: string | null;
  planVersion: number;
  title: string;
  description: string;
  kind: WorkItemKind;
  expectedOutcome: string;
  capabilityHints: string[];
  resourceTargets: string[];
  suggestedRole: AgentRole;
  dependencies: WorkItemDependency[];
  createdByType: WorkItemCreatedByType;
  createdByAgentId: string | null;
  sourceProposalId: string | null;
  depth?: number;
}

/**
 * Compute a deterministic duplicate fingerprint for a work item.
 * sha256(taskId + ":" + kind + ":" + normalized_title)
 */
export function computeWorkItemFingerprint(taskId: string, kind: WorkItemKind, title: string): string {
  const normalized = title.toLowerCase().replace(/\W+/g, " ").trim();
  return createHash("sha256").update(`${taskId}:${kind}:${normalized}`).digest("hex").slice(0, 16);
}

/**
 * Check if a work item with this fingerprint already exists for the task.
 */
export function findDuplicateWorkItem(taskId: string, fingerprint: string): AgentWorkItem | null {
  for (const wi of _workItems.values()) {
    if (wi.taskId === taskId && wi.duplicateFingerprint === fingerprint) {
      return structuredClone(wi);
    }
  }
  return null;
}

export function createWorkItem(opts: CreateWorkItemOptions): AgentWorkItem {
  // Depth guard
  const depth = opts.depth ?? 1;
  assertInvariant(
    "MA_WORK_ITEM_COUNT_WITHIN_BUDGET",
    depth <= MA_MAX_SPAWN_DEPTH,
    { taskId: opts.taskId, depth, limit: MA_MAX_SPAWN_DEPTH },
    { hint: "Work item spawn depth exceeded" }
  );

  // Work item count guard
  const existing = getWorkItemsForTask(opts.taskId);
  assertInvariant(
    "MA_WORK_ITEM_COUNT_WITHIN_BUDGET",
    existing.length < MA_MAX_WORK_ITEMS,
    { taskId: opts.taskId, count: existing.length, limit: MA_MAX_WORK_ITEMS },
    { hint: "Work item count budget exceeded" }
  );

  // Duplicate fingerprint detection (correction #9)
  const fingerprint = computeWorkItemFingerprint(opts.taskId, opts.kind, opts.title);
  const dup = findDuplicateWorkItem(opts.taskId, fingerprint);
  if (dup) {
    forgeLogger.warn("task", "MA_DUPLICATE_FINGERPRINT_BLOCKED", {
      metadata: { taskId: opts.taskId, fingerprint, existingId: dup.id, title: opts.title },
    });
    // Return the existing item rather than creating a duplicate
    return dup;
  }

  const wi: AgentWorkItem = {
    id: randomUUID(),
    taskId: opts.taskId,
    taskStepId: opts.taskStepId,
    planVersion: opts.planVersion,
    depth,
    title: opts.title,
    description: opts.description,
    kind: opts.kind,
    expectedOutcome: opts.expectedOutcome,
    capabilityHints: opts.capabilityHints,
    resourceTargets: opts.resourceTargets,
    suggestedRole: opts.suggestedRole,
    dependencies: opts.dependencies,
    status: "pending",
    assignedInstanceId: null,
    attemptCount: 0,
    reassignCount: 0,
    createdByType: opts.createdByType,
    createdByAgentId: opts.createdByAgentId,
    sourceProposalId: opts.sourceProposalId,
    duplicateFingerprint: fingerprint,
    lastResult: null,
    evidenceRefs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    lastAttemptAt: null,
    reviewCycles: 0,
    reviewWorkItemId: null,
    skipSatisfiesDependencies: false,
  };

  _workItems.set(wi.id, wi);
  saveWorkItem(true, wi);
  _bumpCounters(opts.taskId, { workItemsCreated: 1 });
  _bumpRevision(opts.taskId);

  forgeLogger.info("task", "MA_WORK_ITEM_CREATED", {
    metadata: { taskId: opts.taskId, workItemId: wi.id, title: wi.title, kind: wi.kind },
  });

  return structuredClone(wi);
}

export function getWorkItemById(id: string): AgentWorkItem | null {
  return structuredClone(_workItems.get(id) ?? null);
}

export function updateWorkItem(id: string, patch: Partial<AgentWorkItem>): AgentWorkItem | null {
  const existing = _workItems.get(id);
  if (!existing) return null;
  const updated: AgentWorkItem = { ...existing, ...patch, updatedAt: Date.now() };
  _workItems.set(id, updated);
  dbUpdateWorkItem(true, id, patch);
  _bumpRevision(existing.taskId);
  return structuredClone(updated);
}

export function getWorkItemsForTask(taskId: string): AgentWorkItem[] {
  const result: AgentWorkItem[] = [];
  for (const wi of _workItems.values()) {
    if (wi.taskId === taskId) result.push(structuredClone(wi));
  }
  return result;
}

/**
 * Get work items whose dependencies are all satisfied.
 * Correction #10: skipped deps only satisfy when skipSatisfiesDependencies = true.
 */
export function getReadyWorkItems(taskId: string): AgentWorkItem[] {
  const allItems = getWorkItemsForTask(taskId);
  const satisfiedStatuses: Set<WorkItemStatus> = new Set(["completed"]);

  return allItems.filter((wi) => {
    if (wi.status !== "pending" && wi.status !== "interrupted") return false;

    return wi.dependencies.every((dep) => {
      const depItem = _workItems.get(dep.workItemId);
      if (!depItem) return false;

      if (satisfiedStatuses.has(depItem.status)) return true;

      // Skipped: only satisfied when coordinator explicitly set skipSatisfiesDependencies
      if (depItem.status === "skipped") {
        return dep.skipSatisfiesDependencies === true;
      }

      // All other statuses (failed, blocked, interrupted, cancelled, pending, running, etc.) → not satisfied
      return false;
    });
  });
}

// ── SubtaskProposal ────────────────────────────────────────────────────────────

export function createProposal(proposal: SubtaskProposal): SubtaskProposal {
  _proposals.set(proposal.id, proposal);
  saveSubtaskProposal(true, proposal);
  _bumpRevision(proposal.taskId);

  // INV: SUBTASK_PROPOSAL_HAS_PROVENANCE
  assertInvariant(
    "SUBTASK_PROPOSAL_HAS_PROVENANCE",
    Boolean(proposal.sourceWorkItemId && proposal.proposedByAgentId),
    { proposalId: proposal.id, sourceWorkItemId: proposal.sourceWorkItemId },
    { hint: "Subtask proposal must have sourceWorkItemId and proposedByAgentId" }
  );

  forgeLogger.info("task", "MA_PROPOSAL_RAISED", {
    metadata: {
      taskId: proposal.taskId,
      proposalId: proposal.id,
      title: proposal.title,
      sourceWorkItemId: proposal.sourceWorkItemId,
    },
  });

  return structuredClone(proposal);
}

export function updateProposal(id: string, patch: Partial<SubtaskProposal>): SubtaskProposal | null {
  const existing = _proposals.get(id);
  if (!existing) return null;
  const updated: SubtaskProposal = { ...existing, ...patch };
  _proposals.set(id, updated);
  updateSubtaskProposal(true, id, patch);
  _bumpRevision(existing.taskId);
  return structuredClone(updated);
}

export function getProposalById(id: string): SubtaskProposal | null {
  return structuredClone(_proposals.get(id) ?? null);
}

export function getPendingProposals(taskId: string): SubtaskProposal[] {
  const result: SubtaskProposal[] = [];
  for (const p of _proposals.values()) {
    if (p.taskId === taskId && p.status === "pending") {
      result.push(structuredClone(p));
    }
  }
  return result;
}

export function getAllProposalsForTask(taskId: string): SubtaskProposal[] {
  const result: SubtaskProposal[] = [];
  for (const p of _proposals.values()) {
    if (p.taskId === taskId) result.push(structuredClone(p));
  }
  return result;
}

// ── ReviewResult ──────────────────────────────────────────────────────────────

export function addReviewResult(review: ReviewResult): void {
  const key = `${review.targetWorkItemId}:${review.reviewedAttempt}`;
  _reviews.set(key, review);
  saveReviewResult(true, review);
  _bumpRevision(_workItems.get(review.targetWorkItemId)?.taskId ?? "");
}

export function getReviewForAttempt(targetWorkItemId: string, attempt: number): ReviewResult | null {
  const key = `${targetWorkItemId}:${attempt}`;
  return structuredClone(_reviews.get(key) ?? null);
}

export function getAllReviewsForTask(taskId: string): ReviewResult[] {
  const result: ReviewResult[] = [];
  for (const r of _reviews.values()) {
    const wi = _workItems.get(r.targetWorkItemId);
    if (wi?.taskId === taskId) result.push(structuredClone(r));
  }
  return result;
}

// ── Assignment history ─────────────────────────────────────────────────────────

export function recordAssignment(entry: AssignmentHistoryEntry): void {
  _assignments.set(entry.id, entry);
  saveAssignmentHistory(true, entry);
  _bumpCounters(entry.taskId, { reassignments: entry.attemptNumber > 1 ? 1 : 0 });
}

export function closeAssignment(id: string, outcome: AssignmentHistoryEntry["outcome"]): void {
  const existing = _assignments.get(id);
  if (!existing) return;
  const updated: AssignmentHistoryEntry = {
    ...existing,
    outcome,
    completedAt: Date.now(),
  };
  _assignments.set(id, updated);
  updateAssignmentHistory(true, id, { outcome, completedAt: Date.now() });
}

export function getAssignmentHistoryForTask(taskId: string): AssignmentHistoryEntry[] {
  const result: AssignmentHistoryEntry[] = [];
  for (const e of _assignments.values()) {
    if (e.taskId === taskId) result.push(structuredClone(e));
  }
  return result.sort((a, b) => a.assignedAt - b.assignedAt);
}

// ── Budget counters ────────────────────────────────────────────────────────────

export function getBudgetCounters(taskId: string): MABudgetCounters {
  return structuredClone(_counters.get(taskId) ?? _makeEmptyCounters());
}

export function bumpBudgetCounter(
  taskId: string,
  field: keyof MABudgetCounters,
  delta = 1
): void {
  const c = _counters.get(taskId) ?? _makeEmptyCounters();
  (c[field] as number) += delta;
  // Track peak concurrent workers
  if (field === "workersCreated") {
    const current = getActiveWorkerCount(taskId);
    if (current > c.peakConcurrentWorkers) c.peakConcurrentWorkers = current;
  }
  _counters.set(taskId, c);
}

// ── Snapshot ────────────────────────────────────────────────────────────────────

/**
 * Build a complete MultiAgentTaskSnapshot for a task.
 * This is the single source of truth for the renderer.
 */
export function buildSnapshot(taskId: string): MultiAgentTaskSnapshot {
  const revision = _revisions.get(taskId) ?? 0;
  const mode = _executionMode.get(taskId) ?? "single_agent";

  const instances: AgentInstance[] = [];
  for (const inst of _instances.values()) {
    if (inst.taskId === taskId) instances.push(structuredClone(inst));
  }

  const coordinator = instances.find((i) => i.role === "coordinator") ?? null;

  const workItems = getWorkItemsForTask(taskId);
  const proposals = getAllProposalsForTask(taskId);
  const reviews = getAllReviewsForTask(taskId);
  const assignmentHistory = getAssignmentHistoryForTask(taskId);
  const resourceLeases = listLeasesForTask(taskId);
  const counters = getBudgetCounters(taskId);

  return {
    taskId,
    executionMode: mode,
    revision,
    updatedAt: Date.now(),
    coordinatorInstanceId: coordinator?.id ?? null,
    coordinatorStatus: coordinator?.status ?? null,
    coordinatorTurnNumber: counters.coordinatorTurns,
    instances: instances.filter((i) => i.role !== "coordinator"),
    workItems,
    proposals,
    reviews,
    assignmentHistory,
    budgetCounters: counters,
    resourceLeases,
  };
}

// ── Task cleanup ────────────────────────────────────────────────────────────────

/**
 * Full cleanup for a task (cancel/terminal).
 * Releases resource leases. In-memory caches remain for UI inspection.
 */
export function cleanupTaskMAState(taskId: string): void {
  releaseAllLeasesForTask(taskId);
  forgeLogger.info("task", "MA_ORCHESTRATION_STOPPED", { metadata: { taskId } });
}

/** Reset all MA state — for test isolation */
export function resetMAStore(): void {
  _instances.clear();
  _workItems.clear();
  _proposals.clear();
  _reviews.clear();
  _assignments.clear();
  _counters.clear();
  _revisions.clear();
  _executionMode.clear();
}

// ── Private helpers ─────────────────────────────────────────────────────────────

function _makeEmptyCounters(): MABudgetCounters {
  return {
    workersCreated: 0,
    peakConcurrentWorkers: 0,
    workItemsCreated: 0,
    coordinatorTurns: 0,
    providerTurnsByWorker: 0,
    reviewCycles: 0,
    reassignments: 0,
    subtasksAccepted: 0,
    subtasksRejected: 0,
  };
}

function _bumpCounters(taskId: string, patch: Partial<MABudgetCounters>): void {
  const c = _counters.get(taskId) ?? _makeEmptyCounters();
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "number") {
      (c[k as keyof MABudgetCounters] as number) += v;
    }
  }
  // Track peak concurrent workers whenever counters are bumped
  const active = getActiveWorkerCount(taskId);
  if (active > c.peakConcurrentWorkers) c.peakConcurrentWorkers = active;
  _counters.set(taskId, c);
}

function _bumpRevision(taskId: string): void {
  if (!taskId) return;
  const current = _revisions.get(taskId) ?? 0;
  _revisions.set(taskId, current + 1);
}

// Re-export db getter for test setup
export { dbGetInstance, dbGetWorkItem };