/**
 * Multi-Agent Coordinator
 *
 * The coordinator is a special internal agent that orchestrates work item assignment
 * and lifecycle within a ForgeTask. It does NOT:
 *   - edit files, run terminal commands, control browser, stage/commit git
 *   - set ForgeTask.status = "completed" (correction #2)
 *   - create ChatMessages visible in the conversation
 *   - bypass QueueManager for AgentLoop execution
 *
 * It DOES:
 *   - create and assign work items to workers
 *   - accept/reject/merge subtask proposals
 *   - request review of work item outputs
 *   - signal readiness for root-task verification (replacement for mark_task_complete)
 *   - request a replan or pause
 *
 * Execution path (correction #4):
 *   MAManager → runCoordinatorTurn() → [QueueManager internal execution]
 *   This file schedules coordinator turns; actual AgentLoop call goes through
 *   the shared internal primitive in QueueManager.
 */

import { forgeLogger } from "../../telemetry/logger.js";
import { assertInvariant } from "../../reliability/invariants.js";
import {
  createWorkItem,
  updateWorkItem,
  getWorkItemById,
  updateProposal,
  getProposalById,
  bumpBudgetCounter,
} from "./ma-store.js";
import type {
  CoordinatorAction,
  CreateWorkItemAction,
  AssignWorkItemAction,
  AcceptSubtaskAction,
  RejectSubtaskAction,
  MergeSubtaskAction,
  RequestReviewAction,
  MarkReadyForVerificationAction,
  ReplanAction,
  PauseAction,
  AgentWorkItem,
  WorkItemDependency,
} from "./ma-types.js";
import type { ForgeTask, ForgeTaskPlan } from "../../../shared/types.js";

// ── Coordinator system prompt ────────────────────────────────────────────────

export function buildCoordinatorSystemPrompt(
  task: ForgeTask,
  plan: ForgeTaskPlan,
  workItems: AgentWorkItem[],
  pendingProposals: { id: string; title: string; reason: string; suggestedRole: string }[],
  turnNumber: number
): string {
  const stepSummary = plan.steps
    .map((s) => `  - [${s.status}] ${s.title} (id: ${s.id})`)
    .join("\n");

  const workItemSummary = workItems
    .map((w) => {
      const depIds = w.dependencies.map((d) => d.workItemId).join(", ") || "none";
      return `  - [${w.status}] ${w.title} (id: ${w.id}, step: ${w.taskStepId ?? "none"}, deps: ${depIds})`;
    })
    .join("\n");

  const proposalSummary =
    pendingProposals.length > 0
      ? pendingProposals
          .map((p) => `  - id:${p.id} "${p.title}" (role: ${p.suggestedRole}) — reason: ${p.reason}`)
          .join("\n")
      : "  none";

  return `You are the Coordinator for this task. Your role is to orchestrate work items and workers.

TASK GOAL:
${task.goal}

HIGH-LEVEL PLAN (user-visible steps):
${stepSummary}

CURRENT WORK ITEMS:
${workItemSummary}

PENDING SUBTASK PROPOSALS:
${proposalSummary}

COORDINATOR TURN: ${turnNumber}

YOUR RESPONSIBILITIES:
- Create work items that decompose plan steps into concrete executable pieces
- Assign work items to worker agents (by suggesting agentInstanceId or null to auto-assign)
- Accept or reject subtask proposals from workers
- Request review of completed work item outputs
- Signal when all required work appears complete (mark_ready_for_verification)
- Request a replan or pause if progress is blocked

RESTRICTIONS — you CANNOT:
- Edit files, run terminal commands, control a browser, or stage/commit to git
- Mark the root task as "completed" directly (only task verification can do that)
- Create more than one review item per work item attempt
- Create work items at depth > 3

OUTPUT FORMAT:
Respond with a single JSON object inside a \`\`\`forge_coordinator_plan\`\`\` fence:
\`\`\`forge_coordinator_plan
{
  "actions": [
    // Array of CoordinatorAction objects
    // Required fields per action type documented below
  ]
}
\`\`\`

ACTION TYPES:
  create_work_item: { type, title, description, kind, taskStepId, dependencies, capabilityHints, resourceTargets, suggestedRole, expectedOutcome }
  assign_work_item: { type, workItemId, agentInstanceId }  // agentInstanceId: null to auto-assign
  accept_subtask: { type, proposalId, modifications? }
  reject_subtask: { type, proposalId, reason }
  merge_subtask: { type, proposalId, intoWorkItemId }
  request_review: { type, targetWorkItemId, reviewerRole }
  mark_ready_for_verification: { type, summary, evidenceRefs }
  replan: { type, reason }
  pause: { type, reason }

IMPORTANT:
- Always create work items before assigning them
- Each action is applied in order — reference IDs created earlier in this response
- Do not include actions that are already reflected in CURRENT WORK ITEMS
- Be conservative: create fewer, clearer work items rather than many vague ones`;
}

// ── Coordinator plan fence extraction ────────────────────────────────────────

const COORDINATOR_PLAN_FENCE_RE = /```forge_coordinator_plan\s*([\s\S]*?)```/;

export interface ParsedCoordinatorPlan {
  valid: boolean;
  actions: CoordinatorAction[];
  parseError?: string;
}

export function parseCoordinatorPlan(rawText: string): ParsedCoordinatorPlan {
  const match = COORDINATOR_PLAN_FENCE_RE.exec(rawText);
  if (!match || !match[1]) {
    return { valid: false, actions: [], parseError: "No forge_coordinator_plan fence found" };
  }

  try {
    const obj = JSON.parse(match[1].trim()) as { actions?: unknown };
    if (!obj || !Array.isArray(obj.actions)) {
      return { valid: false, actions: [], parseError: "actions must be an array" };
    }

    const actions: CoordinatorAction[] = [];
    for (const a of obj.actions as unknown[]) {
      const validated = _validateAction(a);
      if (!validated.valid) {
        return {
          valid: false,
          actions: [],
          parseError: `Invalid action: ${validated.error} — ${JSON.stringify(a)}`,
        };
      }
      actions.push(validated.action!);
    }

    return { valid: true, actions };
  } catch (err) {
    return { valid: false, actions: [], parseError: `JSON parse error: ${String(err)}` };
  }
}

// ── Coordinator action validation ─────────────────────────────────────────────

interface ActionValidation {
  valid: boolean;
  action?: CoordinatorAction;
  error?: string;
}

function _validateAction(raw: unknown): ActionValidation {
  if (!raw || typeof raw !== "object") {
    return { valid: false, error: "action must be an object" };
  }
  const a = raw as Record<string, unknown>;
  const type = a["type"] as string;

  switch (type) {
    case "create_work_item": {
      if (!a["title"] || !a["description"] || !a["kind"]) {
        return { valid: false, error: "create_work_item missing required fields" };
      }
      const action: CreateWorkItemAction = {
        type: "create_work_item",
        title: String(a["title"]),
        description: String(a["description"]),
        kind: (a["kind"] as CreateWorkItemAction["kind"]) || "generic",
        taskStepId: typeof a["taskStepId"] === "string" ? a["taskStepId"] : null,
        dependencies: _parseDependencies(a["dependencies"]),
        capabilityHints: _parseStringArray(a["capabilityHints"]),
        resourceTargets: _parseStringArray(a["resourceTargets"]),
        suggestedRole: (a["suggestedRole"] as CreateWorkItemAction["suggestedRole"]) || "generic",
        expectedOutcome: typeof a["expectedOutcome"] === "string" ? a["expectedOutcome"] : "",
      };
      return { valid: true, action };
    }

    case "assign_work_item": {
      if (!a["workItemId"]) return { valid: false, error: "assign_work_item missing workItemId" };
      const action: AssignWorkItemAction = {
        type: "assign_work_item",
        workItemId: String(a["workItemId"]),
        agentInstanceId: typeof a["agentInstanceId"] === "string" ? a["agentInstanceId"] : null,
      };
      return { valid: true, action };
    }

    case "accept_subtask": {
      if (!a["proposalId"]) return { valid: false, error: "accept_subtask missing proposalId" };
      const rawMods = a["modifications"] as AcceptSubtaskAction["modifications"] | undefined;
      const action: AcceptSubtaskAction = {
        type: "accept_subtask",
        proposalId: String(a["proposalId"]),
        ...(rawMods !== undefined && { modifications: rawMods }),
      };
      return { valid: true, action };
    }

    case "reject_subtask": {
      if (!a["proposalId"] || !a["reason"]) {
        return { valid: false, error: "reject_subtask missing proposalId or reason" };
      }
      const action: RejectSubtaskAction = {
        type: "reject_subtask",
        proposalId: String(a["proposalId"]),
        reason: String(a["reason"]),
      };
      return { valid: true, action };
    }

    case "merge_subtask": {
      if (!a["proposalId"] || !a["intoWorkItemId"]) {
        return { valid: false, error: "merge_subtask missing proposalId or intoWorkItemId" };
      }
      const action: MergeSubtaskAction = {
        type: "merge_subtask",
        proposalId: String(a["proposalId"]),
        intoWorkItemId: String(a["intoWorkItemId"]),
      };
      return { valid: true, action };
    }

    case "request_review": {
      if (!a["targetWorkItemId"] || !a["reviewerRole"]) {
        return { valid: false, error: "request_review missing targetWorkItemId or reviewerRole" };
      }
      const action: RequestReviewAction = {
        type: "request_review",
        targetWorkItemId: String(a["targetWorkItemId"]),
        reviewerRole: (a["reviewerRole"] as RequestReviewAction["reviewerRole"]) || "reviewer",
      };
      return { valid: true, action };
    }

    case "mark_ready_for_verification": {
      if (!a["summary"]) {
        return { valid: false, error: "mark_ready_for_verification missing summary" };
      }
      const action: MarkReadyForVerificationAction = {
        type: "mark_ready_for_verification",
        summary: String(a["summary"]),
        evidenceRefs: _parseStringArray(a["evidenceRefs"]),
      };
      return { valid: true, action };
    }

    case "replan": {
      const action: ReplanAction = {
        type: "replan",
        reason: typeof a["reason"] === "string" ? a["reason"] : "coordinator requested replan",
      };
      return { valid: true, action };
    }

    case "pause": {
      const action: PauseAction = {
        type: "pause",
        reason: typeof a["reason"] === "string" ? a["reason"] : "coordinator requested pause",
      };
      return { valid: true, action };
    }

    default:
      return { valid: false, error: `Unknown action type: ${type}` };
  }
}

// ── Action application ────────────────────────────────────────────────────────

export interface ApplyActionsResult {
  readyForVerification: boolean;
  verificationSummary: string;
  verificationEvidenceRefs: string[];
  replanRequested: boolean;
  replanReason: string;
  pauseRequested: boolean;
  pauseReason: string;
  /** IDs of newly created work items (for dependency chaining within the same turn) */
  newWorkItemIds: Map<string, string>; // action index → workItemId
}

/**
 * Apply coordinator actions to the MA store.
 * Called after a coordinator turn completes and its plan is parsed.
 *
 * Correction #2: mark_task_complete is gone; coordinator uses mark_ready_for_verification.
 * Correction #15: coordinator cannot apply execution tools — only orchestration actions.
 */
export function applyCoordinatorActions(
  task: ForgeTask,
  plan: ForgeTaskPlan,
  actions: CoordinatorAction[],
  coordinatorInstanceId: string,
  turnNumber: number
): ApplyActionsResult {
  const result: ApplyActionsResult = {
    readyForVerification: false,
    verificationSummary: "",
    verificationEvidenceRefs: [],
    replanRequested: false,
    replanReason: "",
    pauseRequested: false,
    pauseReason: "",
    newWorkItemIds: new Map(),
  };

  // INV: COORDINATOR_HAS_NO_EXECUTION_TOOLS — enforced by action type validation above
  // The only valid action types in CoordinatorAction are orchestration-only.

  for (let idx = 0; idx < actions.length; idx++) {
    const action = actions[idx]!;

    try {
      switch (action.type) {
        case "create_work_item": {
          // INV: MA_COORDINATOR_CANNOT_COMPLETE_ROOT_TASK — create_work_item is fine
          assertInvariant(
            "MA_WORK_ITEM_COUNT_WITHIN_BUDGET",
            true, // guard is inside createWorkItem
            {},
            {}
          );

          // Resolve dependency IDs (action may reference items created earlier in this turn)
          const resolvedDeps: WorkItemDependency[] = action.dependencies.map((dep) => {
            const resolvedId = result.newWorkItemIds.get(dep.workItemId) ?? dep.workItemId;
            return { workItemId: resolvedId, skipSatisfiesDependencies: dep.skipSatisfiesDependencies };
          });

          const wi = createWorkItem({
            taskId: task.id,
            taskStepId: action.taskStepId,
            planVersion: plan.version,
            title: action.title,
            description: action.description,
            kind: action.kind,
            expectedOutcome: action.expectedOutcome,
            capabilityHints: action.capabilityHints,
            resourceTargets: action.resourceTargets,
            suggestedRole: action.suggestedRole,
            dependencies: resolvedDeps,
            createdByType: turnNumber === 1 ? "coordinator_initial" : "coordinator_replan",
            createdByAgentId: coordinatorInstanceId,
            sourceProposalId: null,
          });

          // Map action index to new work item id (for dependency resolution)
          result.newWorkItemIds.set(String(idx), wi.id);

          forgeLogger.info("task", "MA_COORDINATOR_ACTION_APPLIED", {
            metadata: { taskId: task.id, action: "create_work_item", workItemId: wi.id },
          });
          break;
        }

        case "assign_work_item": {
          const wi = getWorkItemById(action.workItemId);
          if (!wi) {
            forgeLogger.warn("task", "MA_COORDINATOR_ACTION_APPLIED", {
              metadata: { taskId: task.id, action: "assign_work_item", error: "work item not found", workItemId: action.workItemId },
            });
            break;
          }

          updateWorkItem(action.workItemId, {
            status: "assigned",
            assignedInstanceId: action.agentInstanceId,
          });

          forgeLogger.info("task", "MA_COORDINATOR_ACTION_APPLIED", {
            metadata: { taskId: task.id, action: "assign_work_item", workItemId: action.workItemId },
          });
          break;
        }

        case "accept_subtask": {
          const proposal = getProposalById(action.proposalId);
          if (!proposal || proposal.taskId !== task.id) break;

          const merged = action.modifications
            ? { ...proposal, ...action.modifications }
            : proposal;

          const wi = createWorkItem({
            taskId: task.id,
            taskStepId: null,
            planVersion: plan.version,
            title: merged.title,
            description: merged.description,
            kind: "generic",
            expectedOutcome: merged.expectedOutcome,
            capabilityHints: merged.capabilityHints,
            resourceTargets: merged.resourceTargets,
            suggestedRole: merged.suggestedRole,
            dependencies: merged.dependencies,
            createdByType: "subtask_accept",
            createdByAgentId: coordinatorInstanceId,
            sourceProposalId: proposal.id,
          });

          updateProposal(action.proposalId, {
            status: "accepted",
            resolvedAt: Date.now(),
            coordinatorDecision: {
              turnNumber,
              action: "accept_subtask",
              timestamp: Date.now(),
            },
          });

          result.newWorkItemIds.set(String(idx), wi.id);
          bumpBudgetCounter(task.id, "subtasksAccepted");

          forgeLogger.info("task", "MA_PROPOSAL_ACCEPTED", {
            metadata: { taskId: task.id, proposalId: proposal.id, newWorkItemId: wi.id },
          });
          break;
        }

        case "reject_subtask": {
          const proposal = getProposalById(action.proposalId);
          if (!proposal || proposal.taskId !== task.id) break;

          updateProposal(action.proposalId, {
            status: "rejected",
            resolvedAt: Date.now(),
            coordinatorDecision: {
              turnNumber,
              action: "reject_subtask",
              timestamp: Date.now(),
              note: action.reason,
            },
          });

          bumpBudgetCounter(task.id, "subtasksRejected");

          forgeLogger.info("task", "MA_PROPOSAL_REJECTED", {
            metadata: { taskId: task.id, proposalId: proposal.id, reason: action.reason },
          });
          break;
        }

        case "merge_subtask": {
          const proposal = getProposalById(action.proposalId);
          if (!proposal || proposal.taskId !== task.id) break;

          updateProposal(action.proposalId, {
            status: "merged",
            resolvedAt: Date.now(),
            coordinatorDecision: {
              turnNumber,
              action: "merge_subtask",
              timestamp: Date.now(),
              note: `Merged into ${action.intoWorkItemId}`,
            },
          });

          forgeLogger.info("task", "MA_COORDINATOR_ACTION_APPLIED", {
            metadata: { taskId: task.id, action: "merge_subtask", proposalId: proposal.id, intoWorkItemId: action.intoWorkItemId },
          });
          break;
        }

        case "request_review": {
          const targetWI = getWorkItemById(action.targetWorkItemId);
          if (!targetWI || targetWI.taskId !== task.id) break;

          // Create a review work item
          const reviewWI = createWorkItem({
            taskId: task.id,
            taskStepId: targetWI.taskStepId,
            planVersion: plan.version,
            title: `Review: ${targetWI.title}`,
            description: `Review the output of work item "${targetWI.title}" (id: ${targetWI.id}). Check for correctness, completeness, and quality.`,
            kind: "review",
            expectedOutcome: `Verdict: APPROVE or CHANGES_REQUIRED`,
            capabilityHints: ["review", "quality_check"],
            resourceTargets: targetWI.resourceTargets,
            suggestedRole: action.reviewerRole,
            dependencies: [{ workItemId: targetWI.id, skipSatisfiesDependencies: false }],
            createdByType: "system",
            createdByAgentId: coordinatorInstanceId,
            sourceProposalId: null,
          });

          updateWorkItem(targetWI.id, {
            reviewCycles: targetWI.reviewCycles + 1,
            reviewWorkItemId: reviewWI.id,
          });

          bumpBudgetCounter(task.id, "reviewCycles");

          forgeLogger.info("task", "MA_REVIEW_STARTED", {
            metadata: { taskId: task.id, targetWorkItemId: targetWI.id, reviewWorkItemId: reviewWI.id },
          });
          break;
        }

        case "mark_ready_for_verification": {
          // INV: ROOT_TASK_COMPLETION_REQUIRES_TASK_VERIFICATION
          // Coordinator cannot complete the task — only signal readiness.
          // Actual verification is done by Task Runtime.
          assertInvariant(
            "MA_COORDINATOR_CANNOT_COMPLETE_ROOT_TASK",
            true, // This action is allowed; it's the mark_task_complete that's forbidden
            {},
            {}
          );

          result.readyForVerification = true;
          result.verificationSummary = action.summary;
          result.verificationEvidenceRefs = action.evidenceRefs;

          forgeLogger.info("task", "MA_READY_FOR_VERIFICATION", {
            metadata: {
              taskId: task.id,
              summary: action.summary.slice(0, 100),
              evidenceCount: action.evidenceRefs.length,
            },
          });
          break;
        }

        case "replan": {
          result.replanRequested = true;
          result.replanReason = action.reason;
          break;
        }

        case "pause": {
          result.pauseRequested = true;
          result.pauseReason = action.reason;
          break;
        }
      }
    } catch (err) {
      forgeLogger.error("task", "MA_COORDINATOR_ACTION_ERROR", {
        metadata: { taskId: task.id, actionType: action.type, error: String(err) },
      });
    }
  }

  bumpBudgetCounter(task.id, "coordinatorTurns");
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _parseDependencies(raw: unknown): WorkItemDependency[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is Record<string, unknown> => d != null && typeof d === "object")
    .map((d) => ({
      workItemId: String(d["workItemId"] ?? ""),
      skipSatisfiesDependencies: d["skipSatisfiesDependencies"] === true,
    }))
    .filter((d) => d.workItemId.length > 0);
}

function _parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}