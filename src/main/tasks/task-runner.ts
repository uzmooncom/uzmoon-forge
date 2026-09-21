/**
 * task-runner.ts — Task Runtime Orchestrator V1.
 *
 * TaskRunner owns:
 *   - Step scheduling (selects next ready step, dispatches via callback)
 *   - Step result processing (update state, decide next action)
 *   - Replanning (delegate to TaskPlanner, increment version)
 *   - Verification (auto-inject verify step when plan ends)
 *   - Pause/Resume/Cancel/Stop
 *   - Budget enforcement (max attempts, max revisions, stall detection)
 *   - Startup reconciliation
 *
 * TaskRunner does NOT:
 *   - Call runAgentLoop directly
 *   - Execute tools
 *   - Manage IPC or DB directly (delegates to callbacks)
 *   - Bypass Permission Center
 *
 * SINGLE-AGENT V1: one active step at a time per task.
 */

import { randomUUID } from "crypto";
import type {
  ForgeTask,
  ForgeTaskPlan,
  ForgeTaskStep,
  TaskStatus,
  TaskStepStatus,
  TaskStepResult,
  TaskBlocker,
  AgentConfig,
} from "../../shared/types.js";
import {
  isTaskTerminal,
  isStepTerminal,
  getReadySteps,
  inferStepResult,
} from "./task-types.js";
import type { PlannerResult } from "./task-planner.js";
import { assertInvariant } from "../reliability/invariants.js";
import { forgeLogger } from "../telemetry/logger.js";
import type { AgentLoopResult } from "../agent-client/agent-loop.js";
import { shouldUseMultiAgent, runMultiAgentOrchestration } from "./multi-agent/ma-manager.js";
import type { TaskExecutionMode } from "./multi-agent/ma-types.js";

// ── Budget constants ───────────────────────────────────────────────────────

const MAX_PLAN_REVISIONS = 5;
const MAX_STEP_ATTEMPTS = 3;
const MAX_TOTAL_STEPS = 25;
const MAX_CONSECUTIVE_NO_PROGRESS = 3;

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface TaskRunnerCallbacks {
  /** Persist the task state (called on every transition) */
  onTaskUpdate: (task: ForgeTask) => void;
  /** Persist the plan (called after create/replan) */
  onPlanUpdate: (plan: ForgeTaskPlan) => void;
  /**
   * Dispatch a step for execution.
   * Returns a promise that resolves when the agent run for this step completes.
   * The result includes the AgentLoopResult from which step outcome is extracted.
   * taskStepResult is pre-populated in the loopResult by runTaskStep.
   */
  dispatchStep: (
    task: ForgeTask,
    step: ForgeTaskStep,
    plan: ForgeTaskPlan,
    signal: AbortSignal
  ) => Promise<{ loopResult: AgentLoopResult; cancelled: boolean }>;
  /**
   * Dispatch plan generation (initial or replan).
   * Routes through QueueManager — TaskRunner must not call planner directly.
   * 'generate' for initial plan; 'replan' for revision with completed-step history.
   */
  dispatchPlan: (
    mode: "generate" | "replan",
    task: ForgeTask,
    currentPlan: ForgeTaskPlan | null,
    cfg: AgentConfig,
    apiKey: string,
    signal: AbortSignal,
    reason?: string,
    errorFeedback?: string
  ) => Promise<PlannerResult>;
  /** Push a task snapshot to the renderer */
  pushSnapshot: (task: ForgeTask, plan: ForgeTaskPlan) => void;
  /** Report a task incident */
  onIncident: (invariantId: string, meta: Record<string, unknown>) => void;
}

export interface RunnerState {
  task: ForgeTask;
  plan: ForgeTaskPlan;
  activeStepId: string | null;
  pauseRequested: boolean;
  /** AbortController for the current step's agent run */
  controller: AbortController | null;
  consecutiveNoProgress: number;
  /** Execution mode: single_agent (default) or multi_agent */
  executionMode: TaskExecutionMode;
  /** AbortController for multi-agent orchestration */
  maController: AbortController | null;
}

// ── Module-level runner registry ───────────────────────────────────────────
// Keyed by taskId — allows cancellation and pause from outside the run loop.

const _runners = new Map<string, RunnerState>();

export function getRunnerState(taskId: string): RunnerState | null {
  return _runners.get(taskId) ?? null;
}

export function listActiveRunnerIds(): string[] {
  return Array.from(_runners.keys());
}

/** Called at startup to hydrate runner state from persisted tasks (no execution) */
export function hydrateRunner(task: ForgeTask, plan: ForgeTaskPlan): void {
  _runners.set(task.id, {
    task,
    plan,
    activeStepId: null,
    pauseRequested: false,
    controller: null,
    consecutiveNoProgress: 0,
    executionMode: "single_agent",
    maController: null,
  });
}

/** Remove runner when task reaches terminal state */
function _removeRunner(taskId: string): void {
  const state = _runners.get(taskId);
  if (state?.controller) {
    state.controller.abort();
  }
  _runners.delete(taskId);
}

// ── Task state transition ─────────────────────────────────────────────────

function _transitionTask(
  state: RunnerState,
  newStatus: TaskStatus,
  patch?: Partial<ForgeTask>
): ForgeTask {
  const prev = state.task.status;
  const updated: ForgeTask = {
    ...state.task,
    ...patch,
    status: newStatus,
    updatedAt: Date.now(),
    ...(newStatus === "running" && !state.task.startedAt ? { startedAt: Date.now() } : {}),
    ...(newStatus === "completed" || newStatus === "failed" || newStatus === "cancelled"
      ? { completedAt: Date.now() }
      : {}),
  };
  state.task = updated;

  forgeLogger.info("task", `TASK_STATUS_${newStatus.toUpperCase()}`, {
    metadata: {
      taskId: updated.id,
      conversationId: updated.conversationId,
      from: prev,
      to: newStatus,
      planVersion: updated.planVersion,
    },
  });

  return updated;
}

function _transitionStep(
  plan: ForgeTaskPlan,
  stepId: string,
  newStatus: TaskStepStatus,
  patch?: Partial<ForgeTaskStep>
): ForgeTaskPlan {
  const updatedSteps = plan.steps.map((s) =>
    s.id === stepId
      ? {
          ...s,
          ...patch,
          status: newStatus,
          ...(newStatus === "running" && !s.startedAt ? { startedAt: Date.now() } : {}),
          ...(isStepTerminal(newStatus) && !s.completedAt ? { completedAt: Date.now() } : {}),
        }
      : s
  );
  return { ...plan, steps: updatedSteps, updatedAt: Date.now() };
}

// ── Main runner ────────────────────────────────────────────────────────────

/**
 * Start executing a task.
 * This function drives the step loop until the task reaches a terminal state
 * or is paused/cancelled externally.
 */
export async function startTaskRunner(
  task: ForgeTask,
  plan: ForgeTaskPlan,
  cfg: AgentConfig,
  apiKey: string,
  callbacks: TaskRunnerCallbacks
): Promise<void> {
  // INV: TASK_TERMINAL_EXACTLY_ONCE — don't start already-terminal task
  if (isTaskTerminal(task.status)) {
    forgeLogger.warn("task", "TASK_START_TERMINAL_IGNORED", {
      metadata: { taskId: task.id, status: task.status },
    });
    return;
  }

  const state: RunnerState = {
    task,
    plan,
    activeStepId: null,
    pauseRequested: false,
    controller: null,
    consecutiveNoProgress: 0,
    executionMode: "single_agent",
    maController: null,
  };
  _runners.set(task.id, state);

  try {
    await _runLoop(state, cfg, apiKey, callbacks);
  } finally {
    if (!isTaskTerminal(state.task.status)) {
      // Unexpected exit — make sure task is in a safe state
      const final = _transitionTask(state, "failed", {
        failure: { code: "TASK_LOOP_UNEXPECTED_EXIT", message: "Task runner exited unexpectedly" },
      });
      callbacks.onTaskUpdate(final);
      callbacks.pushSnapshot(final, state.plan);
    }
    _removeRunner(task.id);
  }
}

async function _runLoop(
  state: RunnerState,
  cfg: AgentConfig,
  apiKey: string,
  callbacks: TaskRunnerCallbacks
): Promise<void> {
  const { task } = state;

  // Transition to running
  const running = _transitionTask(state, "running");
  callbacks.onTaskUpdate(running);
  callbacks.pushSnapshot(running, state.plan);

  forgeLogger.info("task", "TASK_STARTED", {
    metadata: {
      taskId: task.id,
      goal: task.goal.slice(0, 100),
      stepCount: state.plan.steps.length,
      planVersion: state.plan.version,
    },
  });

  // ── Multi-agent mode dispatch ────────────────────────────────────────────
  // If complexity heuristic selects multi_agent, hand off to MAManager.
  // MAManager reports back via callbacks — it never writes ForgeTask.status directly.
  if (shouldUseMultiAgent(state.plan, false)) {
    state.executionMode = "multi_agent";
    const maController = new AbortController();
    state.maController = maController;

    // Chain pause/cancel → abort MA controller
    const pauseWatcher = setInterval(() => {
      if (state.pauseRequested && !maController.signal.aborted) {
        maController.abort();
      }
    }, 100);

    let maReadyForVerification = false;
    let maReplanReason = "";
    let maPauseReason = "";

    try {
      await runMultiAgentOrchestration({
        task: state.task,
        plan: state.plan,
        cfg,
        apiKey,
        signal: maController.signal,
        onTaskUpdate: (updatedTask) => {
          state.task = updatedTask;
          callbacks.onTaskUpdate(updatedTask);
        },
        pushSnapshot: (t, p) => callbacks.pushSnapshot(t, p),
        onReadyForVerification: (summary, evidenceRefs) => {
          maReadyForVerification = true;
          void summary;
          void evidenceRefs;
        },
        onReplanRequested: (reason) => {
          maReplanReason = reason;
        },
        onPauseRequested: (reason) => {
          maPauseReason = reason;
        },
        onIncident: (invariantId, meta) => {
          callbacks.onIncident(invariantId, meta);
        },
      });
    } finally {
      clearInterval(pauseWatcher);
      state.maController = null;
    }

    // Handle MA outcomes
    if (maReadyForVerification) {
      // Mark all plan steps completed (MA managed them internally)
      const completedPlan = {
        ...state.plan,
        steps: state.plan.steps.map((s) => ({
          ...s,
          status: (s.status === "running" || s.status === "pending" ? "completed" : s.status) as import("../../shared/types.js").TaskStepStatus,
        })),
        updatedAt: Date.now(),
      };
      state.plan = completedPlan;
      callbacks.onPlanUpdate(completedPlan);
      await _runVerification(state, cfg, apiKey, callbacks);
      return;
    }

    if (maReplanReason) {
      // Replan — fall through to single-agent loop which will replan
      forgeLogger.info("task", "TASK_STARTED", {
        metadata: { taskId: task.id, replanReason: maReplanReason },
      });
      // Continue into single-agent loop for replan handling
    } else if (maPauseReason || state.pauseRequested) {
      const paused = _transitionTask(state, "paused");
      callbacks.onTaskUpdate(paused);
      callbacks.pushSnapshot(paused, state.plan);
      forgeLogger.info("task", "TASK_PAUSED", { metadata: { taskId: task.id, reason: maPauseReason } });
      return;
    } else {
      // Cancelled / aborted
      return;
    }
  }

  for (;;) {
    // Check pause
    if (state.pauseRequested) {
      // Mark the active step as interrupted (safe to retry on resume)
      if (state.activeStepId !== null) {
        const interruptedPlan = _transitionStep(state.plan, state.activeStepId, "interrupted");
        state.plan = interruptedPlan;
        callbacks.onPlanUpdate(interruptedPlan);
      }
      const paused = _transitionTask(state, "paused");
      callbacks.onTaskUpdate(paused);
      callbacks.pushSnapshot(paused, state.plan);
      forgeLogger.info("task", "TASK_PAUSED", { metadata: { taskId: task.id } });
      return;
    }

    // Budget checks
    if (state.plan.version > MAX_PLAN_REVISIONS) {
      await _failTask(state, "TASK_BUDGET_EXCEEDED", `Max plan revisions (${MAX_PLAN_REVISIONS}) exceeded`, callbacks);
      return;
    }

    if (state.plan.steps.length > MAX_TOTAL_STEPS) {
      await _failTask(state, "TASK_BUDGET_EXCEEDED", `Max total steps (${MAX_TOTAL_STEPS}) exceeded`, callbacks);
      return;
    }

    if (state.consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
      callbacks.onIncident("TASK_STALLED", {
        taskId: task.id,
        consecutiveNoProgress: state.consecutiveNoProgress,
        conversationId: task.conversationId,
      });
      await _failTask(state, "TASK_STALLED", `Task stalled: ${MAX_CONSECUTIVE_NO_PROGRESS} consecutive steps with no progress`, callbacks);
      return;
    }

    // Find next ready (pending) step
    const pendingReady = getReadySteps(state.plan.steps);

    if (pendingReady.length === 0) {
      // Check if all steps are done
      const allDone = state.plan.steps.every((s) => isStepTerminal(s.status));
      if (allDone) {
        // Check if we need verification
        const hasVerifyStep = state.plan.steps.some((s) => s.type === "verify");
        if (!hasVerifyStep) {
          // Auto-inject verification
          await _runVerification(state, cfg, apiKey, callbacks);
          return;
        }
        // All done including verify
        await _completeTask(state, callbacks);
        return;
      }

      // Some steps are blocked/failed — check if task can continue
      const blockedSteps = state.plan.steps.filter((s) => s.status === "blocked");
      if (blockedSteps.length > 0) {
        const firstBlocked = blockedSteps[0]!;
        const blocker: TaskBlocker = {
          kind: "missing_info",
          message: firstBlocked.error ?? "Step is blocked",
          stepId: firstBlocked.id,
        };
        const blocked = _transitionTask(state, "paused", { blocker });
        callbacks.onTaskUpdate(blocked);
        callbacks.pushSnapshot(blocked, state.plan);
        return;
      }

      // No ready steps, not all done — stall
      state.consecutiveNoProgress++;
      if (state.consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
        callbacks.onIncident("TASK_STALLED", { taskId: task.id });
        await _failTask(state, "TASK_STALLED", "No steps ready and task not complete", callbacks);
        return;
      }
      continue;
    }

    // INV: ONE_ACTIVE_STEP_PER_TASK_V1
    assertInvariant(
      "ONE_ACTIVE_STEP_PER_TASK_V1",
      state.activeStepId === null,
      { taskId: task.id, activeStepId: state.activeStepId },
      { hint: "Only one step may run at a time in V1" }
    );

    const nextStep = pendingReady[0]!;

    // INV: TASK_CURRENT_STEP_BELONGS_TO_TASK
    assertInvariant(
      "TASK_CURRENT_STEP_BELONGS_TO_TASK",
      nextStep.taskId === task.id,
      { stepTaskId: nextStep.taskId, taskId: task.id },
      {}
    );

    // INV: READY_STEP_DEPENDENCIES_COMPLETE
    const completedIds = new Set(
      state.plan.steps.filter((s) => s.status === "completed" || s.status === "skipped").map((s) => s.id)
    );
    assertInvariant(
      "READY_STEP_DEPENDENCIES_COMPLETE",
      nextStep.dependencies.every((dep) => completedIds.has(dep)),
      { stepId: nextStep.id, missingDeps: nextStep.dependencies.filter((d) => !completedIds.has(d)) },
      {}
    );

    // Mark step running
    const updatedPlan = _transitionStep(state.plan, nextStep.id, "running");
    state.plan = updatedPlan;
    state.activeStepId = nextStep.id;
    const runningTask = _transitionTask(state, "running", { currentStepId: nextStep.id });
    callbacks.onTaskUpdate(runningTask);
    callbacks.onPlanUpdate(updatedPlan);
    callbacks.pushSnapshot(runningTask, updatedPlan);

    forgeLogger.info("task", "TASK_STEP_STARTED", {
      metadata: {
        taskId: task.id,
        stepId: nextStep.id,
        stepTitle: nextStep.title,
        attemptCount: nextStep.attemptCount + 1,
      },
    });

    // Execute step
    const controller = new AbortController();
    state.controller = controller;

    let loopResult: AgentLoopResult | null = null;
    let cancelled = false;
    let stepError: string | null = null;

    try {
      const outcome = await callbacks.dispatchStep(
        state.task,
        { ...nextStep, attemptCount: nextStep.attemptCount + 1 },
        state.plan,
        controller.signal
      );
      loopResult = outcome.loopResult;
      cancelled = outcome.cancelled;
    } catch (err: unknown) {
      stepError = err instanceof Error ? err.message : String(err);
    } finally {
      state.controller = null;
      state.activeStepId = null;
    }

    // Handle cancellation (Stop button) — mark step interrupted, not cancelled
    // (cancelled is reserved for explicit user cancellation of the whole task)
    if (cancelled) {
      // Step was mid-run when aborted — mark it interrupted so it can be retried
      const interruptedPlan = _transitionStep(state.plan, nextStep.id, "interrupted");
      state.plan = interruptedPlan;
      // Cancel all pending/ready steps (they won't run in a cancelled task)
      const fullyCancel = interruptedPlan.steps.map((s) =>
        s.status === "pending" || s.status === "ready" ? { ...s, status: "cancelled" as TaskStepStatus } : s
      );
      state.plan = { ...interruptedPlan, steps: fullyCancel, updatedAt: Date.now() };
      const cancelledTask = _transitionTask(state, "cancelled");
      callbacks.onTaskUpdate(cancelledTask);
      callbacks.onPlanUpdate(state.plan);
      callbacks.pushSnapshot(cancelledTask, state.plan);
      forgeLogger.info("task", "TASK_CANCELLED", { metadata: { taskId: task.id } });
      return;
    }

    // Extract step result — use the canonical taskStepResult from AgentLoopResult.
    // This is set by runTaskStep (via parseStepResult in agent-loop) — the single
    // canonical parse point. Fall back to inference only if absent.
    let stepResult: TaskStepResult;
    if (loopResult) {
      stepResult =
        loopResult.taskStepResult ??
        inferStepResult(loopResult.finalText, false);
    } else {
      stepResult = inferStepResult(stepError ?? "execution failed", true);
    }

    forgeLogger.info("task", `TASK_STEP_${stepResult.status.toUpperCase()}`, {
      metadata: {
        taskId: task.id,
        stepId: nextStep.id,
        status: stepResult.status,
        summary: stepResult.summary.slice(0, 100),
      },
    });

    // Process result
    switch (stepResult.status) {
      case "completed": {
        const completedPlan = _transitionStep(state.plan, nextStep.id, "completed", {
          lastResult: stepResult,
          evidenceRefs: stepResult.evidenceRefs,
          attemptCount: nextStep.attemptCount + 1,
        });
        state.plan = completedPlan;
        state.consecutiveNoProgress = 0;
        callbacks.onPlanUpdate(completedPlan);
        callbacks.pushSnapshot(state.task, completedPlan);
        break;
      }

      case "replan_required": {
        if (state.plan.version >= MAX_PLAN_REVISIONS) {
          await _failTask(state, "TASK_BUDGET_EXCEEDED", "Max plan revisions exceeded after replan request", callbacks);
          return;
        }
        // Mark current step as completed (partial work done)
        const prePlan = _transitionStep(state.plan, nextStep.id, "completed", {
          lastResult: { ...stepResult, status: "completed" },
          attemptCount: nextStep.attemptCount + 1,
        });
        state.plan = prePlan;

        forgeLogger.info("task", "TASK_REPLAN_STARTED", {
          metadata: {
            taskId: task.id,
            reason: stepResult.recommendedPlanChanges ?? "replan_required",
            version: state.plan.version,
          },
        });

        try {
          const replanResult = await callbacks.dispatchPlan(
            "replan",
            task,
            state.plan,
            cfg,
            apiKey,
            new AbortController().signal,
            stepResult.recommendedPlanChanges ?? "Step required replanning",
            stepResult.observations ?? stepResult.summary
          );
          state.plan = replanResult.plan;
          const updTask = _transitionTask(state, "running", { planVersion: replanResult.plan.version });
          callbacks.onTaskUpdate(updTask);
          callbacks.onPlanUpdate(replanResult.plan);
          callbacks.pushSnapshot(updTask, replanResult.plan);

          forgeLogger.info("task", "TASK_REPLANNED", {
            metadata: {
              taskId: task.id,
              newVersion: replanResult.plan.version,
              newStepCount: replanResult.plan.steps.length,
            },
          });
        } catch {
          // Replan failed — fall through to continue with remaining original steps
          forgeLogger.warn("task", "TASK_REPLAN_FAILED", { metadata: { taskId: task.id } });
          state.consecutiveNoProgress++;
        }
        break;
      }

      case "failed": {
        const failedAttempts = nextStep.attemptCount + 1;
        if (failedAttempts < MAX_STEP_ATTEMPTS) {
          // Retry
          const retryPlan = _transitionStep(state.plan, nextStep.id, "pending", {
            attemptCount: failedAttempts,
            error: stepResult.summary,
            lastResult: stepResult,
          });
          state.plan = retryPlan;
          state.consecutiveNoProgress++;
          callbacks.onPlanUpdate(retryPlan);
        } else {
          // Max attempts reached — fail the step and the task
          const failedPlan = _transitionStep(state.plan, nextStep.id, "failed", {
            lastResult: stepResult,
            error: stepResult.summary,
            attemptCount: failedAttempts,
          });
          state.plan = failedPlan;
          callbacks.onPlanUpdate(failedPlan);
          await _failTask(
            state,
            "TASK_STEP_MAX_ATTEMPTS",
            `Step "${nextStep.title}" failed after ${failedAttempts} attempts: ${stepResult.summary}`,
            callbacks
          );
          return;
        }
        break;
      }

      case "blocked": {
        const blockedPlan = _transitionStep(state.plan, nextStep.id, "blocked", {
          lastResult: stepResult,
          error: stepResult.summary,
          attemptCount: nextStep.attemptCount + 1,
        });
        state.plan = blockedPlan;
        const blocker: TaskBlocker = {
          kind: "missing_info",
          message: stepResult.summary,
          stepId: nextStep.id,
        };
        const blockedTask = _transitionTask(state, "paused", { blocker });
        callbacks.onTaskUpdate(blockedTask);
        callbacks.onPlanUpdate(blockedPlan);
        callbacks.pushSnapshot(blockedTask, blockedPlan);
        forgeLogger.warn("task", "TASK_STEP_BLOCKED", {
          metadata: { taskId: task.id, stepId: nextStep.id, reason: stepResult.summary },
        });
        return;
      }
    }
  }
}

// ── Verification ───────────────────────────────────────────────────────────

async function _runVerification(
  state: RunnerState,
  cfg: AgentConfig,
  apiKey: string,
  callbacks: TaskRunnerCallbacks
): Promise<void> {
  const { task } = state;

  forgeLogger.info("task", "TASK_VERIFICATION_STARTED", { metadata: { taskId: task.id } });
  const verifying = _transitionTask(state, "verifying");
  callbacks.onTaskUpdate(verifying);
  callbacks.pushSnapshot(verifying, state.plan);

  // Add a verify step to the plan
  const verifyStepId = `verify-${randomUUID().slice(0, 8)}`;
  const verifyStep: ForgeTaskStep = {
    id: verifyStepId,
    taskId: task.id,
    title: "Verify goal outcome",
    type: "verify",
    status: "pending",
    dependencies: state.plan.steps.map((s) => s.id),
    capabilityHints: [],
    evidenceRefs: [],
    attemptCount: 0,
    expectedOutcome: `Goal "${task.goal}" is fully accomplished`,
  };

  const planWithVerify: ForgeTaskPlan = {
    ...state.plan,
    steps: [...state.plan.steps, verifyStep],
    updatedAt: Date.now(),
  };
  state.plan = planWithVerify;
  callbacks.onPlanUpdate(planWithVerify);

  const controller = new AbortController();
  state.controller = controller;
  state.activeStepId = verifyStepId;

  let loopResult: AgentLoopResult | null = null;
  let cancelled = false;

  try {
    const planWithRunningVerify = _transitionStep(state.plan, verifyStepId, "running");
    state.plan = planWithRunningVerify;

    const outcome = await callbacks.dispatchStep(
      state.task,
      { ...verifyStep, status: "running", attemptCount: 1 },
      state.plan,
      controller.signal
    );
    loopResult = outcome.loopResult;
    cancelled = outcome.cancelled;
  } catch {
    loopResult = null;
  } finally {
    state.controller = null;
    state.activeStepId = null;
  }

  if (cancelled) {
    // Mark verify step interrupted (was mid-run when aborted)
    const interruptedPlan = _transitionStep(state.plan, verifyStepId, "interrupted");
    state.plan = interruptedPlan;
    const cancelledTask = _transitionTask(state, "cancelled");
    callbacks.onTaskUpdate(cancelledTask);
    callbacks.pushSnapshot(cancelledTask, interruptedPlan);
    return;
  }

  // Use canonical taskStepResult from AgentLoopResult (set by runTaskStep)
  const result = loopResult
    ? loopResult.taskStepResult ?? inferStepResult(loopResult.finalText, false)
    : inferStepResult("Verification failed", true);

  if (result.status === "completed") {
    const donePlan = _transitionStep(state.plan, verifyStepId, "completed", {
      lastResult: result,
      evidenceRefs: result.evidenceRefs,
    });
    state.plan = donePlan;
    const completed = _transitionTask(state, "completed", {
      verificationStatus: "passed",
      summary: result.summary,
    });
    callbacks.onTaskUpdate(completed);
    callbacks.onPlanUpdate(donePlan);
    callbacks.pushSnapshot(completed, donePlan);

    // INV: TASK_COMPLETE_REQUIRES_VERIFICATION_WHEN_REQUIRED
    assertInvariant(
      "TASK_COMPLETE_REQUIRES_VERIFICATION_WHEN_REQUIRED",
      completed.verificationStatus === "passed",
      { taskId: task.id, verificationStatus: completed.verificationStatus },
      {}
    );

    forgeLogger.info("task", "TASK_VERIFICATION_COMPLETED", { metadata: { taskId: task.id } });
    forgeLogger.info("task", "TASK_COMPLETED", {
      metadata: { taskId: task.id, goal: task.goal.slice(0, 100) },
    });
  } else {
    const failedVerifyPlan = _transitionStep(state.plan, verifyStepId, "failed", {
      lastResult: result,
      error: result.summary,
    });
    state.plan = failedVerifyPlan;
    forgeLogger.warn("task", "TASK_VERIFICATION_FAILED", {
      metadata: { taskId: task.id, reason: result.summary },
    });
    await _failTask(state, "TASK_VERIFICATION_FAILED", `Verification failed: ${result.summary}`, callbacks);
  }
}

// ── Terminal helpers ───────────────────────────────────────────────────────

async function _completeTask(
  state: RunnerState,
  callbacks: TaskRunnerCallbacks
): Promise<void> {
  const completed = _transitionTask(state, "completed", {
    verificationStatus: "skipped",
    summary: "All steps completed",
  });
  callbacks.onTaskUpdate(completed);
  callbacks.pushSnapshot(completed, state.plan);
  forgeLogger.info("task", "TASK_COMPLETED", {
    metadata: { taskId: state.task.id, goal: state.task.goal.slice(0, 100) },
  });
}

async function _failTask(
  state: RunnerState,
  code: string,
  message: string,
  callbacks: TaskRunnerCallbacks
): Promise<void> {
  const failed = _transitionTask(state, "failed", {
    failure: { code, message },
  });
  callbacks.onTaskUpdate(failed);
  callbacks.pushSnapshot(failed, state.plan);
  forgeLogger.error("task", "TASK_FAILED", {
    metadata: { taskId: state.task.id, code, message: message.slice(0, 200) },
  });
}

// ── External control API ───────────────────────────────────────────────────

/**
 * Request pause of a running task.
 * The runner will pause at the next safe checkpoint (after current step completes or is cancelled).
 */
export function pauseTask(taskId: string): boolean {
  const state = _runners.get(taskId);
  if (!state) return false;
  if (isTaskTerminal(state.task.status) || state.task.status === "paused") return false;
  state.pauseRequested = true;
  forgeLogger.info("task", "TASK_PAUSE_REQUESTED", { metadata: { taskId } });
  return true;
}

/**
 * Cancel a task immediately.
 * Aborts the current step's agent run and marks the task cancelled.
 */
export function cancelTask(taskId: string, callbacks: TaskRunnerCallbacks): boolean {
  const state = _runners.get(taskId);
  if (!state) return false;
  if (isTaskTerminal(state.task.status)) return false;

  // Abort current step
  state.controller?.abort();

  // Cancel all pending/running steps
  const cancelledSteps = state.plan.steps.map((s) =>
    !isStepTerminal(s.status) ? { ...s, status: "cancelled" as const } : s
  );
  state.plan = { ...state.plan, steps: cancelledSteps, updatedAt: Date.now() };

  const cancelled = _transitionTask(state, "cancelled");
  callbacks.onTaskUpdate(cancelled);
  callbacks.onPlanUpdate(state.plan);
  callbacks.pushSnapshot(cancelled, state.plan);

  _removeRunner(taskId);
  return true;
}

/**
 * Returns true if a task runner exists and the task is not terminal.
 */
export function isTaskRunning(taskId: string): boolean {
  const state = _runners.get(taskId);
  return !!state && !isTaskTerminal(state.task.status);
}

/**
 * Get the current step being executed, if any.
 */
export function getActiveStepId(taskId: string): string | null {
  return _runners.get(taskId)?.activeStepId ?? null;
}

/** Reset all runners — for test teardown only */
export function _resetTaskRunnersForTest(): void {
  for (const state of _runners.values()) {
    state.controller?.abort();
  }
  _runners.clear();
}