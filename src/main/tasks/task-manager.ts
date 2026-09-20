/**
 * task-manager.ts — Singleton Task Manager for Task Runtime V1.
 *
 * Facade that coordinates:
 *   - Task creation and planning
 *   - TaskRunner lifecycle (start/pause/resume/cancel/retry)
 *   - DB persistence (via task-store calls)
 *   - IPC event emission to renderer
 *   - Startup reconciliation (mark interrupted tasks as paused)
 *
 * This is the only module that IPC handlers should call for task operations.
 *
 * SINGLE-AGENT V1: one active task per conversation (new task queues behind existing).
 */

import type { WebContents } from "electron";
import type {
  ForgeTask,
  ForgeTaskPlan,
  ForgeTaskStep,
  AgentConfig,
  TaskRuntimeSnapshot,
} from "../../shared/types.js";
import type { AgentLoopResult } from "../agent-client/agent-loop.js";
import { TASK_IPC } from "../../shared/types.js";
import * as db from "../database/db.js";
import {
  makeTask,
  isTaskTerminal,
} from "./task-types.js";
import { generatePlan, replan as replanPlan, buildFallbackPlan } from "./task-planner.js";
import {
  startTaskRunner,
  pauseTask,
  cancelTask,
  getRunnerState,
  _resetTaskRunnersForTest,
} from "./task-runner.js";
import type { TaskRunnerCallbacks } from "./task-runner.js";
import { forgeLogger } from "../telemetry/logger.js";
import { completeQueueItemAsTask } from "../queue/QueueManager.js";
import { tryGetIncidentRecorder } from "../reliability/index.js";

// ── Module state ──────────────────────────────────────────────────────────

let _sender: WebContents | null = null;
// Reserved for future subagent dispatch in V2 — QueueManager holds the active reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _secretGetter: ((profileId: string) => string | null) | null = null;
let _getCfgForConv: (convId: string) => { cfg: AgentConfig; apiKey: string } | null = () => null;

/** Step dispatcher callback — set by QueueManager integration */
let _dispatchStep: (
  (task: ForgeTask, step: ForgeTaskStep, plan: ForgeTaskPlan, signal: AbortSignal)
  => Promise<{ loopResult: AgentLoopResult; cancelled: boolean }>
) | null = null;

/** Called once from handlers.ts to inject dependencies */
export function initTaskManager(opts: {
  sender: WebContents;
  secretGetter: (profileId: string) => string | null;
  getCfgForConv: (convId: string) => { cfg: AgentConfig; apiKey: string } | null;
  dispatchStep: (
    task: ForgeTask, step: ForgeTaskStep, plan: ForgeTaskPlan, signal: AbortSignal
  ) => Promise<{ loopResult: AgentLoopResult; cancelled: boolean }>;
  dispatchPlan?: TaskRunnerCallbacks["dispatchPlan"];
}): void {
  _sender = opts.sender;
  _secretGetter = opts.secretGetter;
  _getCfgForConv = opts.getCfgForConv;
  _dispatchStep = opts.dispatchStep;
}

function _push(channel: string, data: unknown): void {
  if (_sender && !_sender.isDestroyed()) {
    _sender.send(channel, data);
  }
}

function _buildSnapshot(task: ForgeTask, plan: ForgeTaskPlan, revision: number): TaskRuntimeSnapshot {
  return { task, plan, revision };
}

// ── Callbacks for TaskRunner ──────────────────────────────────────────────

let _snapshotRevision = 0;

function _makeCallbacks(): TaskRunnerCallbacks {
  return {
    onTaskUpdate: (task: ForgeTask) => {
      db.saveTask(true, task);
      _push(TASK_IPC.TASK_UPDATED, { task });
      if (isTaskTerminal(task.status)) {
        _push(TASK_IPC.TASK_TERMINAL, { task });
      }
    },
    onPlanUpdate: (plan: ForgeTaskPlan) => {
      db.saveTaskPlan(true, plan);
    },
    pushSnapshot: (task: ForgeTask, plan: ForgeTaskPlan) => {
      _snapshotRevision++;
      const snap = _buildSnapshot(task, plan, _snapshotRevision);
      _push(TASK_IPC.TASK_UPDATED, snap);
    },
    dispatchStep: async (task, step, plan, signal) => {
      if (!_dispatchStep) {
        throw new Error("TaskManager: dispatchStep not wired — call initTaskManager first");
      }
      return _dispatchStep(task, step, plan, signal);
    },
    dispatchPlan: async (mode, task, currentPlan, cfg, apiKey, signal, reason, errorFeedback) => {
      if (mode === "replan" && currentPlan !== null) {
        const completedSteps = currentPlan.steps.filter(
          (s) => s.status === "completed" || s.status === "skipped"
        );
        return replanPlan(
          task.id, task.goal, completedSteps, currentPlan.version,
          reason ?? "Replan requested", errorFeedback ?? "", cfg, apiKey, signal
        );
      }
      return generatePlan(task.id, task.goal, cfg, apiKey, signal);
    },
    onIncident: (invariantId: string, meta: Record<string, unknown>) => {
      const recorder = tryGetIncidentRecorder();
      if (recorder) {
        try {
          // Record via incident pipeline — best effort
          recorder.record(
            {
              invariantId,
              timestamp: Date.now(),
              observedState: meta,
              ...(meta["conversationId"] ? { conversationId: String(meta["conversationId"]) } : {}),
              ...(meta["requestId"] ? { requestId: String(meta["requestId"]) } : {}),
            },
            {
              failureCode: invariantId === "TASK_STALLED" ? "TASK_STALLED"
                : invariantId === "TASK_BUDGET_STEPS_NOT_EXCEEDED" || invariantId === "TASK_BUDGET_REVISIONS_NOT_EXCEEDED" ? "TASK_BUDGET_EXCEEDED"
                : "TASK_STEP_WRONG_TASK",
            }
          );
        } catch {
          // Best effort
        }
      }
      forgeLogger.warn("task", invariantId as string, { metadata: meta });
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a task and begin planning + execution.
 * This is the main entry point called when classification returns "task".
 */
export async function createAndStartTask(
  convId: string,
  goal: string,
  queueItemId?: string
): Promise<ForgeTask> {
  const conv = db.getConversation(true, convId);
  const projectId = conv?.projectId;

  const task = makeTask(convId, goal, projectId);
  db.saveTask(true, task);
  _push(TASK_IPC.TASK_CREATED, { task });

  forgeLogger.info("task", "TASK_CREATED", {
    metadata: {
      taskId: task.id,
      conversationId: convId,
      ...(projectId ? { projectId } : {}),
      goal: goal.slice(0, 100),
    },
  });

  // Resolve agent config
  const cfgData = _getCfgForConv(convId);
  if (!cfgData) {
    const failed: ForgeTask = {
      ...task,
      status: "failed",
      failure: { code: "NO_AGENT_CONFIG", message: "No agent profile configured for this conversation" },
      updatedAt: Date.now(),
      completedAt: Date.now(),
    };
    db.saveTask(true, failed);
    _push(TASK_IPC.TASK_TERMINAL, { task: failed });
    return failed;
  }

  // Transition to planning
  const planning: ForgeTask = { ...task, status: "planning", updatedAt: Date.now() };
  db.saveTask(true, planning);
  _push(TASK_IPC.TASK_UPDATED, { task: planning });
  forgeLogger.info("task", "TASK_PLANNING_STARTED", { metadata: { taskId: task.id } });

  // Generate plan
  let plan: ForgeTaskPlan;
  try {
    const planResult = await generatePlan(
      task.id,
      goal,
      cfgData.cfg,
      cfgData.apiKey,
      new AbortController().signal
    );
    plan = planResult.plan;
    forgeLogger.info("task", "TASK_PLAN_CREATED", {
      metadata: { taskId: task.id, stepCount: plan.steps.length, version: plan.version },
    });
  } catch {
    // Planner failed — use fallback single-step plan
    forgeLogger.warn("task", "TASK_PLAN_FALLBACK", { metadata: { taskId: task.id } });
    plan = buildFallbackPlan(task.id, goal);
  }

  db.saveTaskPlan(true, plan);

  // Update task to ready
  const ready: ForgeTask = {
    ...planning,
    status: "ready",
    planVersion: plan.version,
    updatedAt: Date.now(),
  };
  db.saveTask(true, ready);
  _push(TASK_IPC.TASK_UPDATED, { task: ready });

  // Start execution (non-blocking — runner drives itself)
  void _startExecution(ready, plan, cfgData.cfg, cfgData.apiKey, queueItemId);

  return ready;
}

async function _startExecution(
  task: ForgeTask,
  plan: ForgeTaskPlan,
  cfg: AgentConfig,
  apiKey: string,
  queueItemId?: string,
): Promise<void> {
  const callbacks = _makeCallbacks();
  try {
    await startTaskRunner(task, plan, cfg, apiKey, callbacks);
    // ── Inject final result into chat (ONE_EXECUTION_OWNER_PER_USER_REQUEST) ──
    // When the root request was task-owned, inject the task summary as the
    // final assistant response exactly once.
    if (queueItemId) {
      const finalTask = db.getTask(true, task.id);
      const profile = (() => {
        const conv = db.getConversation(true, task.conversationId);
        const profileId = conv?.defaultAgentProfileId ?? db.getAppState(true).defaultAgentProfileId;
        return profileId ? db.getAgentProfile(true, profileId) : null;
      })();
      if (profile) {
        const finalContent = finalTask?.status === "completed"
          ? `Task completed: ${finalTask.goal}`
          : finalTask?.status === "failed"
            ? `Task failed: ${finalTask.failure?.message ?? "Unknown error"}`
            : `Task ${finalTask?.status ?? "finished"}: ${task.goal}`;
        completeQueueItemAsTask(
          task.conversationId,
          queueItemId,
          finalContent,
          profile.id,
          profile.name,
          profile.model,
        );
      }
    }
  } catch (err) {
    forgeLogger.error("task", "TASK_RUNNER_UNCAUGHT", {
      metadata: {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    // Even on uncaught error, close the queue item so the user sees a result
    if (queueItemId) {
      const profile = (() => {
        const conv = db.getConversation(true, task.conversationId);
        const profileId = conv?.defaultAgentProfileId ?? db.getAppState(true).defaultAgentProfileId;
        return profileId ? db.getAgentProfile(true, profileId) : null;
      })();
      if (profile) {
        completeQueueItemAsTask(
          task.conversationId,
          queueItemId,
          `Task failed: ${err instanceof Error ? err.message : "Unexpected error"}`,
          profile.id,
          profile.name,
          profile.model,
        );
      }
    }
  }
}

/**
 * Pause the active task for a conversation.
 */
export function pauseConvTask(convId: string): boolean {
  const tasks = db.listTasksByConversation(true, convId);
  const active = tasks.find((t) => t.status === "running" || t.status === "verifying");
  if (!active) return false;
  return pauseTask(active.id);
}

/**
 * Resume a paused task.
 */
export async function resumeTask(taskId: string): Promise<boolean> {
  const task = db.getTask(true, taskId);
  if (!task || task.status !== "paused") return false;

  const plan = db.getTaskPlan(true, taskId);
  if (!plan) return false;

  const cfgData = _getCfgForConv(task.conversationId);
  if (!cfgData) return false;

  // Clear pause flag if runner exists
  const state = getRunnerState(taskId);
  if (state) {
    state.pauseRequested = false;
  }

  // Resume from ready state — runner will pick up from next pending step
  const resumed: ForgeTask = { ...task, status: "ready", updatedAt: Date.now() };
  db.saveTask(true, resumed);
  _push(TASK_IPC.TASK_UPDATED, { task: resumed });
  forgeLogger.info("task", "TASK_RESUMED", { metadata: { taskId } });

  void _startExecution(resumed, plan, cfgData.cfg, cfgData.apiKey);
  return true;
}

/**
 * Cancel a task.
 */
export function cancelConvTask(taskId: string): boolean {
  const task = db.getTask(true, taskId);
  if (!task || isTaskTerminal(task.status)) return false;
  const callbacks = _makeCallbacks();
  return cancelTask(taskId, callbacks);
}

/**
 * Retry a failed task from scratch (new plan, preserving goal).
 */
export async function retryTask(taskId: string): Promise<ForgeTask | null> {
  const task = db.getTask(true, taskId);
  if (!task || task.status !== "failed") return null;

  // Create a fresh task with the same goal
  return createAndStartTask(task.conversationId, task.goal);
}

/**
 * Retry a specific failed step.
 */
export async function retryStep(taskId: string, stepId: string): Promise<boolean> {
  const task = db.getTask(true, taskId);
  const plan = db.getTaskPlan(true, taskId);
  if (!task || !plan) return false;

  const step = plan.steps.find((s) => s.id === stepId);
  if (!step || step.status !== "failed") return false;

  // Reset step to pending — omit error key entirely (exactOptionalPropertyTypes)
  const updatedSteps = plan.steps.map((s) => {
    if (s.id !== stepId) return s;
    const { error: _err, ...rest } = s;
    void _err;
    return { ...rest, status: "pending" as const, attemptCount: 0 };
  });
  const updatedPlan: ForgeTaskPlan = { ...plan, steps: updatedSteps, updatedAt: Date.now() };
  db.saveTaskPlan(true, updatedPlan);

  // Resume task if paused
  if (task.status === "paused" || task.status === "failed") {
    return resumeTask(taskId);
  }
  return true;
}

/**
 * Get the active task for a conversation (most recent non-terminal, or most recent terminal).
 */
export function getActiveTask(convId: string): { task: ForgeTask; plan: ForgeTaskPlan } | null {
  const tasks = db.listTasksByConversation(true, convId);
  if (tasks.length === 0) return null;

  // Prefer non-terminal
  const active = tasks.find((t) => !isTaskTerminal(t.status));
  const target = active ?? tasks[0];
  if (!target) return null;

  const plan = db.getTaskPlan(true, target.id);
  if (!plan) return null;

  return { task: target, plan };
}

/**
 * Startup reconciliation — called once at app start.
 * Marks any tasks that were mid-execution as paused.
 * Does NOT restart or replay any execution.
 */
export function reconcileInterruptedTasks(): void {
  const interrupted = db.listInterruptedTasks(true);
  for (const task of interrupted) {
    // Mark any running/waiting steps as interrupted (safe to retry on resume)
    const plan = db.getTaskPlan(true, task.id);
    if (plan) {
      const staleRunningStepStatuses: import("../../shared/types.js").TaskStepStatus[] = [
        "running",
        "waiting_for_approval",
        "waiting_for_human",
      ];
      const needsStepPatch = plan.steps.some((s) => staleRunningStepStatuses.includes(s.status));
      if (needsStepPatch) {
        const patchedSteps = plan.steps.map((s) =>
          staleRunningStepStatuses.includes(s.status)
            ? { ...s, status: "interrupted" as import("../../shared/types.js").TaskStepStatus }
            : s
        );
        const patchedPlan: import("../../shared/types.js").ForgeTaskPlan = {
          ...plan,
          steps: patchedSteps,
          updatedAt: Date.now(),
        };
        db.saveTaskPlan(true, patchedPlan);
        forgeLogger.info("task", "TASK_STEPS_RECONCILED", {
          metadata: { taskId: task.id, interruptedStepCount: patchedSteps.filter((s) => s.status === "interrupted").length },
        });
      }
    }

    const patched = db.updateTask(true, task.id, {
      status: "paused",
      metadata: { ...task.metadata, executionInterrupted: true, interruptedAt: Date.now() },
    });
    if (patched) {
      _push(TASK_IPC.TASK_RECONCILED, { task: patched });
      forgeLogger.info("task", "TASK_RECONCILED", {
        metadata: { taskId: task.id, wasStatus: task.status },
      });
    }
  }

  if (interrupted.length > 0) {
    forgeLogger.info("task", "TASK_RECONCILIATION_COMPLETE", {
      metadata: { count: interrupted.length },
    });
  }
}

/** For test teardown only */
export function _resetTaskManagerForTest(): void {
  _sender = null;
  _dispatchStep = null;
  _snapshotRevision = 0;
  _resetTaskRunnersForTest();
}