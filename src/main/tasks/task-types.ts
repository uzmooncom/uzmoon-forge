/**
 * task-types.ts — Type guards, validators, and factory helpers for Task Runtime V1.
 *
 * This module is DATA only — no IO, no DB, no IPC.
 * All exported functions are pure.
 */
import { randomUUID } from "crypto";
import type {
  ForgeTask,
  ForgeTaskPlan,
  ForgeTaskStep,
  TaskStatus,
  TaskStepStatus,
  TaskStepType,
  TaskStepResult,
  TaskStepResultStatus,
  StructuredPlannerOutput,
} from "../../shared/types.js";

// ── Terminal state helpers ─────────────────────────────────────────────────

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_STEP_STATUSES: ReadonlySet<TaskStepStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

export function isTaskTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isStepTerminal(status: TaskStepStatus): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}

export function isTaskActive(status: TaskStatus): boolean {
  return (
    status === "running" ||
    status === "waiting_for_approval" ||
    status === "waiting_for_human" ||
    status === "verifying" ||
    status === "planning"
  );
}

// ── Dependency graph helpers ───────────────────────────────────────────────

/**
 * Returns true if the dependency graph formed by steps contains a cycle.
 * Uses DFS with three-colour marking (white/grey/black).
 */
export function hasPlanCycle(steps: ForgeTaskStep[]): boolean {
  const byId = new Map<string, ForgeTaskStep>();
  for (const s of steps) byId.set(s.id, s);

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  for (const s of steps) colour.set(s.id, WHITE);

  function visit(id: string): boolean {
    const c = colour.get(id);
    if (c === BLACK) return false;
    if (c === GREY) return true; // cycle detected
    colour.set(id, GREY);
    const step = byId.get(id);
    if (step) {
      for (const dep of step.dependencies) {
        if (visit(dep)) return true;
      }
    }
    colour.set(id, BLACK);
    return false;
  }

  for (const s of steps) {
    if (colour.get(s.id) === WHITE) {
      if (visit(s.id)) return true;
    }
  }
  return false;
}

/**
 * Returns topologically sorted step IDs (leaves first).
 * Assumes no cycles (call hasPlanCycle first).
 */
export function topoSort(steps: ForgeTaskStep[]): string[] {
  const byId = new Map<string, ForgeTaskStep>();
  for (const s of steps) byId.set(s.id, s);

  const visited = new Set<string>();
  const result: string[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const step = byId.get(id);
    if (step) {
      for (const dep of step.dependencies) visit(dep);
    }
    result.push(id);
  }

  for (const s of steps) visit(s.id);
  return result;
}

/**
 * Returns step IDs whose dependencies are all completed.
 */
export function getReadySteps(steps: ForgeTaskStep[]): ForgeTaskStep[] {
  const completedIds = new Set(
    steps.filter((s) => s.status === "completed" || s.status === "skipped").map((s) => s.id)
  );
  return steps.filter(
    (s) =>
      s.status === "pending" &&
      s.dependencies.every((dep) => completedIds.has(dep))
  );
}

// ── Plan validation ────────────────────────────────────────────────────────

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePlannerOutput(output: unknown): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!output || typeof output !== "object") {
    return { valid: false, errors: ["Plan output is not an object"], warnings };
  }

  const o = output as Record<string, unknown>;

  if (typeof o["goalSummary"] !== "string" || o["goalSummary"].trim() === "") {
    errors.push("goalSummary must be a non-empty string");
  }

  if (!Array.isArray(o["steps"])) {
    errors.push("steps must be an array");
    return { valid: errors.length === 0, errors, warnings };
  }

  const steps = o["steps"] as Array<unknown>;

  if (steps.length === 0) {
    errors.push("Plan must have at least one step");
    return { valid: false, errors, warnings };
  }

  if (steps.length > 25) {
    warnings.push(`Plan has ${steps.length} steps — consider consolidating`);
  }

  const seenIds = new Set<string>();
  const allIds = new Set<string>();

  for (const step of steps) {
    if (!step || typeof step !== "object") {
      errors.push("Each step must be an object");
      continue;
    }
    const s = step as Record<string, unknown>;
    if (typeof s["id"] !== "string" || s["id"].trim() === "") {
      errors.push("Each step must have a non-empty string id");
    } else {
      if (seenIds.has(s["id"])) {
        errors.push(`Duplicate step id: ${s["id"]}`);
      }
      seenIds.add(s["id"]);
      allIds.add(s["id"]);
    }
    if (typeof s["title"] !== "string" || s["title"].trim() === "") {
      errors.push("Each step must have a non-empty string title");
    }
    if (!Array.isArray(s["dependencies"])) {
      errors.push(`Step ${String(s["id"])}: dependencies must be an array`);
    }
    if (!Array.isArray(s["capabilityHints"])) {
      errors.push(`Step ${String(s["id"])}: capabilityHints must be an array`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Validate dependency references
  for (const step of steps) {
    const s = step as Record<string, unknown>;
    const deps = s["dependencies"] as string[];
    for (const dep of deps) {
      if (!allIds.has(dep)) {
        errors.push(`Step ${String(s["id"])}: dependency "${dep}" references unknown step id`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Check for cycles using a temporary step array
  const tempSteps = steps.map((s) => {
    const step = s as Record<string, unknown>;
    return makeStep(
      String(step["id"]),
      "placeholder-task",
      String(step["title"]),
      (step["type"] as TaskStepType) ?? "generic",
      (step["dependencies"] as string[]) ?? []
    );
  });

  if (hasPlanCycle(tempSteps)) {
    errors.push("Plan contains a circular dependency");
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── StepResult extraction ──────────────────────────────────────────────────

const VALID_STEP_RESULT_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "blocked",
  "failed",
  "replan_required",
]);

/**
 * Attempt to extract a TaskStepResult from the agent's final text.
 * Looks for a ```forge_step_result fence.
 * Returns null if no valid result found.
 */
export function extractStepResult(finalText: string): TaskStepResult | null {
  const match = finalText.match(/```forge_step_result\s*([\s\S]*?)```/);
  if (!match || !match[1]) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
    const status = String(parsed["status"] ?? "");
    if (!VALID_STEP_RESULT_STATUSES.has(status)) return null;
    const observations = typeof parsed["observations"] === "string" ? parsed["observations"] : undefined;
    const recommendedPlanChanges = typeof parsed["recommendedPlanChanges"] === "string"
      ? parsed["recommendedPlanChanges"]
      : undefined;
    return {
      status: status as TaskStepResultStatus,
      summary: typeof parsed["summary"] === "string" ? parsed["summary"] : "Step completed",
      evidenceRefs: Array.isArray(parsed["evidenceRefs"])
        ? (parsed["evidenceRefs"] as string[]).filter((r) => typeof r === "string")
        : [],
      ...(observations !== undefined ? { observations } : {}),
      ...(recommendedPlanChanges !== undefined ? { recommendedPlanChanges } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Build a fallback StepResult from the agent's final text when no explicit
 * forge_step_result fence is present. Infers status from content.
 */
export function inferStepResult(finalText: string, agentRunFailed: boolean): TaskStepResult {
  if (agentRunFailed) {
    return {
      status: "failed",
      summary: finalText.slice(0, 300) || "Step execution failed",
      evidenceRefs: [],
    };
  }
  // If text mentions blocking words, treat as blocked
  const lower = finalText.toLowerCase();
  const blockerPatterns = ["cannot proceed", "blocked", "requires human", "missing credential"];
  if (blockerPatterns.some((p) => lower.includes(p))) {
    return {
      status: "blocked",
      summary: finalText.slice(0, 300),
      evidenceRefs: [],
    };
  }
  return {
    status: "completed",
    summary: finalText.slice(0, 300) || "Step completed",
    evidenceRefs: [],
  };
}

// ── Factory helpers ────────────────────────────────────────────────────────

export function makeTask(
  convId: string,
  goal: string,
  projectId?: string
): ForgeTask {
  const now = Date.now();
  return {
    id: randomUUID(),
    conversationId: convId,
    ...(projectId !== undefined ? { projectId } : {}),
    goal,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    planVersion: 0,
    metadata: {},
  };
}

export function makeStep(
  id: string,
  taskId: string,
  title: string,
  type: TaskStepType,
  dependencies: string[] = [],
  opts?: Partial<Pick<ForgeTaskStep, "description" | "expectedOutcome" | "capabilityHints">>
): ForgeTaskStep {
  return {
    id,
    taskId,
    title,
    type,
    status: "pending",
    dependencies,
    capabilityHints: opts?.capabilityHints ?? [],
    evidenceRefs: [],
    attemptCount: 0,
    ...(opts?.description !== undefined ? { description: opts.description } : {}),
    ...(opts?.expectedOutcome !== undefined ? { expectedOutcome: opts.expectedOutcome } : {}),
  };
}

export function makePlan(
  taskId: string,
  rawSteps: StructuredPlannerOutput["steps"],
  version = 1,
  reasonForRevision?: string
): ForgeTaskPlan {
  const now = Date.now();
  const steps: ForgeTaskStep[] = rawSteps.map((s) =>
    makeStep(s.id, taskId, s.title, s.type ?? "generic", s.dependencies, {
      ...(s.description !== undefined ? { description: s.description } : {}),
      ...(s.expectedOutcome !== undefined ? { expectedOutcome: s.expectedOutcome } : {}),
      ...(s.capabilityHints !== undefined ? { capabilityHints: s.capabilityHints } : {}),
    })
  );
  return {
    taskId,
    version,
    steps,
    createdAt: now,
    updatedAt: now,
    ...(reasonForRevision !== undefined ? { reasonForRevision } : {}),
  };
}