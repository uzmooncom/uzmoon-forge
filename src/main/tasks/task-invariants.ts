/**
 * task-invariants.ts — Task Runtime V1 invariant registrations.
 *
 * Registers invariants via `registerInvariant()` so they appear in
 * the DevPanel → Incidents tab with full metadata.
 *
 * NOTE: `InvariantDef` does NOT carry a `failureCode` — that field lives on
 * `ForgeIncident` at the point of assertion, not in the definition.
 */

import { registerInvariant } from "../reliability/invariants.js";

export function registerTaskInvariants(): void {
  // ── Structural invariants ─────────────────────────────────────────────

  registerInvariant({
    id: "TASK_CURRENT_STEP_BELONGS_TO_TASK",
    description: "The step being executed must belong to the active task",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "READY_STEP_DEPENDENCIES_COMPLETE",
    description: "A step must not start until all its dependencies are completed or skipped",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "ONE_ACTIVE_STEP_PER_TASK_V1",
    description: "In V1 single-agent mode, only one step may be active at a time per task",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  // ── Completion invariants ─────────────────────────────────────────────

  registerInvariant({
    id: "TASK_COMPLETE_REQUIRES_VERIFICATION_WHEN_REQUIRED",
    description:
      "A task may only reach 'completed' status after verification passes (when auto-verify is enabled)",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  // ── Budget invariants ─────────────────────────────────────────────────

  registerInvariant({
    id: "TASK_BUDGET_STEPS_NOT_EXCEEDED",
    description: "A plan must not exceed MAX_TOTAL_STEPS (25) steps",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "TASK_BUDGET_REVISIONS_NOT_EXCEEDED",
    description: "A task must not undergo more than MAX_PLAN_REVISIONS (5) plan revisions",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  // ── Stall detection ───────────────────────────────────────────────────

  registerInvariant({
    id: "TASK_STALLED",
    description:
      "A task must not make zero progress for MAX_CONSECUTIVE_NO_PROGRESS (3) consecutive steps",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  // ── Terminal state ────────────────────────────────────────────────────

  registerInvariant({
    id: "TASK_TERMINAL_EXACTLY_ONCE",
    description:
      "A task that has reached a terminal state must not be started or transitioned again",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  // ── Plan integrity ────────────────────────────────────────────────────

  registerInvariant({
    id: "TASK_PLAN_NO_CYCLES",
    description: "A task plan's dependency graph must be a DAG (no cycles)",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "TASK_PLAN_STEP_IDS_UNIQUE",
    description: "All step IDs within a plan must be unique",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "TASK_COMPLETED_STEPS_IMMUTABLE",
    description: "Completed steps must not be mutated or removed during a replan",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  // ── Evidence integrity ───────────────────────────────────────────────

  registerInvariant({
    id: "TASK_RUNNING_STEP_HAS_ACTIVE_AGENTRUN",
    description:
      "A step with status=running must have a corresponding active AgentRun in the registry",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "TASK_PAUSED_HAS_NO_ACTIVE_AGENTRUN",
    description:
      "A task with status=paused must not have any active AgentRun in the registry",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "TASK_STEP_EVIDENCE_REFS_VALID",
    description:
      "All evidenceRefs in a step's lastResult must pass evidence registry validation",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "TASK_VERIFICATION_USES_VALID_EVIDENCE",
    description:
      "A task with verificationStatus=passed must have at least one valid evidence ref",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "TASK_CALLBACK_RELEASED_AFTER_TERMINAL",
    description:
      "No pending task callbacks (AbortControllers, step controllers) remain after terminal status",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  registerInvariant({
    id: "TASK_RUNTIME_METADATA_MATCHES_AGENTRUN",
    description:
      "The active AgentRun's taskId/stepId must match the TaskRunner's current step state",
    category: "TASK_RUNTIME",
    severity: "high",
    maxHealingLevel: 1,
  });

  // ── Restart correctness ──────────────────────────────────────────────

  registerInvariant({
    id: "TASK_RESTART_HAS_NO_STALE_RUNNING_STEP",
    description:
      "After startup reconciliation, no step with status=running must exist",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });

  // ── Message deduplication ────────────────────────────────────────────

  registerInvariant({
    id: "ONE_PERSISTED_USER_MESSAGE_PER_TASK_REQUEST",
    description:
      "Exactly one user ChatMessage must be persisted per task trigger — task creation must not insert a second",
    category: "TASK_RUNTIME",
    severity: "critical",
    maxHealingLevel: 1,
  });
}