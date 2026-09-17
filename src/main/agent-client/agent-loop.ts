/**
 * agent-loop.ts — Provider-neutral multi-turn agent tool loop.
 *
 * Drives the model through multiple turns when tool calls are present.
 * Supports:
 * - Native OpenAI tool_calls and Anthropic tool_use blocks
 * - forge_tool JSON fence fallback for endpoints that don't support native tools
 * - Tool budget enforcement (MAX_TOOL_STEPS_PER_REQUEST)
 * - User stop/cancel (signal.aborted checked before each turn)
 * - Ledger population (AgentReadRef + ToolActivityEntry per tool call)
 *
 * KEY INVARIANT — Provider turn ≠ Chat message:
 *   Intermediate turns (those followed by tool calls) must NEVER be forwarded
 *   to onChunk. Only the terminal turn (the final user-facing answer) is
 *   streamed via onChunk. Intermediate text is routed to onIntermediateText
 *   so the UI can show transient activity labels without polluting Chat history.
 *
 * Does NOT know about IPC, Electron, or the renderer.
 * Callbacks (onChunk, onToolStart, onToolEnd, onIntermediateText) bridge outside.
 */
import { randomUUID } from "crypto";
import type { AgentConfig, ForgeToolCall, ForgeToolResult, AgentReadRef, ToolActivityEntry } from "../../shared/types.js";
import { makeRequest } from "./client.js";
import type { SimpleMessage } from "./client.js";
import { TOOL_LIMITS, buildOpenAIToolDefs, buildAnthropicToolDefs } from "./tool-types.js";
import { executeProjectTool, buildResultSummary, newActivityId } from "../project-files/tool-executor.js";
import type { ToolExecutionContext } from "../project-files/tool-executor.js";

// ── Types ────────────────────────────────────────────────────────────────────

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
   * Called with each text chunk of the TERMINAL (final) provider turn only.
   * Intermediate tool-step turns are buffered internally and never forwarded here.
   */
  onChunk: (chunk: string) => void;
  /**
   * Called once per intermediate (non-terminal) provider turn with the stripped
   * visible text of that turn. Use this for transient activity labels, NOT for
   * persisting Chat messages.
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
  /** Number of tool-calling turns executed */
  stepCount: number;
  /** Files the agent autonomously read (fullFile or range) */
  agentReadRefs: AgentReadRef[];
  /** All tool invocations in order */
  toolActivity: ToolActivityEntry[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of premature-completion recovery injections per run. */
const CONTINUATION_BUDGET = 1;

const CONTINUATION_PROMPT =
  "AGENT_CONTINUATION: Your previous response appears incomplete — it did not " +
  "provide a substantive answer to the user's request. If you need more information, " +
  "call the appropriate project tools now. If you have gathered enough information, " +
  "provide your complete final answer immediately.";

// ── Forge tool fence parsing ─────────────────────────────────────────────────

const FORGE_TOOL_FENCE_RE = /```forge_tool\n([\s\S]*?)\n```/g;
const FORGE_TOOL_RESULT_FENCE = (callId: string, result: ForgeToolResult): string => {
  const payload: Record<string, unknown> = { callId, ok: result.ok };
  if (result.data !== undefined) payload["data"] = result.data;
  if (result.errorCode !== undefined) payload["errorCode"] = result.errorCode;
  if (result.errorMessage !== undefined) payload["errorMessage"] = result.errorMessage;
  return `\`\`\`forge_tool_result\n${JSON.stringify(payload)}\n\`\`\``;
};

/**
 * Extract forge_tool JSON fences from text.
 * Returns parsed tool calls. Non-parseable fences are silently skipped.
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
        arguments: typeof raw["arguments"] === "object" && raw["arguments"] !== null
          ? raw["arguments"] as Record<string, unknown>
          : {},
      });
    } catch {
      // malformed fence — skip
    }
  }
  return calls;
}

/**
 * Strip forge_tool and forge_tool_result fences from text.
 * These are internal protocol blocks that must never appear in user-visible content.
 */
function stripForgeFences(text: string): string {
  return text
    .replace(new RegExp(FORGE_TOOL_FENCE_RE.source, "g"), "")
    .replace(/```forge_tool_result\n[\s\S]*?\n```/g, "")
    .trim();
}

// ── Build tool result messages ───────────────────────────────────────────────

/**
 * Build the user message(s) to append after tool execution.
 * Protocol-aware: OpenAI uses role=tool; Anthropic uses role=user with tool_result blocks.
 * Falls back to forge_tool_result fence format for endpoints that used fence-style calling.
 */
function buildToolResultMessages(
  protocol: string,
  usedNativeTools: boolean,
  toolResults: Array<{ call: ForgeToolCall; result: ForgeToolResult }>
): SimpleMessage[] {
  if (!usedNativeTools) {
    // Forge fence fallback: append results as user message fences
    const fences = toolResults
      .map(({ call, result }) => FORGE_TOOL_RESULT_FENCE(call.callId, result))
      .join("\n");
    return [{ role: "user", content: fences }];
  }

  if (protocol === "anthropic") {
    // Anthropic: single user message with tool_result content blocks
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
    content: `[tool_result id="${call.callId}" name="${call.name}"] ${result.ok ? JSON.stringify(result.data ?? "") : `Error: ${result.errorMessage ?? result.errorCode ?? "unknown"}`}`,
  }));
}

// ── Main loop ────────────────────────────────────────────────────────────────

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    cfg, apiKey, messages: initialMessages, system,
    projectId, projectRoot, requestId, conversationId,
    onChunk, onIntermediateText, onToolStart, onToolEnd, signal,
  } = opts;

  // Mutable execution context (shared reference — tool executor updates readBytesUsed)
  const ctx: ToolExecutionContext = {
    projectId,
    projectRoot,
    requestId,
    conversationId,
    readBytesUsed: 0,
  };

  // Accumulated results
  const agentReadRefs: AgentReadRef[] = [];
  const toolActivity: ToolActivityEntry[] = [];

  // Working message history (extended with assistant/tool turns)
  const messages: SimpleMessage[] = [...initialMessages];

  // Build tool definitions for this protocol
  const tools = cfg.protocol === "anthropic"
    ? buildAnthropicToolDefs()
    : buildOpenAIToolDefs();

  let stepCount = 0;
  let finalText = "";
  let budgetExhausted = false;
  let continuationUsed = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check for user cancellation before each turn
    if (signal.aborted) {
      throw new Error("cancelled");
    }

    // Check tool step budget
    if (stepCount >= TOOL_LIMITS.MAX_TOOL_STEPS_PER_REQUEST) {
      budgetExhausted = true;
    }

    // Accumulated tool calls from THIS turn's native callbacks
    const nativeToolCallsThisTurn: ForgeToolCall[] = [];
    let usedNativeTools = false;

    // Make one model request — buffer chunks internally (do NOT forward yet).
    // We only forward to onChunk once we confirm this is the terminal turn.
    let turnChunks = "";

    const rawText = await makeRequest({
      cfg,
      apiKey,
      messages,
      stream: true,
      ...(system !== undefined && { system }),
      tools: budgetExhausted ? [] : tools,
      onChunk: (chunk) => {
        // Accumulate internally — do NOT forward to caller yet
        turnChunks += chunk;
      },
      onToolCall: (call) => {
        usedNativeTools = true;
        nativeToolCallsThisTurn.push(call);
      },
      signal,
    });

    // Determine tool calls for this turn:
    // Priority 1: native tool calls detected by makeRequest callbacks
    // Priority 2: forge_tool fences in the text (fallback protocol)
    let toolCallsThisTurn: ForgeToolCall[];
    if (nativeToolCallsThisTurn.length > 0) {
      usedNativeTools = true;
      toolCallsThisTurn = nativeToolCallsThisTurn;
    } else {
      toolCallsThisTurn = extractForgeFences(rawText);
      usedNativeTools = false;
    }

    // Compute the visible text for this turn — always strip forge fences
    // rawText may be empty string or undefined from mocks — guard with ?? ""
    const visibleText = stripForgeFences((rawText ?? turnChunks) || "");

    // Record assistant turn in message history (raw text for model continuity)
    messages.push({ role: "assistant", content: visibleText || rawText });

    // ── Tool-step turn (non-terminal) ────────────────────────────────────────
    if (toolCallsThisTurn.length > 0 && !budgetExhausted) {
      // Fire onIntermediateText with stripped visible text (transient activity label)
      // This is NOT sent to the chat history or persisted as a message.
      const intermediateLabel = visibleText.trim();
      if (intermediateLabel && onIntermediateText) {
        onIntermediateText(intermediateLabel);
      }

      // Execute tool calls
      const toolResults: Array<{ call: ForgeToolCall; result: ForgeToolResult }> = [];

      for (const call of toolCallsThisTurn) {
        if (signal.aborted) throw new Error("cancelled");

        onToolStart(call);

        const execResult = await executeProjectTool(call, ctx);
        const { result, agentReadRef, durationMs } = execResult;

        if (agentReadRef) {
          agentReadRefs.push(agentReadRef);
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

        onToolEnd(call, result, durationMs);
        toolResults.push({ call, result });
      }

      // Append tool result messages to history
      const resultMessages = buildToolResultMessages(cfg.protocol, usedNativeTools, toolResults);
      messages.push(...resultMessages);

      stepCount++;
      continue;
    }

    // ── Budget exhausted with pending tool calls ──────────────────────────────
    if (budgetExhausted && toolCallsThisTurn.length > 0) {
      messages.push({
        role: "user",
        content: "TOOL_BUDGET_EXHAUSTED: You have reached the maximum number of tool calls allowed for this request. Please synthesize your findings so far and provide your final response without calling any more tools.",
      });

      if (!signal.aborted) {
        let wrapupBuffer = "";
        const wrapupText = await makeRequest({
          cfg, apiKey, messages, stream: true,
          ...(system !== undefined && { system }),
          tools: [],
          onChunk: (chunk) => {
            wrapupBuffer += chunk;
            onChunk(chunk); // terminal — forward directly
          },
          signal,
        });
        finalText = stripForgeFences(wrapupText || wrapupBuffer);
      }
      break;
    }

    // ── Terminal turn — no tool calls ─────────────────────────────────────────
    // Check for premature completion: the model ended its turn with completely
    // empty output after having executed tool steps. This means the model
    // narrated its intent but forgot to provide an actual answer.
    // We do NOT use a length heuristic — short answers are valid answers.
    const hasProposal = visibleText.includes("forge_edit_proposal");
    const isPremature =
      !hasProposal &&
      stepCount > 0 &&
      visibleText.trim().length === 0 &&
      continuationUsed < CONTINUATION_BUDGET;

    if (isPremature) {
      // Inject continuation prompt and do one more turn
      continuationUsed++;
      messages.push({ role: "user", content: CONTINUATION_PROMPT });
      // The intermediate text from this non-terminal response is discarded
      // (it was only brief narration — not worth surfacing)
      continue;
    }

    // This IS the final answer. Stream the buffered text to the UI.
    // We replay the full text at once (not per-chunk) because we buffered it.
    // The streaming effect for intermediate turns is intentionally absent —
    // users should see tool activity rows, then the final answer appear.
    if (visibleText) {
      onChunk(visibleText);
    }

    finalText = visibleText;
    break;
  }

  return { finalText, stepCount, agentReadRefs, toolActivity };
}