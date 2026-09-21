/**
 * Multi-Agent Worker Runner
 *
 * Executes a single AgentWorkItem using the shared internal execution path
 * in QueueManager. Workers use the exact same AgentLoop, PermissionCenter,
 * EvidenceRegistry, and ResourceManager as single-agent task steps.
 *
 * Execution path (correction #4):
 *   MAManager → dispatchWorkItem() → QueueManager.runWorkItemStep()
 *   → runAgentLoop() → existing tool infrastructure
 *
 * This module owns:
 *   - Building the worker prompt (work item context injection)
 *   - Parsing WorkItemResult from forge_step_result fence
 *   - Extracting SubtaskProposals from worker output
 *   - Releasing resource leases post-execution
 *   - Updating AgentRun metadata (workItemId, agentInstanceId)
 */

import { randomUUID } from "crypto";
import { forgeLogger } from "../../telemetry/logger.js";
import {
  updateWorkItem,
  updateInstance,
  recordAssignment,
  closeAssignment,
  bumpBudgetCounter,
} from "./ma-store.js";
import { releaseAllLeasesForWorkItem } from "./resource-manager.js";
import type {
  AgentWorkItem,
  AgentInstance,
  WorkItemResult,
  SubtaskProposal,
  AssignmentHistoryEntry,
  MARunMetadata,
} from "./ma-types.js";
import type { ForgeTask, ForgeTaskPlan } from "../../../shared/types.js";

// ── Worker prompt builder ──────────────────────────────────────────────────

/**
 * Build the work item execution prompt.
 * Context is injected via the existing forge_task_context XML wrapper
 * that the existing system prompt already explains.
 */
export function buildWorkerPrompt(
  task: ForgeTask,
  plan: ForgeTaskPlan,
  workItem: AgentWorkItem,
  allWorkItems: AgentWorkItem[]
): string {
  const stepTitle = plan.steps.find((s) => s.id === workItem.taskStepId)?.title ?? "(no linked step)";

  // Show context from completed dependency work items
  const completedDeps = workItem.dependencies
    .map((dep) => allWorkItems.find((w) => w.id === dep.workItemId))
    .filter((w): w is AgentWorkItem => w != null && w.status === "completed")
    .map((w) => `  - [${w.title}]: ${w.lastResult?.summary ?? "completed"}`);

  const depContext =
    completedDeps.length > 0
      ? `\nCompleted dependency results:\n${completedDeps.join("\n")}`
      : "";

  const capHints =
    workItem.capabilityHints.length > 0
      ? `\nCapability hints: ${workItem.capabilityHints.join(", ")}`
      : "";

  const resourceHints =
    workItem.resourceTargets.length > 0
      ? `\nResource targets: ${workItem.resourceTargets.join(", ")}`
      : "";

  const roleNote = workItem.suggestedRole !== "generic"
    ? `\nYou are acting as: ${workItem.suggestedRole}`
    : "";

  return [
    `<forge_task_context>`,
    `Task Goal: ${task.goal}`,
    `Plan Step: ${stepTitle}`,
    `Work Item: ${workItem.title} (attempt ${workItem.attemptCount + 1})`,
    workItem.description ? `Description: ${workItem.description}` : "",
    workItem.expectedOutcome ? `Expected Outcome: ${workItem.expectedOutcome}` : "",
    roleNote,
    capHints,
    resourceHints,
    depContext,
    `</forge_task_context>`,
    ``,
    `Execute this work item: ${workItem.title}`,
    ``,
    `When done, output a \`\`\`forge_step_result fence:`,
    `\`\`\`forge_step_result`,
    `{`,
    `  "status": "completed" | "failed" | "blocked" | "replan_required",`,
    `  "summary": "what was done or why it failed",`,
    `  "evidenceRefs": [],`,
    `  "observations": "optional — useful findings for next steps",`,
    `  "discoveredSubtasks": []`,
    `}`,
    `\`\`\``,
    ``,
    `You may include an optional "discoveredSubtasks" array in your forge_step_result.`,
    `Each entry: { "title": string, "description": string, "reason": string, "suggestedRole": string, "expectedOutcome": string }`,
    `Subtasks will be reviewed by the coordinator — do NOT implement them yourself.`,
  ].filter(Boolean).join("\n");
}

// ── Work item result parsing ───────────────────────────────────────────────

/**
 * Extract a WorkItemResult from the raw forge_step_result fence.
 * Reuses the same fence format as task steps (correction #3).
 * Additionally extracts any discoveredSubtasks.
 */
export function parseWorkItemResult(rawText: string): WorkItemResult | null {
  const match = /```forge_step_result\s*([\s\S]*?)```/.exec(rawText);
  if (!match || !match[1]) return null;

  try {
    const obj = JSON.parse(match[1].trim()) as Record<string, unknown>;
    const status = obj["status"] as WorkItemResult["status"];

    if (!["completed", "blocked", "failed", "replan_required", "protocol_recovery"].includes(status)) {
      return null;
    }

    const discoveredSubtasks = _parseDiscoveredSubtasks(obj["discoveredSubtasks"]);

    const observations = typeof obj["observations"] === "string" ? obj["observations"] : undefined;
    return {
      status,
      summary: typeof obj["summary"] === "string" ? obj["summary"] : "",
      evidenceRefs: Array.isArray(obj["evidenceRefs"])
        ? (obj["evidenceRefs"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      ...(observations !== undefined && { observations }),
      discoveredSubtasks,
    };
  } catch {
    return null;
  }
}

function _parseDiscoveredSubtasks(raw: unknown): SubtaskProposal[] {
  if (!Array.isArray(raw)) return [];

  const result: SubtaskProposal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (!obj["title"] || typeof obj["title"] !== "string") continue;

    // Full construction happens in ma-manager; here we return partial shapes
    // that the caller will complete with ids and task context.
    result.push({
      id: randomUUID(),
      taskId: "", // filled in by caller
      sourceWorkItemId: "", // filled in by caller
      proposedByAgentId: "", // filled in by caller
      title: String(obj["title"]),
      description: typeof obj["description"] === "string" ? obj["description"] : "",
      reason: typeof obj["reason"] === "string" ? obj["reason"] : "",
      dependencies: [],
      capabilityHints: [],
      resourceTargets: [],
      suggestedRole: (typeof obj["suggestedRole"] === "string" ? obj["suggestedRole"] : "generic") as SubtaskProposal["suggestedRole"],
      expectedOutcome: typeof obj["expectedOutcome"] === "string" ? obj["expectedOutcome"] : "",
      status: "pending",
      createdAt: Date.now(),
      resolvedAt: null,
    });
  }
  return result;
}

// ── Work item execution lifecycle helpers ─────────────────────────────────

export interface WorkItemStartResult {
  assignmentId: string;
}

/**
 * Transition a work item to "running" and record the assignment.
 * Called before dispatching to QueueManager.runWorkItemStep().
 */
export function beginWorkItemExecution(
  workItem: AgentWorkItem,
  instance: AgentInstance
): WorkItemStartResult {
  const assignmentId = randomUUID();
  const now = Date.now();

  updateWorkItem(workItem.id, {
    status: "running",
    assignedInstanceId: instance.id,
    attemptCount: workItem.attemptCount + 1,
    lastAttemptAt: now,
    startedAt: workItem.startedAt ?? now,
  });

  updateInstance(instance.id, {
    status: "working",
    currentWorkItemId: workItem.id,
  });

  const assignment: AssignmentHistoryEntry = {
    id: assignmentId,
    taskId: workItem.taskId,
    workItemId: workItem.id,
    agentInstanceId: instance.id,
    assignedAt: now,
    completedAt: null,
    outcome: null,
    attemptNumber: workItem.attemptCount + 1,
  };
  recordAssignment(assignment);

  forgeLogger.info("task", "MA_WORK_ITEM_STARTED", {
    metadata: {
      taskId: workItem.taskId,
      workItemId: workItem.id,
      instanceId: instance.id,
      attempt: workItem.attemptCount + 1,
    },
  });

  return { assignmentId };
}

/**
 * Transition a work item to its post-execution state.
 * Called after QueueManager.runWorkItemStep() resolves.
 */
export function finalizeWorkItemExecution(
  workItem: AgentWorkItem,
  instance: AgentInstance,
  assignmentId: string,
  result: WorkItemResult | null,
  cancelled: boolean
): void {
  releaseAllLeasesForWorkItem(workItem.id);

  const now = Date.now();

  if (cancelled) {
    updateWorkItem(workItem.id, {
      status: "interrupted",
      lastResult: result ?? undefined as unknown as WorkItemResult,
    });
    updateInstance(instance.id, { status: "idle_reuse", currentWorkItemId: null });
    closeAssignment(assignmentId, "interrupted");

    forgeLogger.info("task", "MA_WORK_ITEM_INTERRUPTED", {
      metadata: { taskId: workItem.taskId, workItemId: workItem.id },
    });
    return;
  }

  if (!result || result.status === "protocol_recovery") {
    // Treat protocol_recovery as a soft failure — increment attempt, keep retryable
    updateWorkItem(workItem.id, { status: "pending", lastResult: result ?? undefined as unknown as WorkItemResult });
    updateInstance(instance.id, { status: "idle_reuse", currentWorkItemId: null });
    closeAssignment(assignmentId, "failed");
    bumpBudgetCounter(workItem.taskId, "providerTurnsByWorker");
    return;
  }

  const statusMap: Record<WorkItemResult["status"], AgentWorkItem["status"]> = {
    completed: "completed",
    blocked: "blocked",
    failed: "failed",
    replan_required: "failed", // triggers coordinator replan path
    protocol_recovery: "pending",
  };

  const newStatus: AgentWorkItem["status"] = statusMap[result.status];

  updateWorkItem(workItem.id, {
    status: newStatus,
    lastResult: result,
    evidenceRefs: result.evidenceRefs,
    completedAt: newStatus === "completed" ? now : null,
  });

  const instanceStatus: AgentInstance["status"] =
    newStatus === "completed" ? "idle_reuse" : "idle_reuse";

  updateInstance(instance.id, {
    status: instanceStatus,
    currentWorkItemId: null,
    completedWorkItems:
      newStatus === "completed" ? instance.completedWorkItems + 1 : instance.completedWorkItems,
  });

  const outcome: AssignmentHistoryEntry["outcome"] =
    newStatus === "completed" ? "completed" : "failed";
  closeAssignment(assignmentId, outcome);

  bumpBudgetCounter(workItem.taskId, "providerTurnsByWorker");

  const logEvent = newStatus === "completed"
    ? "MA_WORK_ITEM_COMPLETED"
    : newStatus === "blocked"
    ? "MA_WORK_ITEM_BLOCKED"
    : "MA_WORK_ITEM_FAILED";

  forgeLogger.info("task", logEvent, {
    metadata: {
      taskId: workItem.taskId,
      workItemId: workItem.id,
      instanceId: instance.id,
      status: newStatus,
      summary: result.summary.slice(0, 80),
    },
  });
}

// ── MA run metadata builder ────────────────────────────────────────────────

/**
 * Build the MARunMetadata that must be passed through every internal
 * multi-agent AgentRun (correction #6 — full canonical metadata).
 */
export function buildMARunMetadata(
  task: ForgeTask,
  workItem: AgentWorkItem,
  instance: AgentInstance
): MARunMetadata {
  return {
    taskId: task.id,
    planVersion: workItem.planVersion,
    taskStepId: workItem.taskStepId,
    workItemId: workItem.id,
    workItemAttempt: workItem.attemptCount + 1,
    agentInstanceId: instance.id,
    conversationId: task.conversationId,
    projectId: null, // filled from conv.projectId by caller
  };
}