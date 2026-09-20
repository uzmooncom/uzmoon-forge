/**
 * task-classifier.ts — Lightweight 3-class classifier for user messages.
 *
 * Determines whether a message should be handled as:
 *   "conversation"  — simple question or dialogue, no plan needed
 *   "simple_action" — single direct action with known capability
 *   "task"          — multi-step goal requiring task orchestration
 *
 * This module uses ONLY heuristics — no LLM call, no IO.
 * It is intentionally conservative: when in doubt, classify as "conversation"
 * so existing behaviour is preserved.
 *
 * Heuristics (in order):
 * 1. Very short messages or pure questions → conversation
 * 2. Single-imperative known-action patterns → simple_action
 * 3. Multi-step indicators, goal verbs, compound work → task
 * 4. Default → conversation
 */

import type { TaskClassification } from "../../shared/types.js";

// ── Patterns ────────────────────────────────────────────────────────────────

/**
 * Patterns that strongly indicate a pure conversational message.
 * Matched against the lowercased trimmed message.
 */
const CONVERSATION_PATTERNS: RegExp[] = [
  /^(what|who|when|where|why|how|is|are|can|does|do|should|would|could|will|explain|describe|tell me)\b/,
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|sounds good|great|perfect|nice)/,
  /^(what is|what are|what does|what do|how does|how do|why is|why are)\b/,
];

/**
 * Patterns that indicate a simple, single-action directive.
 * These do NOT need full task orchestration.
 */
const SIMPLE_ACTION_PATTERNS: RegExp[] = [
  /^(open|close|show|hide|navigate|go to|browse to|open the browser)\b/,
  /^(run|execute|start|stop|restart|launch)\s+(the\s+)?(server|app|tests?|build|linter|dev server)\b/,
  /^(search|find|look for|look up)\s+\w+/,
  /^(list|show|display|get)\s+(all\s+)?(files?|folders?|projects?|conversations?|messages?)\b/,
  /^(take|capture)\s+a?\s*(screenshot)\b/,
  /^(read|view|open|show)\s+(the\s+)?(file|this file)\b/,
];

/**
 * Patterns that strongly indicate a multi-step task.
 */
const TASK_PATTERNS: RegExp[] = [
  // Goal verbs with objects — fix/build/implement/create imply verify-after
  /\b(fix|repair|resolve|debug|troubleshoot)\s+\w/,
  /\b(implement|build|create|add|integrate|set up|setup)\s+\w/,
  /\b(refactor|clean up|improve|optimize|rewrite)\s+\w/,
  /\b(migrate|upgrade|update)\s+\w/,
  // Compound work signals
  /\b(and then|and also|afterwards|then verify|then commit|then test|then check)\b/,
  /\b(make sure it works?|verify (it|that|the)|check (if|that|the result)|confirm (it|that))\b/,
  /\b(run the tests?|run tests?|execute tests?|make (the )?tests? pass)\b/,
  /\b(commit (the|it|these?)|push (it|the changes?|to))\b/,
  // Research tasks
  /\b(research|investigate|analyze|analyse|compare|survey|summarize|summarise)\b.{10,}/,
  // UI/browser verification implied
  /\b(look (right|good|correct|better)|visually|in the browser|rendered|screenshot)\b/,
  // Explicit multi-step phrasing
  /\b(step by step|phase(s| \d)|plan (to|for)|approach|strategy)\b/,
  /^(go ahead and|please)\s+\w.{20,}/,
];

/**
 * Minimum word count to even consider as a task.
 * Very short messages are almost always conversation.
 */
const MIN_TASK_WORD_COUNT = 6;

/**
 * Maximum word count for a "simple action" message.
 * Long messages are more likely multi-step work.
 */
const MAX_SIMPLE_ACTION_WORDS = 12;

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify a user message.
 *
 * @param content - The raw user message text
 * @param isProjectMode - Whether the conversation is project-scoped
 * @returns Classification decision
 */
export function classifyMessage(
  content: string,
  isProjectMode: boolean
): TaskClassification {
  try {
    return _classifyMessageImpl(content, isProjectMode);
  } catch {
    // Conservative fallback — never accidentally trigger task mode on classifier error
    return "conversation";
  }
}

function _classifyMessageImpl(
  content: string,
  isProjectMode: boolean
): TaskClassification {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  // Very short messages → conversation
  if (wordCount <= 3) return "conversation";

  // Pure questions / conversational openers → conversation
  for (const pattern of CONVERSATION_PATTERNS) {
    if (pattern.test(lower)) return "conversation";
  }

  // Non-project conversations: be very conservative about task classification.
  // Only classify as task if strongly multi-step.
  if (!isProjectMode) {
    const taskScore = countMatches(lower, TASK_PATTERNS);
    if (taskScore >= 2) return "task";
    // Research with a clear compound goal in global chat
    if (taskScore === 1 && wordCount >= 12) return "task";
    return "conversation";
  }

  // Project mode: more willing to classify as task

  // Check simple action patterns first (project mode may legitimately use these)
  if (wordCount <= MAX_SIMPLE_ACTION_WORDS) {
    for (const pattern of SIMPLE_ACTION_PATTERNS) {
      if (pattern.test(lower)) return "simple_action";
    }
  }

  // Check task patterns
  const taskScore = countMatches(lower, TASK_PATTERNS);

  if (taskScore >= 1 && wordCount >= MIN_TASK_WORD_COUNT) {
    return "task";
  }

  // Multi-sentence messages in project mode are likely tasks
  const sentenceCount = (trimmed.match(/[.!?]+/g) ?? []).length;
  if (sentenceCount >= 2 && wordCount >= MIN_TASK_WORD_COUNT) {
    return "task";
  }

  // Long single-sentence project messages with action verbs
  if (wordCount >= 15 && /\b(fix|implement|build|update|change|modify|edit|write|create|add|remove|delete)\b/.test(lower)) {
    return "task";
  }

  return "conversation";
}

function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const p of patterns) {
    if (p.test(text)) count++;
  }
  return count;
}

/**
 * Whether task runtime is enabled for a given conversation.
 * V1: enabled when FORGE_TASKS_ENABLED env var is "1" or "true".
 * This allows safe staged rollout — existing conversations unaffected by default.
 */
export function isTaskRuntimeEnabled(): boolean {
  const v = process.env["FORGE_TASKS_ENABLED"];
  return v === "1" || v === "true";
}