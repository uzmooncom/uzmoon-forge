/**
 * Multi-Agent Manager
 *
 * Orchestrates multi-agent execution for a single ForgeTask.
 * Called by TaskRunner when complexity heuristic selects multi_agent mode.
 *
 * Architecture (correction #1):
 *   TaskRunner remains the lifecycle authority for ForgeTask.
 *   MAManager reports back to TaskRunner via callbacks — it never writes
 *   to ForgeTask.status directly.
 *
 * Loop:
 *   1. Create coordinator instance
 *   2. Run coordinator turn → parse forge_coordinator_plan → apply actions
 *   3. For each assigned work item → dispatch to runWorkItemStep
 *   4. Collect results → surface subtask proposals → next coordinator turn
 *   5. On mark_ready_for_verification → call opts.onReadyForVerification
 *   6. On replan → call opts.onReplanRequested
 *   7. On pause/cancel → interrupt all workers, release leases
 *
 * Concurrency model:
 *   Workers run sequentially per coordinator cycle (MA_MAX_WORKERS cap governs
 *   how many are assigned per turn). Full parallel dispatch is deferred to V2.
 *   Coordinator always runs single-threaded.
 *
 * Correction #4: coordinator execution goes through runWorkItemStep
 * (shared internal path); workers go through runWorkItemStep as well.
 * Neither bypasses QueueManager.
 */

import { forgeLogger } from "../../telemetry/logger.js";
import {
  hydrateTaskMAState,
  createInstance,
  getCoordinatorInstance,
  getWorkItemsForTask,
  getWorkItemById,
  updateWorkItem,
  updateInstance,
  getPendingProposals,
  createProposal,
  getBudgetCounters,
  cleanupTaskMAState,
  setExecutionMode,
  bumpBudgetCounter,
  findReusableInstance,
} from "./ma-store.js";
import {
  buildCoordinatorSystemPrompt,
  parseCoordinatorPlan,
  applyCoordinatorActions,
} from "./coordinator.js";
import {
  buildWorkerPrompt,
  parseWorkItemResult,
  beginWorkItemExecution,
  finalizeWorkItemExecution,
} from "./worker-runner.js";
import { runWorkItemStep } from "../../queue/QueueManager.js";
import type {
  AgentWorkItem,
  AgentInstance,
  MAOrchestrationOptions,
  SubtaskProposal,
} from "./ma-types.js";
import {
  MA_MAX_COORDINATOR_TURNS,
  MA_MAX_ATTEMPTS,
} from "./ma-types.js";

// ── Complexity heuristic ───────────────────────────────────────────────────

/**
 * Decide whether this task should use multi-agent orchestration.
 *
 * Heuristic (correction from plan):
 *   FORGE_MULTI_AGENT=1 AND plan has ≥ 2 steps AND not classified as simple_action
 */
export function shouldUseMultiAgent(
  plan: import("../../../shared/types.js").ForgeTaskPlan,
  classifiedAsSimpleAction: boolean
): boolean {
  const envEnabled =
    process.env["FORGE_MULTI_AGENT"] === "1" ||
    process.env["FORGE_MULTI_AGENT"] === "true";
  if (!envEnabled) return false;
  if (classifiedAsSimpleAction) return false;
  return plan.steps.length >= 2;
}

// ── Main orchestration entry point ─────────────────────────────────────────

/**
 * Run multi-agent orchestration for a task until completion, cancellation, or
 * a coordinator signal (readyForVerification / replan / pause).
 *
 * Returns when TaskRunner should take its next action (verify, replan, or pause).
 */
export async function runMultiAgentOrchestration(
  opts: MAOrchestrationOptions
): Promise<void> {
  const { task, plan, signal, onReadyForVerification, onReplanRequested, onPauseRequested, pushSnapshot } = opts;
  const taskId = task.id;

  // Hydrate in-memory state from DB (no-op if already loaded)
  hydrateTaskMAState(taskId);
  setExecutionMode(taskId, "multi_agent");

  forgeLogger.info("task", "MA_ORCHESTRATION_STARTED", {
    metadata: { taskId, planSteps: plan.steps.length },
  });

  // ── Create or find coordinator instance ─────────────────────────────
  let coordinator = getCoordinatorInstance(taskId);
  if (!coordinator) {
    coordinator = createInstance({ taskId, role: "coordinator", profileId: null });
  }

  updateInstance(coordinator.id, { status: "working" });

  // ── Main coordinator loop ────────────────────────────────────────────
  let turnNumber = getBudgetCounters(taskId).coordinatorTurns;

  while (!signal.aborted) {
    // Budget guard
    if (turnNumber >= MA_MAX_COORDINATOR_TURNS) {
      forgeLogger.warn("task", "MA_BUDGET_EXCEEDED", {
        metadata: { taskId, coordinatorTurns: turnNumber, limit: MA_MAX_COORDINATOR_TURNS },
      });
      onPauseRequested(`Coordinator budget exhausted (${MA_MAX_COORDINATOR_TURNS} turns)`);
      break;
    }

    const workItems = getWorkItemsForTask(taskId);
    const pendingProposals = getPendingProposals(taskId);

    // Build coordinator prompt
    const proposalSummary = pendingProposals.map((p) => ({
      id: p.id,
      title: p.title,
      reason: p.reason,
      suggestedRole: p.suggestedRole,
    }));

    const coordinatorSystemPrompt = buildCoordinatorSystemPrompt(
      task,
      plan,
      workItems,
      proposalSummary,
      turnNumber + 1
    );

    // ── Run coordinator turn ────────────────────────────────────────────
    forgeLogger.info("task", "MA_COORDINATOR_TURN_STARTED", {
      metadata: { taskId, turn: turnNumber + 1 },
    });

    const coordinatorMessages: import("../../agent-client/client.js").SimpleMessage[] = [
      { role: "user", content: coordinatorSystemPrompt },
    ];

    let coordinatorResult: Awaited<ReturnType<typeof runWorkItemStep>>;
    try {
      // Re-create a minimal AgentWorkItem shape for coordinator
      // Coordinator uses "generic" work item to pass through runWorkItemStep
      const coordinatorWorkItem: AgentWorkItem = _makeCoordinatorWorkItem(task, plan, coordinator);
      coordinatorResult = await runWorkItemStep(
        task,
        coordinatorWorkItem,
        plan,
        coordinatorMessages,
        coordinator.id,
        signal
      );
    } catch (err) {
      forgeLogger.error("task", "MA_COORDINATOR_TURN_ERROR", {
        metadata: { taskId, turn: turnNumber + 1, error: String(err) },
      });
      onPauseRequested(`Coordinator error on turn ${turnNumber + 1}: ${String(err)}`);
      break;
    }

    if (coordinatorResult.cancelled) {
      forgeLogger.info("task", "MA_PAUSED", { metadata: { taskId, reason: "coordinator cancelled" } });
      break;
    }

    const rawText = coordinatorResult.loopResult.finalText;
    const parsed = parseCoordinatorPlan(rawText);

    if (!parsed.valid) {
      forgeLogger.warn("task", "MA_COORDINATOR_TURN_COMPLETED", {
        metadata: { taskId, turn: turnNumber + 1, parseError: parsed.parseError },
      });
      // Increment turn but continue — coordinator may self-correct
      turnNumber++;
      continue;
    }

    forgeLogger.info("task", "MA_COORDINATOR_TURN_COMPLETED", {
      metadata: { taskId, turn: turnNumber + 1, actionCount: parsed.actions.length },
    });

    // ── Apply coordinator actions ───────────────────────────────────────
    const applyResult = applyCoordinatorActions(
      task,
      plan,
      parsed.actions,
      coordinator.id,
      turnNumber + 1
    );

    // Push snapshot after coordinator turn
    pushSnapshot(task, plan);

    turnNumber++;

    // ── Handle coordinator signals ─────────────────────────────────────
    if (applyResult.readyForVerification) {
      onReadyForVerification(applyResult.verificationSummary, applyResult.verificationEvidenceRefs);
      break;
    }

    if (applyResult.replanRequested) {
      onReplanRequested(applyResult.replanReason);
      break;
    }

    if (applyResult.pauseRequested) {
      onPauseRequested(applyResult.pauseReason);
      break;
    }

    // ── Execute assigned work items ────────────────────────────────────
    const assignedItems = getWorkItemsForTask(taskId).filter(
      (w) => w.status === "assigned"
    );

    for (const workItem of assignedItems) {
      if (signal.aborted) break;

      // Check MAX_ATTEMPTS
      if (workItem.attemptCount >= MA_MAX_ATTEMPTS) {
        updateWorkItem(workItem.id, { status: "failed" });
        forgeLogger.warn("task", "MA_WORK_ITEM_FAILED", {
          metadata: { taskId, workItemId: workItem.id, reason: "max attempts exceeded" },
        });
        continue;
      }

      // Find or create a worker instance
      let instance = workItem.assignedInstanceId
        ? null // specific instance requested — create/find below
        : findReusableInstance(taskId, workItem.suggestedRole);

      if (!instance) {
        try {
          instance = createInstance({
            taskId,
            role: workItem.suggestedRole,
            profileId: null,
          });
        } catch (err) {
          forgeLogger.warn("task", "MA_WORK_ITEM_BLOCKED", {
            metadata: { taskId, workItemId: workItem.id, reason: `Instance creation failed: ${String(err)}` },
          });
          updateWorkItem(workItem.id, { status: "blocked" });
          continue;
        }
      }

      // Dispatch execution
      await _executeWorkItem(task, plan, workItem, instance, signal);

      // Surface any subtask proposals from the result
      const updatedWI = getWorkItemById(workItem.id);
      if (updatedWI?.lastResult?.discoveredSubtasks) {
        for (const partial of updatedWI.lastResult.discoveredSubtasks) {
          const fullProposal: SubtaskProposal = {
            ...partial,
            taskId,
            sourceWorkItemId: workItem.id,
            proposedByAgentId: instance.id,
          };
          createProposal(fullProposal);
        }
      }

      // Push snapshot after each work item
      pushSnapshot(task, plan);
    }

    // ── Check for stall (no assigned items, no ready items, no proposals) ─
    const afterItems = getWorkItemsForTask(taskId);
    const hasWork = afterItems.some(
      (w) => w.status === "pending" || w.status === "assigned" || w.status === "running" || w.status === "interrupted"
    );
    const hasProposals = getPendingProposals(taskId).length > 0;

    if (!hasWork && !hasProposals) {
      // All terminal — coordinator should have issued mark_ready_for_verification
      // If it didn't, force a final coordinator turn to recover
      forgeLogger.warn("task", "MA_COORDINATOR_TURN_COMPLETED", {
        metadata: { taskId, turn: turnNumber, reason: "all work items terminal, no proposals" },
      });
      // Give coordinator one more turn
      continue;
    }
  }

  // ── Cleanup on exit ────────────────────────────────────────────────────
  if (signal.aborted) {
    _interruptAllActiveWorkItems(taskId);
    forgeLogger.info("task", "MA_CANCELLED", { metadata: { taskId } });
  }

  cleanupTaskMAState(taskId);
}

// ── Work item execution ────────────────────────────────────────────────────

async function _executeWorkItem(
  task: import("../../../shared/types.js").ForgeTask,
  plan: import("../../../shared/types.js").ForgeTaskPlan,
  workItem: AgentWorkItem,
  instance: AgentInstance,
  signal: AbortSignal
): Promise<void> {
  const allWorkItems = getWorkItemsForTask(task.id);
  const prompt = buildWorkerPrompt(task, plan, workItem, allWorkItems);
  const messages: import("../../agent-client/client.js").SimpleMessage[] = [
    { role: "user", content: prompt },
  ];

  const { assignmentId } = beginWorkItemExecution(workItem, instance);
  bumpBudgetCounter(task.id, "providerTurnsByWorker");

  let loopResult: Awaited<ReturnType<typeof runWorkItemStep>>;
  try {
    loopResult = await runWorkItemStep(task, workItem, plan, messages, instance.id, signal);
  } catch (err) {
    forgeLogger.error("task", "MA_WORK_ITEM_FAILED", {
      metadata: { taskId: task.id, workItemId: workItem.id, error: String(err) },
    });
    const errResult = {
      status: "failed" as const,
      summary: `Execution error: ${String(err)}`,
      evidenceRefs: [],
      discoveredSubtasks: [],
    };
    finalizeWorkItemExecution(workItem, instance, assignmentId, errResult, false);
    return;
  }

  const rawText = loopResult.loopResult.finalText;
  const workItemResult = parseWorkItemResult(rawText) ?? {
    status: "protocol_recovery" as const,
    summary: "No forge_step_result fence found in worker output",
    evidenceRefs: loopResult.loopResult.taskStepResult?.evidenceRefs ?? [],
    discoveredSubtasks: [],
  };

  finalizeWorkItemExecution(workItem, instance, assignmentId, workItemResult, loopResult.cancelled);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal AgentWorkItem placeholder for the coordinator's own runs.
 * The coordinator is not a real work item — this is only used so runWorkItemStep
 * has the right type shape.
 */
function _makeCoordinatorWorkItem(
  task: import("../../../shared/types.js").ForgeTask,
  plan: import("../../../shared/types.js").ForgeTaskPlan,
  coordinator: AgentInstance
): AgentWorkItem {
  return {
    id: `coord-${coordinator.id}`,
    taskId: task.id,
    taskStepId: null,
    planVersion: plan.version,
    depth: 0,
    title: "Coordinator orchestration",
    description: "Coordinator orchestration turn",
    kind: "generic",
    expectedOutcome: "Coordinator plan",
    capabilityHints: [],
    resourceTargets: [],
    suggestedRole: "coordinator",
    dependencies: [],
    status: "running",
    assignedInstanceId: coordinator.id,
    attemptCount: 0,
    reassignCount: 0,
    createdByType: "system",
    createdByAgentId: null,
    sourceProposalId: null,
    duplicateFingerprint: "",
    lastResult: null,
    evidenceRefs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    lastAttemptAt: null,
    reviewCycles: 0,
    reviewWorkItemId: null,
    skipSatisfiesDependencies: false,
  };
}

function _interruptAllActiveWorkItems(taskId: string): void {
  const activeItems = getWorkItemsForTask(taskId).filter(
    (w) => w.status === "running" || w.status === "assigned" || w.status === "waiting_for_human"
  );
  for (const w of activeItems) {
    updateWorkItem(w.id, { status: "interrupted" });
  }
  forgeLogger.info("task", "MA_PAUSED", {
    metadata: { taskId, interruptedItems: activeItems.length },
  });
}