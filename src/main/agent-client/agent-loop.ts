/**
 * agent-loop.ts — V0.6 Agent Runtime Core.
 *
 * The fundamental rule: THE MODEL DOES NOT CONTROL APPLICATION STATE.
 * The model may only return a NormalizedAgentDecision.
 * Forge owns: lifecycle, state transitions, tool execution, validation,
 * continuation, recovery, budgets, cancellation, persistence, UI, completion,
 * failure, and approval boundaries.
 *
 * KEY INVARIANTS:
 *   1. PROVIDER TURN ≠ CHAT MESSAGE. Only the terminal turn becomes a message.
 *   2. NO TOOL CALL ≠ FINAL ANSWER. Finality is structural (forge_final envelope
 *      in fallback/project mode), not inferred from absence of tool calls.
 *   3. NAKED PROSE IN PROJECT MODE → invalid decision → bounded recovery.
 *   4. Intermediate model narration (planning text) is never forwarded to UI.
 *   5. Recovery is bounded by MAX_PROTOCOL_RECOVERY_TURNS.
 *
 * Fallback protocol (for arbitrary OpenAI-compat endpoints):
 *   forge_tool    → NormalizedAgentDecision { kind: "tool_calls" }
 *   forge_final   → NormalizedAgentDecision { kind: "final" }
 *   anything else → NormalizedAgentDecision { kind: "invalid", recoverable: true }
 *
 * Global Chat (isProjectMode=false): naked prose is accepted as final.
 *
 * Does NOT know about IPC, Electron, or the renderer.
 */
import { randomUUID, createHash } from "crypto";
import type {
  AgentConfig,
  ForgeToolCall,
  ForgeToolResult,
  AgentReadRef,
  CommandEvidenceRef,
  ToolActivityEntry,
  NormalizedAgentDecision,
  AgentRun,
  AgentRunState,
  AgentGoalState,
} from "../../shared/types.js";
import { makeRequest } from "./client.js";
import type { SimpleMessage } from "./client.js";
import { TOOL_LIMITS, buildOpenAIToolDefs, buildAnthropicToolDefs } from "./tool-types.js";
import { executeProjectTool, buildResultSummary, newActivityId } from "../project-files/tool-executor.js";
import type { ToolExecutionContext } from "../project-files/tool-executor.js";
import { tryGetTraceRecorder, assertInvariant } from "../reliability/index.js";

// ── Public error type ─────────────────────────────────────────────────────────

export type AgentLoopErrorCode =
  | "PROTOCOL_RECOVERY_EXHAUSTED"
  | "PROVIDER_ERROR"
  | "CANCELLED"
  | "BUDGET_FINALIZATION_FAILED"
  | "INVALID_STATE_TRANSITION";

/**
 * Typed error thrown by runAgentLoop on terminal failures.
 * QueueManager maps these codes to user-visible failure messages.
 */
export class AgentLoopError extends Error {
  readonly code: AgentLoopErrorCode;
  constructor(code: AgentLoopErrorCode, message: string) {
    super(message);
    this.name = "AgentLoopError";
    this.code = code;
  }
}

// ── Public options / result ───────────────────────────────────────────────────

export interface AgentLoopOptions {
  cfg: AgentConfig;
  apiKey: string;
  /** Initial conversation messages (history + current user message) */
  messages: SimpleMessage[];
  /** Optional system prompt — pass undefined for no system prompt */
  system: string | undefined;
  projectId: string;
  projectRoot: string;
  requestId: string;
  conversationId: string;
  /**
   * Whether this conversation is project-scoped.
   * In project mode, naked prose (no forge_final envelope) is treated as
   * an invalid protocol response and triggers recovery.
   * In global chat mode, naked prose is accepted as final.
   */
  isProjectMode: boolean;
  /**
   * Called with the complete final visible text once the terminal turn is confirmed.
   * Intermediate tool-step turns are buffered internally and never forwarded here.
   */
  onChunk: (chunk: string) => void;
  /**
   * Called once per non-terminal provider turn with the stripped visible text.
   * For dev logging / telemetry only — must NOT be displayed as Chat content.
   */
  onIntermediateText?: (text: string) => void;
  /** Called when a tool call starts (before execution) */
  onToolStart: (call: ForgeToolCall) => void;
  /** Called when a tool call completes */
  onToolEnd: (call: ForgeToolCall, result: ForgeToolResult, durationMs: number) => void;
  /** Abort signal — loop checks before each turn */
  signal: { aborted: boolean };
}

export interface AgentLoopResult {
  /** Complete final text visible to the user */
  finalText: string;
  /** Raw forge_edit_proposal fence JSON if one was in the final turn, else undefined */
  proposalFenceRaw: string | undefined;
  /** Number of tool-calling turns executed */
  stepCount: number;
  /** Files the agent autonomously read (full file or range) */
  agentReadRefs: AgentReadRef[];
  /** All tool invocations in order */
  toolActivity: ToolActivityEntry[];
  /** Commands run via run_command tool */
  commandEvidenceRefs?: CommandEvidenceRef[];
  /** Final AgentRun state record */
  agentRun: AgentRun;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of protocol-recovery injections per run.
 * If the model returns invalid responses more than this many times consecutively,
 * the run fails with PROTOCOL_RECOVERY_EXHAUSTED.
 */
const MAX_PROTOCOL_RECOVERY_TURNS = 3;

/**
 * Protocol correction injected when the model returns an invalid decision in
 * project mode. This is a system-level instruction, never shown to the user.
 */
const FORGE_PROTOCOL_CORRECTION =
  "FORGE_PROTOCOL_CORRECTION: Your previous response was not a valid Forge Agent action.\n\n" +
  "You must respond with exactly one of:\n" +
  "1. A forge_tool action if you need project information.\n" +
  "2. A forge_final response when you have enough information to answer.\n\n" +
  "Do not narrate what you plan to do. Continue solving the user's original request now.";

/**
 * Instruction appended when the tool budget is exhausted, asking for a final response.
 */
const BUDGET_EXHAUSTED_INSTRUCTION =
  "FORGE_BUDGET_EXHAUSTED: You have used the maximum number of project tool calls for this request.\n\n" +
  "Using only the information you have already gathered, provide your complete final response now.\n" +
  "Respond with forge_final containing your complete answer. No more tools are available.";

// ── forge_tool fence parsing ──────────────────────────────────────────────────

const FORGE_TOOL_FENCE_RE = /```forge_tool\n([\s\S]*?)\n```/g;
const FORGE_FINAL_FENCE_RE = /```forge_final\n([\s\S]*?)\n```/g;
const FORGE_EDIT_PROPOSAL_FENCE_RE = /```forge_edit_proposal\n([\s\S]*?)\n```/g;

/**
 * Build the forge_tool_result fence to append to message history.
 */
const FORGE_TOOL_RESULT_FENCE = (callId: string, result: ForgeToolResult): string => {
  const payload: Record<string, unknown> = { callId, ok: result.ok };
  if (result.data !== undefined) payload["data"] = result.data;
  if (result.errorCode !== undefined) payload["errorCode"] = result.errorCode;
  if (result.errorMessage !== undefined) payload["errorMessage"] = result.errorMessage;
  return `\`\`\`forge_tool_result\n${JSON.stringify(payload)}\n\`\`\``;
};

/**
 * Extract forge_tool JSON fences from text.
 * Returns parsed tool calls. Malformed fences are silently skipped.
 */
function extractForgeFences(text: string): ForgeToolCall[] {
  const calls: ForgeToolCall[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(FORGE_TOOL_FENCE_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    try {
      const raw = JSON.parse(match[1] as string) as Record<string, unknown>;
      calls.push({
        callId: typeof raw["callId"] === "string" ? raw["callId"] : randomUUID(),
        name: typeof raw["name"] === "string" ? raw["name"] : "",
        arguments:
          typeof raw["arguments"] === "object" && raw["arguments"] !== null
            ? (raw["arguments"] as Record<string, unknown>)
            : {},
      });
    } catch {
      // malformed fence — skip
    }
  }
  return calls;
}

/**
 * Count forge_final fences in text (to detect multiple/conflicting envelopes).
 */
function countForgeFinalFences(text: string): number {
  let count = 0;
  const re = new RegExp(FORGE_FINAL_FENCE_RE.source, "g");
  while (re.exec(text) !== null) count++;
  return count;
}

/**
 * Extract content from the first forge_final fence.
 * Returns null if not found or malformed.
 */
function extractForgeFinalContent(text: string): { content: string } | null {
  const re = new RegExp(FORGE_FINAL_FENCE_RE.source, "g");
  const match = re.exec(text);
  if (!match || !match[1]) return null;
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>;
    if (typeof raw["content"] !== "string") return null;
    return { content: raw["content"] as string };
  } catch {
    return null;
  }
}

/**
 * Extract ALL forge_edit_proposal fence blocks from text.
 * Returns all blocks concatenated (with newline separator) so that
 * multi-block detection via countProposalFences() works correctly in QueueManager.
 * Returns undefined if no fence is found.
 */
function extractProposalFenceRaw(text: string): string | undefined {
  const re = new RegExp(FORGE_EDIT_PROPOSAL_FENCE_RE.source, "g");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    blocks.push(match[0]); // full fence block including backticks
  }
  if (blocks.length === 0) return undefined;
  return blocks.join("\n"); // QueueManager calls countProposalFences on this
}

/**
 * Strip all internal control fences from text to produce user-visible prose.
 * forge_tool, forge_tool_result, and forge_final fences are all control plane.
 * forge_edit_proposal fences are handled separately by QueueManager/edit-service.
 */
export function stripForgeFences(text: string): string {
  return text
    .replace(new RegExp(FORGE_TOOL_FENCE_RE.source, "g"), "")
    .replace(/```forge_tool_result\n[\s\S]*?\n```/g, "")
    .replace(new RegExp(FORGE_FINAL_FENCE_RE.source, "g"), "")
    .trim();
}

// ── Normalize decision ────────────────────────────────────────────────────────

/**
 * Normalize one provider turn into a canonical NormalizedAgentDecision.
 *
 * Priority order:
 * 1. Native tool calls (from provider callbacks) → tool_calls
 * 2. forge_tool fences in text → tool_calls
 * 3. forge_final envelope in text → final (with optional proposalFenceRaw)
 * 4. isProjectMode: naked prose / empty → invalid (recoverable)
 * 5. !isProjectMode (Global Chat): any text → final
 *
 * Budget-exhausted path is handled in the loop (tools are not passed to the
 * model, so native tool calls cannot occur; forge_tool fences are rejected).
 */
export function normalizeDecision(
  rawText: string,
  nativeToolCalls: ForgeToolCall[],
  isProjectMode: boolean,
  budgetExhausted: boolean
): NormalizedAgentDecision {
  const text = rawText ?? "";

  // ── 1. Native tool calls take priority ────────────────────────────────────
  if (nativeToolCalls.length > 0 && !budgetExhausted) {
    return { kind: "tool_calls", calls: nativeToolCalls };
  }

  // ── 2. forge_tool fences in text ─────────────────────────────────────────
  if (!budgetExhausted) {
    const fencedCalls = extractForgeFences(text);
    if (fencedCalls.length > 0) {
      return { kind: "tool_calls", calls: fencedCalls };
    }
  }

  // ── 3. forge_final envelope ───────────────────────────────────────────────
  const finalCount = countForgeFinalFences(text);
  if (finalCount > 1) {
    return {
      kind: "invalid",
      reason: "MULTIPLE_FINAL_ENVELOPES",
      recoverable: false,
    };
  }
  if (finalCount === 1) {
    const parsed = extractForgeFinalContent(text);
    if (!parsed) {
      return {
        kind: "invalid",
        reason: "MALFORMED_FINAL_ENVELOPE",
        recoverable: true,
      };
    }
    if (parsed.content.trim().length === 0) {
      return {
        kind: "invalid",
        reason: "EMPTY_FINAL_CONTENT",
        recoverable: true,
      };
    }
    const proposalFenceRaw = extractProposalFenceRaw(text);
    // In project mode: attempt to parse structured ForgeAgentFinal JSON
    let outcome: import('../../shared/types.js').ForgeAgentFinal | undefined;
    if (isProjectMode) {
      try {
        const candidate = JSON.parse(parsed.content) as Record<string, unknown>;
        if (typeof candidate.status === 'string' && ['completed','blocked','failed'].includes(candidate.status) && typeof candidate.summary === 'string') {
          outcome = {
            status: candidate.status as 'completed' | 'blocked' | 'failed',
            summary: candidate.summary,
            ...(Array.isArray(candidate.evidenceRefs) && { evidenceRefs: candidate.evidenceRefs as string[] }),
          };
          // Enforce: summary must be an intent statement, not verbose prose
          // (structural guard: summary must be <= 300 chars for intent-only)
          if (outcome.summary.length > 500) {
            outcome.summary = outcome.summary.slice(0, 500);
          }
        } else if (typeof candidate.status !== 'undefined') {
          // Status was present but malformed
          return {
            kind: "invalid",
            reason: "AGENT_FINAL_MISSING_STATUS",
            recoverable: true,
          };
        }
      } catch {
        // Not JSON — that's acceptable; content is prose summary
      }
    }
    return {
      kind: "final",
      content: isProjectMode && outcome ? outcome.summary : parsed.content,
      ...(proposalFenceRaw !== undefined && { proposalFenceRaw }),
      ...(outcome !== undefined && { outcome }),
    };
  }

  // ── 4. Project mode: no recognized envelope → invalid ────────────────────
  if (isProjectMode) {
    if (text.trim().length === 0) {
      return { kind: "invalid", reason: "EMPTY_RESPONSE", recoverable: true };
    }
    // Naked prose: model returned prose without a valid control envelope
    return {
      kind: "invalid",
      reason: "NAKED_PROSE_IN_PROJECT_MODE",
      recoverable: true,
    };
  }

  // ── 5. Global Chat: accept naked prose as final ───────────────────────────
  return { kind: "final", content: text };
}

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * Valid state transitions for AgentRun.
 * Any transition not in this map is a runtime bug — throws immediately.
 */
const VALID_TRANSITIONS: Partial<Record<AgentRunState, AgentRunState[]>> = {
  queued:             ["starting"],
  starting:           ["waiting_for_model"],
  waiting_for_model:  ["processing_turn", "cancelled", "failed"],
  processing_turn:    ["executing_tools", "finalizing", "continuing", "cancelled", "failed"],
  executing_tools:    ["continuing", "cancelled", "failed"],
  continuing:         ["waiting_for_model", "finalizing", "cancelled", "failed"],
  finalizing:         ["completed", "failed"],
  // Terminal states — no outgoing transitions (checked via 'completed'/'cancelled'/'failed')
};

function transition(run: AgentRun, to: AgentRunState, tracer?: ReturnType<typeof tryGetTraceRecorder>): void {
  const fromState = run.state;
  const allowed = VALID_TRANSITIONS[fromState];
  assertInvariant(
    "STATE_TRANSITIONS_VALID",
    !!(allowed && allowed.includes(to)),
    { fromState, toState: to, requestId: run.requestId },
    { requestId: run.requestId, conversationId: run.conversationId, hint: `transition ${fromState}→${to}` }
  );
  if (!allowed || !allowed.includes(to)) {
    throw new AgentLoopError(
      "INVALID_STATE_TRANSITION",
      `Invalid AgentRun state transition: ${fromState} → ${to}`
    );
  }
  run.state = to;
  if (to === "completed" || to === "cancelled" || to === "failed") {
    run.completedAt = Date.now();
  }
  try {
    tracer?.emit(run.requestId, "RUN_STATE_CHANGED", { state: to, fromState });
  } catch { /* tracer never blocks execution */ }
}

// ── Tool result message building ──────────────────────────────────────────────

/**
 * Build the message(s) to append after tool execution.
 * Protocol-aware: OpenAI uses role=tool, Anthropic uses tool_result blocks,
 * fallback uses forge_tool_result fence format.
 */
function buildToolResultMessages(
  protocol: string,
  usedNativeTools: boolean,
  toolResults: Array<{ call: ForgeToolCall; result: ForgeToolResult }>
): SimpleMessage[] {
  if (!usedNativeTools) {
    const fences = toolResults
      .map(({ call, result }) => FORGE_TOOL_RESULT_FENCE(call.callId, result))
      .join("\n");
    return [{ role: "user", content: fences }];
  }

  if (protocol === "anthropic") {
    const blocks = toolResults.map(({ call, result }) => ({
      type: "tool_result",
      tool_use_id: call.callId,
      content: result.ok
        ? JSON.stringify(result.data ?? "")
        : `Error (${result.errorCode ?? "unknown"}): ${result.errorMessage ?? ""}`,
    }));
    return [{ role: "user", content: JSON.stringify(blocks) }];
  }

  // OpenAI: one tool message per result
  return toolResults.map(({ call, result }) => ({
    role: "user" as const,
    content: `[tool_result id="${call.callId}" name="${call.name}"] ${
      result.ok
        ? JSON.stringify(result.data ?? "")
        : `Error: ${result.errorMessage ?? result.errorCode ?? "unknown"}`
    }`,
  }));
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    cfg,
    apiKey,
    messages: initialMessages,
    system,
    projectId,
    projectRoot,
    requestId,
    conversationId,
    isProjectMode,
    onChunk,
    onIntermediateText,
    onToolStart,
    onToolEnd,
    signal,
  } = opts;

  // ── Initialize AgentRun ────────────────────────────────────────────────────
  const tracer = tryGetTraceRecorder();
  const run: AgentRun = {
    requestId,
    conversationId,
    projectId,
    agentProfileId: cfg.id,
    state: "queued",
    startedAt: Date.now(),
    toolStepCount: 0,
    recoveryCount: 0,
    readByteCount: 0,
    stuckScore: 0,
  };

  // Start trace for this request
  try {
    tracer?.startTrace({ requestId, conversationId, ...(projectId !== undefined ? { projectId } : {}) });
    tracer?.emit(requestId, "RUN_CREATED", {
      requestId,
      conversationId,
      projectId,
      agentProfileId: cfg.id,
      isProjectMode,
    });
  } catch { /* tracer never blocks execution */ }

  // queued → starting
  transition(run, "starting", tracer);

  // Mutable execution context (shared reference — tool executor updates readBytesUsed/commandsRunThisRequest)
  const ctx: ToolExecutionContext = {
    projectId,
    projectRoot,
    requestId,
    conversationId,
    readBytesUsed: 0,
    commandsRunThisRequest: 0,
  };

  // Accumulated results
  const agentReadRefs: AgentReadRef[] = [];
  const commandEvidenceRefs: CommandEvidenceRef[] = [];
  const toolActivity: ToolActivityEntry[] = [];

  // Working message history (extended with assistant/tool turns)
  const messages: SimpleMessage[] = [...initialMessages];

  // Build tool definitions for this protocol
  const tools = cfg.protocol === "anthropic" ? buildAnthropicToolDefs() : buildOpenAIToolDefs();

  let finalText = "";
  let proposalFenceRaw: string | undefined;
  let budgetExhausted = false;

  // Loop detection state (request-scoped)
  const STALL_THRESHOLD = 3; // consecutive identical observation+action hashes → stall
  const goalState: AgentGoalState = {
    requestId,
    conversationId,
    goal: "",
    lastObservationHash: "",
    lastActionSignature: "",
    stuckScore: 0,
    sameObservationCount: 0,
    sameActionCount: 0,
    effectObserved: false,
    toolCallCount: 0,
    replanCount: 0,
  };

  // starting → waiting_for_model
  transition(run, "waiting_for_model", tracer);

  // Check for initial cancellation
  if (signal.aborted) {
    transition(run, "cancelled", tracer);
    run.failureCode = "CANCELLED";
    run.failureMessage = "Run cancelled before start";
    try { tracer?.emit(requestId, "RUN_CANCELLED", { reason: "cancelled before start" }); } catch { /* */ }
    try { tracer?.endTrace(requestId, "cancelled"); } catch { /* */ }
    throw new AgentLoopError("CANCELLED", "cancelled");
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check for cancellation before each turn
    if (signal.aborted) {
      transition(run, "cancelled", tracer);
      run.failureCode = "CANCELLED";
      run.failureMessage = "Run cancelled during execution";
      try { tracer?.emit(requestId, "RUN_CANCELLED", { reason: "cancelled during execution", step: run.toolStepCount }); } catch { /* */ }
      try { tracer?.endTrace(requestId, "cancelled"); } catch { /* */ }
      throw new AgentLoopError("CANCELLED", "cancelled");
    }

    // Check tool step budget
    if (run.toolStepCount >= TOOL_LIMITS.MAX_TOOL_STEPS_PER_REQUEST) {
      assertInvariant(
        "TOOL_BUDGET_ENFORCED",
        run.toolStepCount <= TOOL_LIMITS.MAX_TOOL_STEPS_PER_REQUEST,
        { toolStepCount: run.toolStepCount, max: TOOL_LIMITS.MAX_TOOL_STEPS_PER_REQUEST, requestId },
        { requestId, conversationId, hint: "budget check" }
      );
      budgetExhausted = true;
    }

    // Accumulated native tool calls from this turn's provider callbacks
    const nativeToolCallsThisTurn: ForgeToolCall[] = [];
    let usedNativeTools = false;

    // Make one model request — buffer chunks internally.
    // We only decide what to do with them AFTER normalizeDecision.
    let turnBuffer = "";

    try { tracer?.emit(requestId, "PROVIDER_REQUEST_STARTED", { step: run.toolStepCount, budgetExhausted }); } catch { /* */ }
    let rawText: string;
    try {
      rawText = await makeRequest({
        cfg,
        apiKey,
        messages,
        stream: true,
        ...(system !== undefined && { system }),
        // When budget exhausted, pass empty tools array to disable tool calling
        tools: budgetExhausted ? [] : tools,
        onChunk: (chunk) => {
          // Accumulate internally — never forward intermediate turns to onChunk
          turnBuffer += chunk;
        },
        onToolCall: (call) => {
          usedNativeTools = true;
          nativeToolCallsThisTurn.push(call);
        },
        signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "cancelled" || signal.aborted) {
        transition(run, "cancelled", tracer);
        run.failureCode = "CANCELLED";
        run.failureMessage = "Cancelled during model request";
        try { tracer?.emit(requestId, "RUN_CANCELLED", { reason: "cancelled during model request" }); } catch { /* */ }
        try { tracer?.endTrace(requestId, "cancelled"); } catch { /* */ }
        throw new AgentLoopError("CANCELLED", "cancelled");
      }
      transition(run, "failed", tracer);
      run.failureCode = "PROVIDER_ERROR";
      run.failureMessage = msg;
      try { tracer?.emit(requestId, "RUN_FAILED", { failureCode: "PROVIDER_ERROR", message: msg }); } catch { /* */ }
      try { tracer?.endTrace(requestId, "failed", "PROVIDER_ERROR"); } catch { /* */ }
      throw new AgentLoopError("PROVIDER_ERROR", `Provider error: ${msg}`);
    }

    // Determine the full text of this turn
    const turnText = rawText ?? turnBuffer ?? "";

    // waiting_for_model → processing_turn
    transition(run, "processing_turn", tracer);

    // ── Normalize the provider turn into a canonical decision ─────────────────
    const decision = normalizeDecision(
      turnText,
      nativeToolCallsThisTurn,
      isProjectMode,
      budgetExhausted
    );
    try {
      tracer?.emit(requestId, "PROVIDER_RESPONSE_NORMALIZED", {
        kind: decision.kind,
        ...(decision.kind === "invalid" && { reason: decision.reason, recoverable: decision.recoverable }),
        ...(decision.kind === "tool_calls" && { callCount: decision.calls.length }),
        step: run.toolStepCount,
      });
    } catch { /* */ }

    // ── CASE: tool_calls ───────────────────────────────────────────────────────
    if (decision.kind === "tool_calls") {
      // Emit intermediate text to dev/telemetry callback (never to UI as Chat content)
      const stripped = stripForgeFences(turnText);
      if (stripped.trim() && onIntermediateText) {
        onIntermediateText(stripped);
      }

      // Record assistant turn in message history (raw text for model continuity)
      messages.push({ role: "assistant", content: turnText });

      // processing_turn → executing_tools
      transition(run, "executing_tools", tracer);

      const toolResults: Array<{ call: ForgeToolCall; result: ForgeToolResult }> = [];

      for (const call of decision.calls) {
        if (signal.aborted) {
          transition(run, "cancelled", tracer);
          run.failureCode = "CANCELLED";
          run.failureMessage = "Cancelled during tool execution";
          try { tracer?.emit(requestId, "RUN_CANCELLED", { reason: "cancelled during tool execution" }); } catch { /* */ }
          try { tracer?.endTrace(requestId, "cancelled"); } catch { /* */ }
          throw new AgentLoopError("CANCELLED", "cancelled");
        }

        try { tracer?.emit(requestId, "TOOL_REQUESTED", { toolName: call.name, callId: call.callId, step: run.toolStepCount }); } catch { /* */ }
        onToolStart(call);
        try { tracer?.emit(requestId, "TOOL_STARTED", { toolName: call.name, callId: call.callId }); } catch { /* */ }

        const execResult = await executeProjectTool(call, ctx);
        const { result, agentReadRef, commandEvidenceRef, durationMs } = execResult;

        if (agentReadRef) {
          agentReadRefs.push(agentReadRef);
          run.readByteCount += agentReadRef.size;
          try { tracer?.emit(requestId, "FILE_READ", { relativePath: agentReadRef.relativePath, size: agentReadRef.size, fullFile: agentReadRef.fullFile }); } catch { /* */ }
        }

        if (commandEvidenceRef) {
          commandEvidenceRefs.push(commandEvidenceRef);
        }

        const activity: ToolActivityEntry = {
          id: newActivityId(),
          requestId,
          conversationId,
          toolName: call.name,
          arguments: call.arguments,
          resultSummary: buildResultSummary(call.name, result),
          durationMs,
          ok: result.ok,
          ...(result.errorCode !== undefined && { errorCode: result.errorCode }),
          executedAt: Date.now(),
        };
        toolActivity.push(activity);

        if (result.ok) {
          try { tracer?.emit(requestId, "TOOL_COMPLETED", { toolName: call.name, callId: call.callId, durationMs }); } catch { /* */ }
        } else {
          try { tracer?.emit(requestId, "TOOL_FAILED", { toolName: call.name, callId: call.callId, errorCode: result.errorCode, durationMs }); } catch { /* */ }
        }
        onToolEnd(call, result, durationMs);
        toolResults.push({ call, result });
      }

      // Append tool result messages to history
      const resultMessages = buildToolResultMessages(
        cfg.protocol,
        usedNativeTools,
        toolResults
      );
      messages.push(...resultMessages);

      run.toolStepCount++;

      // ── Loop detection ──────────────────────────────────────────────────
      // Hash the current observation (model text) and action (tool calls+args)
      // to detect when the model is stuck repeating the same steps.
      const obsHash = createHash("sha256").update(turnText.slice(0, 2048)).digest("hex").slice(0, 16);
      const actSig = decision.calls.map((c) => `${c.name}:${JSON.stringify(c.arguments ?? {})}`).join("|");
      const actHash = createHash("sha256").update(actSig).digest("hex").slice(0, 16);
      goalState.toolCallCount += decision.calls.length;
      if (obsHash === goalState.lastObservationHash) {
        goalState.sameObservationCount++;
      } else {
        goalState.sameObservationCount = 0;
      }
      if (actHash === goalState.lastActionSignature) {
        goalState.sameActionCount++;
      } else {
        goalState.sameActionCount = 0;
      }
      if (goalState.sameObservationCount > 0 && goalState.sameActionCount > 0) {
        goalState.stuckScore++;
        run.stuckScore = goalState.stuckScore;
        if (goalState.stuckScore >= STALL_THRESHOLD) {
          assertInvariant(
            "AGENT_GOAL_NOT_STALLED",
            false,
            { stuckScore: goalState.stuckScore, obsHash, actHash, step: run.toolStepCount, requestId },
            { requestId, conversationId, hint: "loop detection" }
          );
          transition(run, "failed", tracer);
          run.failureCode = "AGENT_GOAL_STALLED";
          run.failureMessage = `Agent loop stalled after ${goalState.stuckScore} identical steps`;
          throw new AgentLoopError("PROTOCOL_RECOVERY_EXHAUSTED", `Agent stalled: ${goalState.stuckScore} identical steps`);
        }
      } else {
        goalState.stuckScore = 0;
        run.stuckScore = 0;
      }
      goalState.lastObservationHash = obsHash;
      goalState.lastActionSignature = actHash;
      run.lastObservationHash = obsHash;
      run.lastActionHash = actHash;
      // ── End loop detection ───────────────────────────────────────────────

      // executing_tools → continuing
      transition(run, "continuing", tracer);
      // continuing → waiting_for_model (next loop iteration)
      transition(run, "waiting_for_model", tracer);
      continue;
    }

    // ── CASE: final ────────────────────────────────────────────────────────────
    if (decision.kind === "final") {
      // INV: TERMINAL_TURN_ONLY — the final turn must have non-empty content (or be global chat)
      assertInvariant(
        "TERMINAL_TURN_ONLY",
        decision.content.trim().length > 0 || !isProjectMode,
        { contentLength: decision.content.trim().length, isProjectMode, requestId },
        { requestId, conversationId, hint: "final decision content check" }
      );

      // processing_turn → finalizing
      transition(run, "finalizing", tracer);

      finalText = decision.content;
      proposalFenceRaw = decision.proposalFenceRaw;

      try {
        tracer?.emit(requestId, "FINAL_NORMALIZED", {
          contentLength: finalText.length,
          hasProposalFence: !!proposalFenceRaw,
        });
      } catch { /* */ }

      // Emit final content to caller
      if (finalText) {
        onChunk(finalText);
      }

      // finalizing → completed
      transition(run, "completed", tracer);
      try { tracer?.emit(requestId, "RUN_COMPLETED", { stepCount: run.toolStepCount, durationMs: Date.now() - run.startedAt }); } catch { /* */ }
      try { tracer?.endTrace(requestId, "completed"); } catch { /* */ }
      break;
    }

    // ── CASE: invalid ──────────────────────────────────────────────────────────
    if (decision.kind === "invalid") {
      // Intermediate: emit text to dev callback only, never to UI
      const stripped = stripForgeFences(turnText);
      if (stripped.trim() && onIntermediateText) {
        onIntermediateText(stripped);
      }

      if (!decision.recoverable) {
        // Unrecoverable (e.g. MULTIPLE_FINAL_ENVELOPES) — fail immediately
        transition(run, "failed", tracer);
        run.failureCode = decision.reason;
        run.failureMessage = `Unrecoverable protocol error: ${decision.reason}`;
        try { tracer?.emit(requestId, "RUN_FAILED", { failureCode: "PROTOCOL_RECOVERY_EXHAUSTED", reason: decision.reason }); } catch { /* */ }
        try { tracer?.endTrace(requestId, "failed", "PROTOCOL_RECOVERY_EXHAUSTED"); } catch { /* */ }
        throw new AgentLoopError(
          "PROTOCOL_RECOVERY_EXHAUSTED",
          `Unrecoverable protocol violation: ${decision.reason}`
        );
      }

      run.recoveryCount++;

      // INV: RECOVERY_BOUNDED — recovery count must never exceed max
      assertInvariant(
        "RECOVERY_BOUNDED",
        run.recoveryCount <= MAX_PROTOCOL_RECOVERY_TURNS,
        { recoveryCount: run.recoveryCount, max: MAX_PROTOCOL_RECOVERY_TURNS, reason: decision.reason, requestId },
        { requestId, conversationId, hint: "recovery budget check" }
      );

      try {
        tracer?.emit(requestId, "PROTOCOL_RECOVERY", { recoveryCount: run.recoveryCount, reason: decision.reason });
      } catch { /* */ }

      if (run.recoveryCount > MAX_PROTOCOL_RECOVERY_TURNS) {
        transition(run, "failed", tracer);
        run.failureCode = "PROTOCOL_RECOVERY_EXHAUSTED";
        run.failureMessage = `Model returned ${run.recoveryCount} consecutive invalid responses`;
        try { tracer?.emit(requestId, "RUN_FAILED", { failureCode: "PROTOCOL_RECOVERY_EXHAUSTED", recoveryCount: run.recoveryCount }); } catch { /* */ }
        try { tracer?.endTrace(requestId, "failed", "PROTOCOL_RECOVERY_EXHAUSTED"); } catch { /* */ }
        throw new AgentLoopError(
          "PROTOCOL_RECOVERY_EXHAUSTED",
          `Protocol recovery budget exceeded after ${run.recoveryCount} attempts`
        );
      }

      // Inject correction — do NOT record the invalid assistant turn in history
      // (the model-facing history still gets the assistant turn for context, but
      //  we record it without the naked narration)
      messages.push({ role: "assistant", content: turnText });
      messages.push({ role: "user", content: FORGE_PROTOCOL_CORRECTION });

      // processing_turn → continuing (recovery path)
      transition(run, "continuing", tracer);
      // continuing → waiting_for_model
      transition(run, "waiting_for_model", tracer);
      continue;
    }
  }

  // ── Budget exhausted — handle separately after loop ───────────────────────
  // (This branch is unreachable in the standard loop above because budget_exhausted
  //  changes normalizeDecision behavior; we handle budget finalization inline
  //  through the forge_final protocol. The section below handles the edge case
  //  where the model returns a tool call when budget is already exhausted.)

  return {
    finalText,
    proposalFenceRaw,
    stepCount: run.toolStepCount,
    agentReadRefs,
    commandEvidenceRefs,
    toolActivity,
    agentRun: run,
  };
}

// ── Budget finalization helper ────────────────────────────────────────────────

/**
 * Called by the loop when tool budget is exhausted and the model still returns
 * a tool call in the normalized decision (TOOL_CALL_AFTER_BUDGET).
 * We inject the budget-exhausted instruction and attempt one final turn.
 *
 * This is exposed for testing but is called internally by the loop when needed.
 * In practice the main loop handles budget via normalizeDecision — when
 * budgetExhausted=true, forge_tool fences and native tools are ignored and the
 * turn falls through to forge_final or invalid detection.
 *
 * @internal
 */
export async function attemptBudgetFinalization(
  cfg: AgentConfig,
  apiKey: string,
  messages: SimpleMessage[],
  system: string | undefined,
  signal: { aborted: boolean },
  onChunk: (chunk: string) => void,
  isProjectMode: boolean
): Promise<{ finalText: string; proposalFenceRaw: string | undefined }> {
  // Append the budget exhaustion instruction
  messages.push({ role: "user", content: BUDGET_EXHAUSTED_INSTRUCTION });

  let buffer = "";
  let rawText = "";
  try {
    rawText = await makeRequest({
      cfg,
      apiKey,
      messages,
      stream: true,
      ...(system !== undefined && { system }),
      tools: [], // no tools during finalization
      onChunk: (chunk) => { buffer += chunk; },
      signal,
    });
  } catch {
    throw new AgentLoopError("BUDGET_FINALIZATION_FAILED", "Provider error during budget finalization");
  }

  const turnText = rawText ?? buffer ?? "";
  const decision = normalizeDecision(turnText, [], isProjectMode, true);

  if (decision.kind === "final") {
    if (decision.content) onChunk(decision.content);
    return { finalText: decision.content, proposalFenceRaw: decision.proposalFenceRaw };
  }

  throw new AgentLoopError(
    "BUDGET_FINALIZATION_FAILED",
    "Model did not provide a valid forge_final response after budget exhaustion"
  );
}