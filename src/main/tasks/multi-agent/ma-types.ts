/**
 * Multi-Agent Orchestration V1 — Shared Types
 *
 * All new types live here. Do NOT duplicate ForgeTask/ForgeTaskStep/ForgeTaskPlan —
 * those are the root entities. Work items are the execution decomposition
 * beneath plan steps, not a second plan hierarchy.
 *
 * Hierarchy:
 *   ForgeTask (user-facing root, TaskRunner owns lifecycle)
 *     → ForgeTaskPlan / ForgeTaskStep (high-level user plan)
 *     → AgentWorkItem[] (execution decomposition per step)
 *       → AgentInstance (worker/coordinator assigned to item)
 *         → AgentRun (existing, extended with workItemId + agentInstanceId)
 *           → EvidenceRecord (existing evidence-registry)
 */

// ── Budget constants ───────────────────────────────────────────────────────

/** Maximum concurrently active worker instances (coordinator excluded) */
export const MA_MAX_WORKERS = 3;

/** Maximum work items per task (all statuses combined) */
export const MA_MAX_WORK_ITEMS = 20;

/** Maximum execution attempts per work item before hard failure */
export const MA_MAX_ATTEMPTS = 3;

/** Maximum reassignments per work item before hard failure */
export const MA_MAX_REASSIGN = 2;

/** Maximum review cycles per work item before accepting or failing */
export const MA_MAX_REVIEW_CYCLES = 2;

/** Maximum depth of proposed subtask chains (root task depth = 1) */
export const MA_MAX_SPAWN_DEPTH = 3;

/** Maximum coordinator orchestration turns per task */
export const MA_MAX_COORDINATOR_TURNS = 30;

// ── Agent roles ────────────────────────────────────────────────────────────

export type AgentRole =
  | "coordinator"
  | "coder"
  | "reviewer"
  | "browser_qa"
  | "researcher"
  | "debugger"
  | "generic";

// ── Execution mode ─────────────────────────────────────────────────────────

/** How a task's work items are executed */
export type TaskExecutionMode = "single_agent" | "multi_agent";

// ── Agent instance ─────────────────────────────────────────────────────────

export type AgentInstanceStatus =
  | "idle"         // created but not yet assigned
  | "working"      // executing a work item
  | "reviewing"    // executing a review item
  | "waiting_for_human"  // blocked on user input inside a work item
  | "waiting_for_approval" // blocked on permission approval
  | "failed"       // terminal: could not complete assigned work
  | "idle_reuse"   // completed a work item; may be reassigned
  | "retired";     // terminal: no more work; instance lifecycle ended

/**
 * Represents one agent worker or coordinator executing inside a ForgeTask.
 * Coordinator: one per task (role = "coordinator").
 * Workers: created on demand, may be reused for compatible subsequent work items.
 */
export interface AgentInstance {
  id: string;
  taskId: string;
  role: AgentRole;
  /** AgentProfile id to use for this instance — null means use conversation default */
  profileId: string | null;
  status: AgentInstanceStatus;
  /** Currently assigned work item id (null when idle/retired) */
  currentWorkItemId: string | null;
  /** Total work items completed by this instance */
  completedWorkItems: number;
  createdAt: number;
  updatedAt: number;
  /** Active AgentRun id (null when not running) */
  activeAgentRunId: string | null;
}

// ── Work item ─────────────────────────────────────────────────────────────

export type WorkItemStatus =
  | "pending"           // created, not yet assigned
  | "assigned"          // assigned to an instance, not yet started
  | "running"           // execution in progress
  | "waiting_for_human" // worker blocked on human input
  | "waiting_for_approval" // worker blocked on permission
  | "reviewing"         // a reviewer is examining the result
  | "completed"         // terminal: finished successfully
  | "failed"            // terminal: exhausted attempts
  | "cancelled"         // terminal: task cancelled or dependency chain broken
  | "skipped"           // coordinator explicitly skipped (satisfiesDependencies may or may not be true)
  | "interrupted"       // task paused mid-execution — retryable
  | "blocked";          // a dependency is not satisfied; coordinator must act

/** What kind of work this item represents */
export type WorkItemKind =
  | "implementation"  // code writing, editing
  | "research"        // reading, searching, gathering info
  | "browse"          // browser-based investigation or test
  | "review"          // quality/correctness review of a sibling item's output
  | "verify"          // automated test/build verification
  | "git"             // git operations (stage/commit)
  | "debug"           // debugging a failing test or error
  | "generic";        // unclassified

/** Provenance tracking for how a work item was created */
export type WorkItemCreatedByType =
  | "coordinator_initial" // initial decomposition by coordinator
  | "coordinator_replan"  // coordinator re-planned and added this item
  | "worker_proposal"     // worker proposed and coordinator accepted
  | "subtask_accept"      // coordinator accepted an explicit SubtaskProposal
  | "system";             // created by task runtime (e.g., review injection)

/**
 * Dependency satisfaction semantics:
 * - "completed" deps are always satisfied
 * - "skipped" deps are satisfied only if `skipSatisfiesDependencies = true`
 * - "failed" / "blocked" / "interrupted" / "cancelled" deps are NEVER satisfied
 */
export interface WorkItemDependency {
  workItemId: string;
  /** When the dependency is skipped, is that treated as satisfied? Default false. */
  skipSatisfiesDependencies: boolean;
}

/**
 * Work item — the execution unit beneath a ForgeTaskStep.
 * Multiple work items may map to one TaskStep.
 */
export interface AgentWorkItem {
  id: string;
  taskId: string;
  /** Depth in task graph (root task-level items = 1) */
  depth: number;

  // ── Plan linkage (correction #1) ──────────────────────────────────────
  /** Which TaskStep this work item rolls up into (null = not linked to a step) */
  taskStepId: string | null;
  /** Plan version this item was created under */
  planVersion: number;

  // ── Content ───────────────────────────────────────────────────────────
  title: string;
  description: string;
  kind: WorkItemKind;
  /** Expected outcome for verification purposes */
  expectedOutcome: string;
  /** Capability hints for context injection */
  capabilityHints: string[];
  /** Resources the worker is expected to interact with */
  resourceTargets: string[];
  /** Role archetype recommended for this item */
  suggestedRole: AgentRole;

  // ── Dependency graph ─────────────────────────────────────────────────
  dependencies: WorkItemDependency[];

  // ── Status + execution ───────────────────────────────────────────────
  status: WorkItemStatus;
  /** Assigned instance id (null = unassigned) */
  assignedInstanceId: string | null;
  /** Attempt count across all assignments */
  attemptCount: number;
  /** Number of times this item has been reassigned */
  reassignCount: number;

  // ── Provenance (correction #8) ────────────────────────────────────────
  createdByType: WorkItemCreatedByType;
  createdByAgentId: string | null;
  /** If this item was created by accepting a SubtaskProposal */
  sourceProposalId: string | null;

  // ── Duplicate fingerprint (correction #9) ─────────────────────────────
  /**
   * Deterministic fingerprint: sha256(taskId + kind + title.toLowerCase().replace(/\W+/g, ' ').trim())
   * Used for duplicate detection.
   */
  duplicateFingerprint: string;

  // ── Result tracking ──────────────────────────────────────────────────
  lastResult: WorkItemResult | null;
  evidenceRefs: string[];

  // ── Timestamps ───────────────────────────────────────────────────────
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  lastAttemptAt: number | null;

  // ── Review tracking ──────────────────────────────────────────────────
  reviewCycles: number;
  /** ID of the review work item that reviewed this item (if any) */
  reviewWorkItemId: string | null;

  /** Whether coordinator explicitly set skip to satisfy dependencies (correction #10) */
  skipSatisfiesDependencies: boolean;
}

// ── Work item result ───────────────────────────────────────────────────────

/**
 * Structured output from a worker's execution.
 * Travels through the existing forge_step_result fence — no new parser needed (correction #3).
 * discoveredSubtasks are extracted from the result summary / observations,
 * not from a separate propose_subtask fence.
 */
export interface WorkItemResult {
  status: "completed" | "blocked" | "failed" | "replan_required" | "protocol_recovery";
  summary: string;
  evidenceRefs: string[];
  observations?: string;
  /** Subtasks the worker discovered during execution */
  discoveredSubtasks: SubtaskProposal[];
}

// ── Subtask proposal (correction #7) ──────────────────────────────────────

export type SubtaskProposalStatus =
  | "pending"   // awaiting coordinator decision
  | "accepted"  // coordinator accepted → work item created
  | "merged"    // coordinator merged into an existing item
  | "rejected"  // coordinator rejected
  | "deferred"; // coordinator deferred to later

/**
 * A SubtaskProposal is a persisted entity with full provenance.
 * Workers may include proposals in their WorkItemResult.discoveredSubtasks.
 * The coordinator makes an explicit decision on each proposal.
 */
export interface SubtaskProposal {
  id: string;
  taskId: string;
  /** Which work item raised this proposal */
  sourceWorkItemId: string;
  /** Which agent instance raised this proposal */
  proposedByAgentId: string;

  title: string;
  description: string;
  reason: string;
  dependencies: WorkItemDependency[];
  capabilityHints: string[];
  resourceTargets: string[];
  suggestedRole: AgentRole;
  expectedOutcome: string;

  status: SubtaskProposalStatus;
  /** Which coordinator turn resolved this */
  coordinatorDecision?: CoordinatorDecisionRecord;

  createdAt: number;
  resolvedAt: number | null;
}

// ── Coordinator decision record (for auditing) ────────────────────────────

export interface CoordinatorDecisionRecord {
  turnNumber: number;
  action: string;
  timestamp: number;
  note?: string;
}

// ── Review result (correction #14) ────────────────────────────────────────

export type ReviewVerdict = "APPROVE" | "CHANGES_REQUIRED" | "REJECT";

export interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "info";
  description: string;
  location?: string;
}

/**
 * Typed result from a reviewer work item.
 * Must reference the exact attempt it reviewed (stale-review protection).
 */
export interface ReviewResult {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  evidenceRefs: string[];
  /** Which work item was reviewed */
  targetWorkItemId: string;
  /** The attempt count of the target work item at the time of review */
  reviewedAttempt: number;
  /** The attempt count of the reviewing work item */
  reviewAttempt: number;
  /** Stale if target has progressed to a newer attempt since review started */
  isStale: boolean;
  createdAt: number;
}

// ── Coordinator action schema ─────────────────────────────────────────────

export type CoordinatorActionType =
  | "create_work_item"
  | "assign_work_item"
  | "accept_subtask"
  | "reject_subtask"
  | "merge_subtask"
  | "request_review"
  | "mark_ready_for_verification"  // replaces mark_task_complete (correction #2)
  | "replan"
  | "pause";

export interface CreateWorkItemAction {
  type: "create_work_item";
  title: string;
  description: string;
  kind: WorkItemKind;
  taskStepId: string | null;
  dependencies: WorkItemDependency[];
  capabilityHints: string[];
  resourceTargets: string[];
  suggestedRole: AgentRole;
  expectedOutcome: string;
}

export interface AssignWorkItemAction {
  type: "assign_work_item";
  workItemId: string;
  /** If null, coordinator may reuse an idle instance or create a new one */
  agentInstanceId: string | null;
}

export interface AcceptSubtaskAction {
  type: "accept_subtask";
  proposalId: string;
  modifications?: Partial<Pick<SubtaskProposal, "title" | "description" | "capabilityHints" | "dependencies">>;
}

export interface RejectSubtaskAction {
  type: "reject_subtask";
  proposalId: string;
  reason: string;
}

export interface MergeSubtaskAction {
  type: "merge_subtask";
  proposalId: string;
  /** Merge proposal into this existing work item */
  intoWorkItemId: string;
}

export interface RequestReviewAction {
  type: "request_review";
  /** The work item whose output should be reviewed */
  targetWorkItemId: string;
  reviewerRole: AgentRole;
}

export interface MarkReadyForVerificationAction {
  type: "mark_ready_for_verification";
  summary: string;
  evidenceRefs: string[];
}

export interface ReplanAction {
  type: "replan";
  reason: string;
}

export interface PauseAction {
  type: "pause";
  reason: string;
}

export type CoordinatorAction =
  | CreateWorkItemAction
  | AssignWorkItemAction
  | AcceptSubtaskAction
  | RejectSubtaskAction
  | MergeSubtaskAction
  | RequestReviewAction
  | MarkReadyForVerificationAction
  | ReplanAction
  | PauseAction;

/** Validated output from one coordinator turn */
export interface CoordinatorTurnResult {
  actions: CoordinatorAction[];
  rawText: string;
  turnNumber: number;
  agentRunId: string;
  completedAt: number;
}

// ── MA snapshot (renderer-read-only) ─────────────────────────────────────

/** Counter snapshot for cost/budget tracking (correction #19) */
export interface MABudgetCounters {
  workersCreated: number;
  peakConcurrentWorkers: number;
  workItemsCreated: number;
  coordinatorTurns: number;
  providerTurnsByWorker: number;
  reviewCycles: number;
  reassignments: number;
  subtasksAccepted: number;
  subtasksRejected: number;
}

/** Complete multi-agent orchestration snapshot for a task (pushed to renderer) */
export interface MultiAgentTaskSnapshot {
  taskId: string;
  executionMode: TaskExecutionMode;
  revision: number;
  updatedAt: number;

  // Coordinator
  coordinatorInstanceId: string | null;
  coordinatorStatus: AgentInstanceStatus | null;
  coordinatorTurnNumber: number;

  // Agents
  instances: AgentInstance[];

  // Work item graph
  workItems: AgentWorkItem[];

  // Proposals
  proposals: SubtaskProposal[];

  // Reviews
  reviews: ReviewResult[];

  // Assignment history
  assignmentHistory: AssignmentHistoryEntry[];

  // Budget
  budgetCounters: MABudgetCounters;

  // Resource leases (from ResourceManager)
  resourceLeases: ResourceLeaseSnapshot[];
}

// ── Assignment history ─────────────────────────────────────────────────────

export interface AssignmentHistoryEntry {
  id: string;
  taskId: string;
  workItemId: string;
  agentInstanceId: string;
  assignedAt: number;
  completedAt: number | null;
  outcome: "completed" | "failed" | "reassigned" | "cancelled" | "interrupted" | null;
  attemptNumber: number;
}

// ── Resource lease (correction #11) ───────────────────────────────────────

export type ResourceLeaseMode = "read" | "write" | "exclusive";

export interface ResourceLease {
  id: string;
  resourceKey: string;
  ownerAgentId: string;
  ownerWorkItemId: string;
  taskId: string;
  mode: ResourceLeaseMode;
  acquiredAt: number;
}

export interface ResourceLeaseSnapshot {
  resourceKey: string;
  ownerAgentId: string;
  ownerWorkItemId: string;
  mode: ResourceLeaseMode;
  acquiredAt: number;
}

// ── IPC channels ──────────────────────────────────────────────────────────

export const MA_IPC = {
  // Renderer → Main
  IS_ENABLED:             "ma:isEnabled",
  GET_SNAPSHOT:           "ma:getSnapshot",
  LIST_INSTANCES:         "ma:listInstances",
  GET_WORK_ITEMS:         "ma:getWorkItems",
  GET_PROPOSALS:          "ma:getProposals",
  GET_REVIEWS:            "ma:getReviews",
  GET_BUDGET_COUNTERS:    "ma:getBudgetCounters",

  // Main → Renderer (push)
  SNAPSHOT_UPDATED:       "ma:snapshotUpdated",
  WORK_ITEM_CREATED:      "ma:workItemCreated",
  WORK_ITEM_UPDATED:      "ma:workItemUpdated",
  INSTANCE_UPDATED:       "ma:instanceUpdated",
  PROPOSAL_UPDATED:       "ma:proposalUpdated",
  REVIEW_CREATED:         "ma:reviewCreated",
  COORDINATOR_TURN:       "ma:coordinatorTurn",
} as const;

// ── Log events ────────────────────────────────────────────────────────────

export type MultiAgentLogEvent =
  | "MA_ORCHESTRATION_STARTED"
  | "MA_ORCHESTRATION_STOPPED"
  | "MA_COORDINATOR_TURN_STARTED"
  | "MA_COORDINATOR_TURN_COMPLETED"
  | "MA_COORDINATOR_ACTION_APPLIED"
  | "MA_WORK_ITEM_CREATED"
  | "MA_WORK_ITEM_ASSIGNED"
  | "MA_WORK_ITEM_STARTED"
  | "MA_WORK_ITEM_COMPLETED"
  | "MA_WORK_ITEM_FAILED"
  | "MA_WORK_ITEM_BLOCKED"
  | "MA_WORK_ITEM_INTERRUPTED"
  | "MA_INSTANCE_CREATED"
  | "MA_INSTANCE_RETIRED"
  | "MA_INSTANCE_REUSED"
  | "MA_PROPOSAL_RAISED"
  | "MA_PROPOSAL_ACCEPTED"
  | "MA_PROPOSAL_REJECTED"
  | "MA_REVIEW_STARTED"
  | "MA_REVIEW_COMPLETED"
  | "MA_REVIEW_STALE"
  | "MA_DEPENDENCY_BLOCKED"
  | "MA_DEPENDENCY_SATISFIED"
  | "MA_RESOURCE_ACQUIRED"
  | "MA_RESOURCE_RELEASED"
  | "MA_RESOURCE_CONFLICT"
  | "MA_BUDGET_EXCEEDED"
  | "MA_DUPLICATE_FINGERPRINT_BLOCKED"
  | "MA_READY_FOR_VERIFICATION"
  | "MA_PAUSED"
  | "MA_CANCELLED"
  | "MA_RECONCILED"
  | "MA_STARTUP_HYDRATED";

// ── Invariant IDs ────────────────────────────────────────────────────────

export type MultiAgentInvariantId =
  | "TASK_PLAN_AND_WORKITEM_GRAPH_CONSISTENT"
  | "WORK_ITEM_AGENTRUN_METADATA_MATCHES"
  | "COORDINATOR_HAS_NO_EXECUTION_TOOLS"
  | "ROOT_TASK_COMPLETION_REQUIRES_TASK_VERIFICATION"
  | "STALE_REVIEW_CANNOT_APPROVE_NEW_ATTEMPT"
  | "SKIPPED_DEPENDENCY_NOT_IMPLICITLY_SATISFIED"
  | "SUBTASK_PROPOSAL_HAS_PROVENANCE"
  | "TERMINAL_WORK_ITEM_HAS_NO_RESOURCE_LEASE"
  | "ONE_FINAL_ASSISTANT_MESSAGE_PER_ROOT_TASK"
  | "MA_COORDINATOR_CANNOT_COMPLETE_ROOT_TASK"
  | "MA_WORKER_COUNT_WITHIN_BUDGET"
  | "MA_WORK_ITEM_COUNT_WITHIN_BUDGET"
  | "MA_COORDINATOR_EXCLUDED_FROM_WORKER_LIMIT";

// ── Incident codes ────────────────────────────────────────────────────────

export type MultiAgentIncidentCode =
  | "MA_STALLED_NO_PROGRESS"
  | "MA_DEPENDENCY_CYCLE_DETECTED"
  | "MA_DUPLICATE_WORK_ITEM_BLOCKED"
  | "MA_REVIEW_STALE_CANNOT_APPROVE"
  | "MA_COORDINATOR_BUDGET_EXCEEDED"
  | "MA_WORKER_BUDGET_EXCEEDED"
  | "MA_SKIPPED_DEP_IMPLICIT_SATISFY_REJECTED"
  | "MA_RESOURCE_CONFLICT_DEADLOCK"
  | "MA_WORK_ITEM_SPAWNED_WITHOUT_PROVENANCE"
  | "MA_COORDINATOR_TRIED_COMPLETE_ROOT_TASK"
  | "MA_WORKER_EMITTED_CHAT_MESSAGE"
  | "MA_INSTANCE_LEAK_DETECTED";

// ── Internal execution metadata (correction #6) ──────────────────────────

/**
 * Full canonical metadata propagated through every internal task execution.
 * Must be present on every AgentRun created by the multi-agent system.
 */
export interface MARunMetadata {
  taskId: string;
  planVersion: number;
  taskStepId: string | null;
  workItemId: string;
  workItemAttempt: number;
  agentInstanceId: string;
  conversationId: string;
  projectId: string | null;
}

// ── Orchestration start options ───────────────────────────────────────────

export interface MAOrchestrationOptions {
  task: import("../../../shared/types.js").ForgeTask;
  plan: import("../../../shared/types.js").ForgeTaskPlan;
  cfg: import("../../../shared/types.js").AgentConfig;
  apiKey: string;
  signal: AbortSignal;
  /** Callback: update root task in TaskRunner state (pass-through; no DB write) */
  onTaskUpdate: (task: import("../../../shared/types.js").ForgeTask) => void;
  /** Callback: snapshot push to renderer */
  pushSnapshot: (task: import("../../../shared/types.js").ForgeTask, plan: import("../../../shared/types.js").ForgeTaskPlan) => void;
  /** Callback: coordinator is ready to hand off to task verification */
  onReadyForVerification: (summary: string, evidenceRefs: string[]) => void;
  /** Callback: coordinator requests a task replan */
  onReplanRequested: (reason: string) => void;
  /** Callback: task should be paused */
  onPauseRequested: (reason: string) => void;
  /** Callback: incident */
  onIncident: (invariantId: string, meta: Record<string, unknown>) => void;
}