/**
 * task-classifier.ts — Lightweight 3-class classifier for user messages.
 *
 * Determines whether a message should be handled as:
 *   "conversation"  — simple question or dialogue, no plan needed
 *   "simple_action" — single direct action with known capability
 *   "task"          — multi-step goal requiring task orchestration
 *
 * This module uses ONLY heuristics — no LLM call, no IO.
 *
 * Classification is INTENT/CAPABILITY/CONTEXT based.
 * A short message CAN be a task if it has clear action intent in project mode.
 * Word count is NOT used as a primary gate.
 *
 * Heuristics (in order):
 * 1. Pure questions / conversational openers → conversation
 * 2. Very short greetings/affirmations → conversation
 * 3. Single-imperative known-action patterns → simple_action (project mode)
 * 4. Action-verb intent signals → task (project mode) or gated task (global)
 * 5. Default → conversation
 */

import type { TaskClassification } from "../../shared/types.js";

// ── Patterns ────────────────────────────────────────────────────────────────

/**
 * Patterns that strongly indicate a pure conversational message.
 * Matched against the lowercased trimmed message.
 */
const CONVERSATION_PATTERNS: RegExp[] = [
  // Question starters
  /^(what|who|when|where|why|how|is|are|can|does|do|should|would|could|will)\b.*\?/,
  /^(what is|what are|what does|what do|how does|how do|why is|why are|can you explain|explain)\b/,
  // Conversational openers / reactions
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|sounds good|great|perfect|nice|awesome)\b/,
  // Pure describe/tell-me without action
  /^(describe|tell me|show me what|what is|what are)\b/,
];

/**
 * Patterns that indicate a simple, single-action directive.
 * These do NOT need full task orchestration.
 * Only matched in project mode.
 */
const SIMPLE_ACTION_PATTERNS: RegExp[] = [
  /^(open|close|show|hide|navigate|go to|browse to|open the browser)\b/,
  /^(run|execute|start|stop|restart|launch)\s+(the\s+)?(server|app|tests?|build|linter|dev server|project)\b/,
  /^(search|find|look for|look up)\s+\w+/,
  /^(list|display|get)\s+(all\s+)?(files?|folders?|projects?|conversations?|messages?)\b/,
  /^(take|capture)\s+a?\s*(screenshot)\b/,
  /^(read|view)\s+(the\s+)?(file|this file)\b/,
];

/**
 * Action-verb patterns that indicate task-worthy intent.
 * A single match in project mode = task (no word-count requirement).
 * In global mode: requires 2+ matches or 1 match + high word count.
 */
const TASK_PATTERNS: RegExp[] = [
  // Fix/debug verbs — "Fix the bug", "Fix this", "Debug it", "Resolve the issue"
  /\b(fix|repair|resolve|debug|troubleshoot)\b/,
  // Build/implement — "Implement auth", "Build the feature", "Create a modal"
  /\b(implement|build|create|add|integrate|set up|setup)\b/,
  // Improve/refactor
  /\b(refactor|clean up|improve|optimize|rewrite)\b/,
  // Migrate/upgrade
  /\b(migrate|upgrade|update|change|modify|edit)\b/,
  // Compound work signals
  /\b(and then|and also|afterwards|then verify|then commit|then test|then check)\b/,
  /\b(make sure it works?|verify (it|that|the)|check (if|that|the result)|confirm (it|that))\b/,
  /\b(run the tests?|run tests?|execute tests?|make (the )?tests? pass)\b/,
  /\b(commit (the|it|these?)|push (it|the changes?|to))\b/,
  // Research tasks (only when substantial)
  /\b(research|investigate|analyze|analyse|compare|survey|summarize|summarise)\b.{10,}/,
  // UI/browser verification implied
  /\b(look (right|good|correct|better)|visually|in the browser|rendered|screenshot)\b/,
  // Explicit multi-step phrasing
  /\b(step by step|phase(s| \d)|plan (to|for)|approach|strategy)\b/,
];

/**
 * Action verbs that on their own (without "simple action" pattern) indicate
 * task intent in project mode — even in short messages.
 * "Fix the bug" → fix + object → task
 * "Fix this" → fix + object → task
 * "Run the project" → matches SIMPLE_ACTION_PATTERNS first → simple_action
 */
const PROJECT_ACTION_VERB_PATTERN = /^(fix|repair|resolve|debug|implement|build|create|add|refactor|clean up|improve|optimize|rewrite|migrate|upgrade|update|change|modify|remove|delete|write|check|verify|find|search|review|test|analyse|analyze|inspect|examine)\b/;

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

  // Absolute minimum — empty or single token
  if (wordCount === 0) return "conversation";

  // Pure questions / conversational openers — always conversation
  for (const pattern of CONVERSATION_PATTERNS) {
    if (pattern.test(lower)) return "conversation";
  }

  // Very short greetings / single words with no action meaning
  if (wordCount <= 1) return "conversation";

  // Non-project mode: conservative
  if (!isProjectMode) {
    const taskScore = countMatches(lower, TASK_PATTERNS);
    if (taskScore >= 2) return "task";
    // Research/compound goal with high word count
    if (taskScore === 1 && wordCount >= 12) return "task";
    return "conversation";
  }

  // ── Project mode ──────────────────────────────────────────────────────────

  // Compound messages ("find and fix", "search and update") bypass simple_action
  // and fall through to task detection even if they start with a known simple verb.
  const isCompound = /\b(and (fix|update|modify|change|implement|refactor|repair|resolve|debug|clean|improve|optimize|rewrite|migrate|upgrade|create|add|remove|delete|write))\b/.test(lower);

  // Simple action patterns (fast path for well-known single actions)
  if (!isCompound) {
    for (const pattern of SIMPLE_ACTION_PATTERNS) {
      if (pattern.test(lower)) return "simple_action";
    }
  }

  // Check TASK_PATTERNS score (multi-step or compound indicators)
  const taskScore = countMatches(lower, TASK_PATTERNS);

  if (taskScore >= 1) {
    return "task";
  }

  // Short project message with clear action-verb intent
  // e.g. "Fix the bug", "Fix this", "Check the design", "Find and fix the issue"
  if (PROJECT_ACTION_VERB_PATTERN.test(lower)) {
    return "task";
  }

  // Multi-sentence project messages are likely tasks
  const sentenceCount = (trimmed.match(/[.!?]+/g) ?? []).length;
  if (sentenceCount >= 2 && wordCount >= 6) {
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
 * Enabled by default. Set FORGE_TASKS_ENABLED=0 or FORGE_TASKS_ENABLED=false
 * to explicitly disable for testing/rollback.
 */
export function isTaskRuntimeEnabled(): boolean {
  const v = process.env["FORGE_TASKS_ENABLED"];
  return v !== "0" && v !== "false";
}