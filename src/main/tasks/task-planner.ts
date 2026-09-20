/**
 * task-planner.ts — Structured plan generator for Task Runtime V1.
 *
 * Produces a ForgeTaskPlan from a user goal string by calling the provider
 * with a focused planner prompt and validating the structured output.
 *
 * CONTRACT:
 * - Plan creation is provider-neutral (no provider-specific logic here)
 * - Plan is validated before returning — malformed plans trigger bounded recovery
 * - Completed steps are never mutated during replan
 * - Chain-of-thought is NOT stored — only the executable step list
 *
 * Max recovery attempts: 2 (planner retries with error feedback)
 */

import { randomUUID } from "crypto";
import { makeRequest } from "../agent-client/client.js";
import { isFakeProviderEnabled, fakeRequest } from "../agent-client/fake-provider.js";
import type { AgentConfig, ForgeTaskPlan, ForgeTaskStep, StructuredPlannerOutput } from "../../shared/types.js";
import {
  validatePlannerOutput,
  makePlan,
  makeStep,
} from "./task-types.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_PLANNER_RECOVERY = 2;

// ── Planner system prompt ──────────────────────────────────────────────────

const PLANNER_SYSTEM = `You are Forge's task planner. Your job is to create a concise, executable plan.

Rules:
- Create 2–8 steps. Never more than 12.
- Each step must be a concrete action, not a vague stage.
- Steps should follow: inspect → reproduce → implement → validate → verify.
- Include a verification step when the goal involves code, UI, or observable output.
- Do NOT include steps for capabilities not needed (e.g., no "commit" unless requested).
- Use Safe Git only when the user explicitly requested commit/push.
- Do NOT create steps for browsing unless the goal is UI/web related.

Output ONLY a JSON object in this exact schema inside a \`\`\`forge_plan fence:

\`\`\`forge_plan
{
  "goalSummary": "brief restatement of the goal",
  "steps": [
    {
      "id": "step-1",
      "title": "Short action title",
      "type": "inspect|run|browse|edit|test|git|verify|research|generic",
      "description": "Optional: what specifically to do",
      "dependencies": [],
      "expectedOutcome": "Optional: what success looks like",
      "capabilityHints": ["project_files", "terminal", "browser", "git"]
    }
  ]
}
\`\`\`

Do not output any prose before or after the fence.
Do not include chain-of-thought.
Do not invent extra capabilities.`;

// ── Planner request ────────────────────────────────────────────────────────

function buildPlannerMessages(
  goal: string,
  errorFeedback?: string
): Array<{ role: "user" | "assistant"; content: string }> {
  const msgs: Array<{ role: "user" | "assistant"; content: string }> = [
    {
      role: "user",
      content: errorFeedback
        ? `Plan this task: ${goal}\n\nPrevious attempt was rejected:\n${errorFeedback}\n\nPlease fix the plan and try again.`
        : `Plan this task: ${goal}`,
    },
  ];
  return msgs;
}

function extractForgePlanFence(text: string): string | null {
  const match = text.match(/```forge_plan\s*([\s\S]*?)```/);
  return match?.[1]?.trim() ?? null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface PlannerResult {
  plan: ForgeTaskPlan;
  warnings: string[];
}

export interface PlannerError {
  code: "PLAN_INVALID" | "PLAN_PARSE_FAILED" | "PROVIDER_ERROR" | "RECOVERY_EXHAUSTED";
  message: string;
  errors: string[];
}

/**
 * Generate an initial execution plan for a task goal.
 */
export async function generatePlan(
  taskId: string,
  goal: string,
  cfg: AgentConfig,
  apiKey: string,
  signal: AbortSignal
): Promise<PlannerResult> {
  return _runPlanner(taskId, goal, cfg, apiKey, signal, 1, undefined);
}

/**
 * Generate a revised plan for a task, preserving completed step history.
 * Only future (non-completed) steps are replaced.
 */
export async function replan(
  taskId: string,
  goal: string,
  completedSteps: ForgeTaskStep[],
  currentVersion: number,
  reason: string,
  evidence: string,
  cfg: AgentConfig,
  apiKey: string,
  signal: AbortSignal
): Promise<PlannerResult> {
  const completedSummary =
    completedSteps.length > 0
      ? `\n\nCompleted steps (DO NOT repeat these):\n` +
        completedSteps.map((s) => `- ${s.title}: ${s.lastResult?.summary ?? "completed"}`).join("\n")
      : "";

  const replanGoal =
    `${goal}${completedSummary}\n\nReason for replan: ${reason}\nEvidence: ${evidence}\n` +
    `Plan only the REMAINING work — do not repeat what is already done.`;

  const result = await _runPlanner(
    taskId,
    replanGoal,
    cfg,
    apiKey,
    signal,
    currentVersion + 1,
    undefined
  );

  // Merge: prepend completed steps (read-only) before the new future steps
  const completedFrozen: ForgeTaskStep[] = completedSteps.map((s) => ({
    ...s,
    taskId,
  }));

  return {
    plan: {
      ...result.plan,
      steps: [...completedFrozen, ...result.plan.steps],
      reasonForRevision: reason,
    },
    warnings: result.warnings,
  };
}

// ── Internal ───────────────────────────────────────────────────────────────

async function _runPlanner(
  taskId: string,
  goal: string,
  cfg: AgentConfig,
  apiKey: string,
  signal: AbortSignal,
  version: number,
  _errorFeedback: string | undefined
): Promise<PlannerResult> {
  let lastError: PlannerError | null = null;

  for (let attempt = 0; attempt <= MAX_PLANNER_RECOVERY; attempt++) {
    if (signal.aborted) {
      throw { code: "PROVIDER_ERROR", message: "Cancelled", errors: [] } as PlannerError;
    }

    let rawText: string;
    try {
      const messages = buildPlannerMessages(goal, attempt > 0 ? lastError?.errors.join("; ") : undefined);
      if (isFakeProviderEnabled()) {
        rawText = await fakeRequest({
          messages,
          system: PLANNER_SYSTEM,
          signal,
        });
      } else {
        rawText = await makeRequest({
          cfg,
          apiKey,
          messages,
          system: PLANNER_SYSTEM,
          stream: false,
          signal,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw {
        code: "PROVIDER_ERROR",
        message: `Planner provider call failed: ${msg}`,
        errors: [msg],
      } as PlannerError;
    }

    // Extract forge_plan fence
    const fenceContent = extractForgePlanFence(rawText);
    if (!fenceContent) {
      lastError = {
        code: "PLAN_PARSE_FAILED",
        message: "No forge_plan fence found in planner output",
        errors: ["Response did not contain a ```forge_plan fence"],
      };
      continue;
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(fenceContent);
    } catch (e: unknown) {
      lastError = {
        code: "PLAN_PARSE_FAILED",
        message: "Failed to parse forge_plan JSON",
        errors: [`JSON parse error: ${e instanceof Error ? e.message : String(e)}`],
      };
      continue;
    }

    // Validate
    const validation = validatePlannerOutput(parsed);
    if (!validation.valid) {
      lastError = {
        code: "PLAN_INVALID",
        message: "Plan validation failed",
        errors: validation.errors,
      };
      continue;
    }

    const output = parsed as StructuredPlannerOutput;
    const plan = makePlan(taskId, output.steps, version);

    return { plan, warnings: validation.warnings };
  }

  throw lastError ?? {
    code: "RECOVERY_EXHAUSTED",
    message: "Planner failed after maximum recovery attempts",
    errors: ["RECOVERY_EXHAUSTED"],
  };
}

// ── Fallback plan factory ──────────────────────────────────────────────────

/**
 * Build a minimal fallback plan when the provider planner fails entirely.
 * Produces a single generic step so the task can still start.
 */
export function buildFallbackPlan(taskId: string, goal: string): ForgeTaskPlan {
  const now = Date.now();
  const step = makeStep(
    `step-${randomUUID().slice(0, 8)}`,
    taskId,
    goal.slice(0, 80),
    "generic",
    []
  );
  return {
    taskId,
    version: 1,
    steps: [step],
    createdAt: now,
    updatedAt: now,
    reasonForRevision: "Fallback: planner output was unavailable",
  };
}