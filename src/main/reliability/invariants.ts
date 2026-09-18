/**
 * invariants.ts — Canonical Forge Invariant Registry.
 *
 * Every invariant has: an ID, a human description, a category, and a severity.
 * InvariantMonitor can assert any of these, producing a typed violation record
 * that feeds into the incident pipeline.
 *
 * DESIGN PRINCIPLE (§78):
 *   Forge may automatically: detect, record, classify, replay, test, suggest.
 *   Forge may NOT autonomously: rewrite runtime, merge patches, disable safety checks.
 *   The human approval boundary is enforced by SelfHealingEngine.
 */

import type { IncidentCategory, ForgeSeverity } from "../../shared/types.js";

// ── Invariant definition ─────────────────────────────────────────────────────

export interface InvariantDef {
  id: string;
  description: string;
  category: IncidentCategory;
  severity: ForgeSeverity;
  /**
   * Level of self-healing allowed for this invariant class:
   * 1 = log only
   * 2 = log + user notification
   * 3 = log + bounded automatic retry
   * 4 = log + predefined low-risk recovery action
   */
  maxHealingLevel: 1 | 2 | 3 | 4;
}

export interface InvariantViolation {
  invariantId: string;
  timestamp: number;
  observedState: Record<string, unknown>;
  expectedState?: Record<string, unknown>;
  requestId?: string;
  conversationId?: string;
  contextHint?: string;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, InvariantDef>();

function define(def: InvariantDef): InvariantDef {
  if (REGISTRY.has(def.id)) {
    throw new Error(`Duplicate invariant ID: ${def.id}`);
  }
  REGISTRY.set(def.id, def);
  return def;
}

export function getInvariant(id: string): InvariantDef | undefined {
  return REGISTRY.get(id);
}

export function getAllInvariants(): InvariantDef[] {
  return Array.from(REGISTRY.values());
}

// ── AGENT RUNTIME invariants ──────────────────────────────────────────────────

export const INV_ONE_RUN_ONE_VISIBLE_FAILURE = define({
  id: "ONE_RUN_ONE_VISIBLE_FAILURE",
  description:
    "One AgentRun failure must produce exactly one canonical error ChatMessage. " +
    "Multiple internal error events must not result in multiple visible UI failures.",
  category: "AGENT_RUNTIME",
  severity: "high",
  maxHealingLevel: 2,
});

export const INV_TERMINAL_TURN_ONLY = define({
  id: "TERMINAL_TURN_ONLY",
  description:
    "Only the terminal model turn (containing no tool calls) may become a ChatMessage. " +
    "Intermediate planning/narration turns must never appear in persisted messages.",
  category: "AGENT_RUNTIME",
  severity: "high",
  maxHealingLevel: 1,
});

export const INV_RECOVERY_BOUNDED = define({
  id: "RECOVERY_BOUNDED",
  description:
    "Protocol recovery attempts must not exceed MAX_PROTOCOL_RECOVERY_TURNS. " +
    "Unbounded retries are forbidden — they produce infinite loops.",
  category: "AGENT_RUNTIME",
  severity: "critical",
  maxHealingLevel: 3,
});

export const INV_STATE_TRANSITIONS_VALID = define({
  id: "STATE_TRANSITIONS_VALID",
  description:
    "AgentRun state transitions must follow the declared VALID_TRANSITIONS map. " +
    "Invalid transitions indicate a bug in the runtime state machine.",
  category: "AGENT_RUNTIME",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_TOOL_BUDGET_ENFORCED = define({
  id: "TOOL_BUDGET_ENFORCED",
  description:
    "Tool step count must not exceed MAX_TOOL_STEPS_PER_REQUEST without entering budget finalization. " +
    "Exceeding the budget without finalization would allow infinite autonomous execution.",
  category: "AGENT_RUNTIME",
  severity: "critical",
  maxHealingLevel: 3,
});

export const INV_SIMPLE_FINAL_WITHOUT_TOOLS = define({
  id: "SIMPLE_FINAL_WITHOUT_TOOLS",
  description:
    "A simple conversational request in a Project conversation must be answerable with " +
    "a direct forge_final without requiring tool calls. Protocol recovery must not exhaust " +
    "on trivially answerable questions.",
  category: "PROTOCOL",
  severity: "high",
  maxHealingLevel: 2,
});

// ── CONCURRENCY invariants ────────────────────────────────────────────────────

export const INV_NO_CROSS_RUN_CONTAMINATION = define({
  id: "NO_CROSS_RUN_CONTAMINATION",
  description:
    "Tool events, ledgers, snapshots, and error states must be strictly isolated per AgentRun. " +
    "Concurrent runs in different conversations must not contaminate each other.",
  category: "CONCURRENCY",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_STREAM_ID_FILTER_ENFORCED = define({
  id: "STREAM_ID_FILTER_ENFORCED",
  description:
    "StreamingBubble must only process tool events matching its own streamId. " +
    "Events from concurrent streams must be silently discarded.",
  category: "CONCURRENCY",
  severity: "high",
  maxHealingLevel: 2,
});

// ── NAVIGATION / REMOUNT invariants ──────────────────────────────────────────

export const INV_NAVIGATION_STATE_RESTORED = define({
  id: "NAVIGATION_STATE_RESTORED",
  description:
    "When a user navigates away from an active conversation and returns, " +
    "the live streaming state must be restored from activeRunRegistry without missing events.",
  category: "NAVIGATION",
  severity: "high",
  maxHealingLevel: 3,
});

export const INV_NO_STALE_HYDRATION_OVERWRITE = define({
  id: "NO_STALE_HYDRATION_OVERWRITE",
  description:
    "A hydration response must not overwrite a freshly-received STREAM_START state. " +
    "Revision guards prevent a race where stale hydration arrives after a live event.",
  category: "NAVIGATION",
  severity: "high",
  maxHealingLevel: 1,
});

// ── PERSISTENCE invariants ────────────────────────────────────────────────────

export const INV_1_USER_1_ASSISTANT = define({
  id: "1_USER_1_ASSISTANT",
  description:
    "Each completed request must produce exactly one user message and one assistant message " +
    "in the persisted conversation. Duplicate insertions or missing messages violate this.",
  category: "PERSISTENCE",
  severity: "high",
  maxHealingLevel: 1,
});

export const INV_NO_PROTOCOL_LEAK = define({
  id: "NO_PROTOCOL_LEAK",
  description:
    "forge_tool, forge_final, forge_tool_result, and callId protocol artifacts must never " +
    "appear in persisted ChatMessage content shown to the user.",
  category: "PERSISTENCE",
  severity: "high",
  maxHealingLevel: 2,
});

// ── RESOURCE LIFECYCLE invariants ─────────────────────────────────────────────

export const INV_SNAPSHOT_IMMUTABLE = define({
  id: "SNAPSHOT_IMMUTABLE",
  description:
    "A captured snapshot must be byte-identical to the file at capture time. " +
    "Subsequent writes to the source file must not modify the snapshot.",
  category: "RESOURCE_LIFECYCLE",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_ORPHANED_SNAPSHOTS_CLEANED = define({
  id: "ORPHANED_SNAPSHOTS_CLEANED",
  description:
    "Snapshots not referenced by any ChatMessage contextRef or RequestContextLedger agentReadRef " +
    "must be deleted during garbage collection. Unreferenced snapshots are a resource leak.",
  category: "RESOURCE_LIFECYCLE",
  severity: "medium",
  maxHealingLevel: 4,
});

export const INV_RESOURCE_OWNERSHIP_CLEAN = define({
  id: "RESOURCE_OWNERSHIP_CLEAN",
  description:
    "Every resource (snapshot, proposal target, backup, write journal entry) must have " +
    "exactly one canonical owner. Cross-owner references are forbidden.",
  category: "RESOURCE_LIFECYCLE",
  severity: "high",
  maxHealingLevel: 1,
});

// ── SAFE EDITING invariants ───────────────────────────────────────────────────

export const INV_INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES = define({
  id: "INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES",
  description:
    "A malformed or truncated edit proposal must never write any bytes to the filesystem. " +
    "No partial 'ready' FileEdit must exist for an invalid proposal.",
  category: "SAFE_EDITING",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_STALE_BASE_PROTECTION = define({
  id: "STALE_BASE_PROTECTION",
  description:
    "Preflight must detect any file modification since the immutable base snapshot was captured. " +
    "Stale-base writes must be blocked.",
  category: "SAFE_EDITING",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_APPLY_REQUIRES_APPROVAL = define({
  id: "APPLY_REQUIRES_APPROVAL",
  description:
    "No filesystem write through the edit pipeline may occur without explicit user approval. " +
    "The approval boundary is enforced by preflightFileEdits + user-initiated applySelected.",
  category: "SAFE_EDITING",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_EDIT_AMBIGUITY_BLOCKED = define({
  id: "EDIT_AMBIGUITY_BLOCKED",
  description:
    "ExactTextReplace operations where oldText appears more than expectedOccurrences times " +
    "must be rejected before any write. Ambiguous replacements are forbidden.",
  category: "SAFE_EDITING",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_ROLLBACK_CORRECTNESS = define({
  id: "ROLLBACK_CORRECTNESS",
  description:
    "When multi-file apply fails mid-sequence, all already-written files must be restored " +
    "from their pre-apply backups. Partial write sets are forbidden.",
  category: "SAFE_EDITING",
  severity: "critical",
  maxHealingLevel: 1,
});

// ── PROVIDER / PROTOCOL invariants ────────────────────────────────────────────

export const INV_PROVIDER_DISCONNECT_HANDLED = define({
  id: "PROVIDER_DISCONNECT_HANDLED",
  description:
    "Mid-stream provider disconnection must result in PROVIDER_ERROR with a single user-visible " +
    "error message. It must not leave the run in an undefined state.",
  category: "PROVIDER",
  severity: "high",
  maxHealingLevel: 3,
});

export const INV_NAKED_PROSE_PROJECT_MODE_BLOCKED = define({
  id: "NAKED_PROSE_PROJECT_MODE_BLOCKED",
  description:
    "In project mode, naked prose responses must be classified as invalid and trigger " +
    "bounded protocol recovery (MAX_PROTOCOL_RECOVERY_TURNS).",
  category: "PROTOCOL",
  severity: "high",
  maxHealingLevel: 3,
});

// ── SECURITY invariants ───────────────────────────────────────────────────────

export const INV_NO_SECRET_IN_INCIDENT = define({
  id: "NO_SECRET_IN_INCIDENT",
  description:
    "Incident records must never contain API keys, passwords, or other credentials. " +
    "Sanitization must run before incident persistence.",
  category: "SECURITY_INVARIANT",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_NO_ABSOLUTE_PATH_IN_REPORT = define({
  id: "NO_ABSOLUTE_PATH_IN_REPORT",
  description:
    "Sanitized incident reports shared externally must contain no absolute filesystem paths " +
    "that could identify the user's system or project location.",
  category: "SECURITY_INVARIANT",
  severity: "high",
  maxHealingLevel: 1,
});

export const INV_NO_PROMPT_IN_REPORT = define({
  id: "NO_PROMPT_IN_REPORT",
  description:
    "Sanitized incident reports must not include raw user prompts or file contents " +
    "unless the user explicitly consents.",
  category: "SECURITY_INVARIANT",
  severity: "high",
  maxHealingLevel: 1,
});

export const INV_NO_AUTO_CRITICAL_SELF_MODIFICATION = define({
  id: "NO_AUTO_CRITICAL_SELF_MODIFICATION",
  description:
    "Forge must never autonomously rewrite its own runtime code, security checks, " +
    "or merge/apply external patches without human approval. " +
    "Self-improvement is limited to predefined low-risk recovery actions.",
  category: "SECURITY_INVARIANT",
  severity: "critical",
  maxHealingLevel: 1,
});

// ── IPC ROUTING invariants ────────────────────────────────────────────────────

export const INV_STREAM_EVENT_ROUTING = define({
  id: "STREAM_EVENT_ROUTING",
  description:
    "All IPC stream events (CHAT_STREAM_*) must carry a streamId and be routable " +
    "to exactly one conversation. Unroutable events must be discarded, not broadcast.",
  category: "IPC_ROUTING",
  severity: "high",
  maxHealingLevel: 2,
});


// -- COMMAND EXECUTION invariants ─────────────────────────────────────────────

export const INV_COMMAND_CWD_WITHIN_PROJECT = define({
  id: "COMMAND_CWD_WITHIN_PROJECT",
  description:
    "Every spawned command must have its resolved cwd strictly within the project " +
    "working directory. Commands with cwd outside the project tree must never spawn.",
  category: "COMMAND_EXECUTION",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_COMMAND_REQUIRES_AUTHORIZATION = define({
  id: "COMMAND_REQUIRES_AUTHORIZATION",
  description:
    "A command must not transition from 'queued' to 'running' unless its " +
    "authorizationState is 'approved'. Agent-blocked and user-rejected commands " +
    "must never execute.",
  category: "COMMAND_EXECUTION",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_COMMAND_START_ONCE = define({
  id: "COMMAND_START_ONCE",
  description:
    "A command must start exactly once. A command that is already running or " +
    "has reached a terminal state must never be re-spawned.",
  category: "AGENT_RUNTIME",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_COMMAND_IDENTITY_IMMUTABLE = define({
  id: "COMMAND_IDENTITY_IMMUTABLE",
  description:
    "A command's executable, args, and cwdRelative are immutable after creation. " +
    "No approval or trust rule may alter what the command actually runs.",
  category: "COMMAND_EXECUTION",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_COMMAND_RESULT_OWNERSHIP = define({
  id: "COMMAND_RESULT_OWNERSHIP",
  description:
    "Command output and execution results belong to the project that spawned the " +
    "command. Cross-project result contamination is forbidden.",
  category: "COMMAND_EXECUTION",
  severity: "high",
  maxHealingLevel: 2,
});

export const INV_COMMAND_CANCEL_IS_TERMINAL = define({
  id: "COMMAND_CANCEL_IS_TERMINAL",
  description:
    "Once a command reaches a terminal state (succeeded, failed, timed_out, " +
    "cancelled, blocked), it must never transition to any other state.",
  category: "AGENT_RUNTIME",
  severity: "high",
  maxHealingLevel: 2,
});

export const INV_COMMAND_OUTPUT_BOUNDED = define({
  id: "COMMAND_OUTPUT_BOUNDED",
  description:
    "Total command output captured must never exceed MAX_OUTPUT_BYTES. " +
    "Output overflow must be truncated, never cause memory exhaustion.",
  category: "COMMAND_EXECUTION",
  severity: "high",
  maxHealingLevel: 2,
});

export const INV_COMMAND_MODEL_OUTPUT_SANITIZED = define({
  id: "COMMAND_MODEL_OUTPUT_SANITIZED",
  description:
    "Command output sent to the AI model must be sanitized: secrets redacted, " +
    "ANSI codes stripped, and bounded to MAX_MODEL_OUTPUT_BYTES.",
  category: "SECURITY_INVARIANT",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_COMMAND_TRUST_STILL_VALID = define({
  id: "COMMAND_TRUST_STILL_VALID",
  description:
    "A trust rule applied at spawn time must still match the current command spec. " +
    "A changed script body must not inherit a trust rule for the old body.",
  category: "COMMAND_EXECUTION",
  severity: "high",
  maxHealingLevel: 2,
});

export const INV_COMMAND_AGENT_NO_SHELL = define({
  id: "COMMAND_AGENT_NO_SHELL",
  description:
    "Commands proposed or approved via run_command must never use shell:true, " +
    "shell composition operators (|, &, ;, &&, ||), or shell interpolation. " +
    "Every executable token must be a safe literal.",
  category: "COMMAND_EXECUTION",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_COMMAND_AGENT_NO_SOURCE_WRITE_BYPASS = define({
  id: "COMMAND_AGENT_NO_SOURCE_WRITE_BYPASS",
  description:
    "Agent-proposed commands must not use source-write-bypass executables " +
    "(sed -i, awk -i, perl -i). All source mutations require the diff-review pipeline.",
  category: "COMMAND_EXECUTION",
  severity: "critical",
  maxHealingLevel: 1,
});

export const INV_COMMAND_PROCESS_RELEASED = define({
  id: "COMMAND_PROCESS_RELEASED",
  description:
    "After a command reaches a terminal state, its child process resources " +
    "(file descriptors, stdio streams, AbortController) must be released. " +
    "Process handles must not leak across commands.",
  category: "COMMAND_EXECUTION",
  severity: "high",
  maxHealingLevel: 2,
});

export const INV_COMMAND_NO_PROVIDER_SECRET_ENV = define({
  id: "COMMAND_NO_PROVIDER_SECRET_ENV",
  description:
    "Provider API keys and secrets from the secret store must never appear in " +
    "the environment of a spawned command process. Command envs are sanitized " +
    "before spawn and must not inherit forge process credentials.",
  category: "SECURITY_INVARIANT",
  severity: "critical",
  maxHealingLevel: 1,
});


// ── Browser Runtime V1 invariants ────────────────────────────────────────────

define({
  id: 'BROWSER_SESSION_LIMIT',
  description: 'The number of open browser sessions must not exceed the configured maximum.',
  category: 'BROWSER_RUNTIME',
  severity: 'high',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_TAB_BELONGS_TO_SESSION',
  description: 'Every browser tab must be owned by exactly one active session.',
  category: 'BROWSER_RUNTIME',
  severity: 'high',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_AGENT_BUDGET_ENFORCED',
  description: 'Agent browser actions per request must not exceed the per-request budget.',
  category: 'BROWSER_RUNTIME',
  severity: 'critical',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_NAVIGATION_BUDGET_ENFORCED',
  description: 'Agent navigations per request must not exceed the navigation budget.',
  category: 'BROWSER_RUNTIME',
  severity: 'high',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_SCREENSHOT_BUDGET_ENFORCED',
  description: 'Agent screenshots per request must not exceed the screenshot budget.',
  category: 'BROWSER_RUNTIME',
  severity: 'medium',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_ELEMENT_REF_VALID',
  description: 'Browser element refs used by the agent must belong to the current navigation generation.',
  category: 'BROWSER_RUNTIME',
  severity: 'medium',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_APPROVAL_REQUIRED',
  description: 'High-risk browser actions must not execute without explicit user approval.',
  category: 'BROWSER_RUNTIME',
  severity: 'critical',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_EXTERNAL_PROTOCOL_BLOCKED',
  description: 'Non-HTTP(S) protocol navigations must always be blocked by policy.',
  category: 'BROWSER_RUNTIME',
  severity: 'critical',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_POLICY_EVALUATED',
  description: 'Every agent browser action must pass through the policy evaluator before execution.',
  category: 'BROWSER_RUNTIME',
  severity: 'critical',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_SESSION_ISOLATED',
  description: 'Browser sessions must use distinct Chromium partitions and must not share web storage.',
  category: 'BROWSER_RUNTIME',
  severity: 'high',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_PRIVATE_SESSION_CLEARED',
  description: 'Private browser sessions must have their storage cleared on close and on restart.',
  category: 'BROWSER_RUNTIME',
  severity: 'high',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_AGENT_CONTROL_EXCLUSIVE',
  description: 'Agent browser control must be held by at most one active request per session.',
  category: 'BROWSER_RUNTIME',
  severity: 'critical',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_READ_BUDGET_ENFORCED',
  description: 'Bytes read from browser pages per request must not exceed the read budget.',
  category: 'BROWSER_RUNTIME',
  severity: 'medium',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_TRACE_EMITTED',
  description: 'All significant browser agent actions must emit a trace event for auditability.',
  category: 'BROWSER_RUNTIME',
  severity: 'low',
  maxHealingLevel: 2,
});

define({
  id: 'BROWSER_VIEW_BOUNDS_VALID',
  description: 'The WebContentsView bounds must be non-negative and within the window frame.',
  category: 'BROWSER_RUNTIME',
  severity: 'medium',
  maxHealingLevel: 1,
});

define({
  id: 'BROWSER_NO_FORGE_PRELOAD',
  description: 'WebContentsView instances must never load the Forge preload script into web content.',
  category: 'BROWSER_RUNTIME',
  severity: 'critical',
  maxHealingLevel: 1,
});

// ── InvariantMonitor ──────────────────────────────────────────────────────────

/** Called when a violation is detected — plug in to the incident pipeline */
export type ViolationHandler = (violation: InvariantViolation) => void;

let _violationHandler: ViolationHandler | null = null;
const _pendingViolations: InvariantViolation[] = [];

/**
 * Register the violation handler. Called once during startup by ReliabilityEngine.
 * Pending violations captured before registration are flushed immediately.
 */
export function registerViolationHandler(handler: ViolationHandler): void {
  _violationHandler = handler;
  for (const v of _pendingViolations) {
    handler(v);
  }
  _pendingViolations.length = 0;
}

/**
 * Assert an invariant. If the condition is false, record a violation.
 * Non-throwing by design — invariant violations are observed and handled
 * by the incident pipeline, never by crashing production code.
 *
 * @param invariantId — must be a registered invariant ID
 * @param condition   — the asserted condition; false = violation
 * @param observed    — current state snapshot (sanitized before storage)
 * @param context     — optional { requestId, conversationId, hint }
 */
export function assertInvariant(
  invariantId: string,
  condition: boolean,
  observed: Record<string, unknown>,
  context?: { requestId?: string; conversationId?: string; hint?: string },
): boolean {
  if (condition) return true;

  const def = REGISTRY.get(invariantId);
  if (!def) {
    // Unknown invariant ID — still record, using a fallback
    console.error(`[Forge/Invariant] Unknown invariant ID: ${invariantId}`);
  }

  const violation: InvariantViolation = {
    invariantId,
    timestamp: Date.now(),
    observedState: { ...observed },
    ...(context?.requestId !== undefined && { requestId: context.requestId }),
    ...(context?.conversationId !== undefined && { conversationId: context.conversationId }),
    ...(context?.hint !== undefined && { contextHint: context.hint }),
  };

  if (_violationHandler) {
    try {
      _violationHandler(violation);
    } catch {
      // Never throw from assert
    }
  } else {
    _pendingViolations.push(violation);
  }

  // In test environments, also warn to console for immediate visibility
  if (process.env.NODE_ENV !== "production") {
    const label = def?.description ?? invariantId;
    console.warn(`[Forge/Invariant VIOLATED] ${invariantId}: ${label}`, observed);
  }

  return false;
}

/**
 * Strict variant for use in tests — throws if violated.
 * Never use in production paths.
 */
export function assertInvariantStrict(
  invariantId: string,
  condition: boolean,
  observed: Record<string, unknown>,
): void {
  if (!condition) {
    const def = REGISTRY.get(invariantId);
    throw new Error(
      `Invariant violated: ${invariantId} — ${def?.description ?? "(unknown)"}\n` +
        `Observed: ${JSON.stringify(observed)}`,
    );
  }
}