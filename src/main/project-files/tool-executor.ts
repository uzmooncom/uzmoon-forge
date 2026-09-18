/**
 * tool-executor.ts — Project tool executor for V0.4 agent loop.
 *
 * Bridges between ForgeToolCall (from model) and the existing service/eligibility layer.
 * All security rules enforced via the canonical eligibility.ts module.
 * No absolute paths are ever returned to the model.
 * No filesystem logic is duplicated here — this is a thin adapter.
 */
import path from "path";
import { randomUUID } from "crypto";
import type { ForgeToolCall, ForgeToolResult, AgentReadRef } from "../../shared/types.js";
import {
  validateToolCall,
  TOOL_LIMITS,
  type ListDirectoryArgs,
  type SearchFilesArgs,
  type SearchCodeArgs,
  type ReadFileArgs,
  type ReadFileRangeArgs,
  type RunCommandArgs,
  type ListProjectCommandsArgs,
  type ReadCommandOutputArgs,
  type BrowserListSessionsArgs,
  type BrowserNewTabArgs,
  type BrowserTabRefArgs,
  type BrowserOpenUrlArgs,
  type BrowserFindTextArgs,
  type BrowserClickArgs,
  type BrowserTypeArgs,
  type BrowserFillArgs,
  type BrowserSelectArgs,
  type BrowserPressKeyArgs,
  type BrowserScrollArgs,
  type BrowserCreateSessionArgs,
  type BrowserUseSessionArgs,
  type BrowserWaitForArgs,
  type BrowserHoverArgs,
  type BrowserDoubleClickArgs,
  type BrowserDragArgs,
  type BrowserFocusArgs,
  type BrowserClearArgs,
  type BrowserScrollIntoViewArgs,
  type BrowserCheckboxArgs,
  type BrowserUploadFileArgs,
  type BrowserGetMediaArgs,
  type BrowserControlMediaArgs,
  type BrowserHandleDialogArgs,
  type StartProjectProcessArgs,
  type ReadProjectProcessOutputArgs,
  type StopProjectProcessArgs,
} from "../agent-client/tool-types.js";
import { COMMAND_LIMITS } from "../commands/command-limits.js";
import type { CommandEvidenceRef } from "../../shared/types.js";
import * as service from "./service.js";
import { searchCode } from "./search-code.js";

// ── Execution context ────────────────────────────────────────────────────────

export interface ToolExecutionContext {
  projectId: string;
  projectRoot: string;
  requestId: string;
  conversationId: string;
  /** Total bytes read so far this request (mutable — executor updates it) */
  readBytesUsed: number;
  /** Number of run_command calls issued this agent run (mutable — executor increments it) */
  commandsRunThisRequest: number;
}

export interface ToolExecutionResult {
  result: ForgeToolResult;
  /** Populated when read_file succeeds — to be appended to ledger */
  agentReadRef?: AgentReadRef;
  /** Populated when run_command succeeds — to be appended to ledger */
  commandEvidenceRef?: CommandEvidenceRef;
  /** Populated when browser_screenshot succeeds — injected as ImageContent in next model turn */
  imageAttachment?: { mimeType: string; data: string };
  /** Milliseconds elapsed executing the tool */
  durationMs: number;
}

// ── Main dispatcher ─────────────────────────────────────────────────────────

/**
 * Execute a single agent tool call.
 * Returns a ForgeToolResult (safe for model consumption) plus an optional AgentReadRef
 * for full-file reads (to be tracked in the RequestContextLedger).
 *
 * Security invariants:
 * - Absolute paths never appear in result data or error messages
 * - Sensitive/binary/ignored files are blocked at the service layer
 * - Path traversal blocked by validateToolCall + resolveProjectPath
 * - Budget enforced before reading — not after
 */
export async function executeProjectTool(
  call: ForgeToolCall,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const started = Date.now();

  // 1. Validate arguments (untrusted model input)
  const validation = validateToolCall(call);
  if (!validation.ok) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: validation.errorCode,
        errorMessage: validation.errorMessage,
      },
      durationMs: Date.now() - started,
    };
  }

  // 2. Dispatch to tool handler
  let result: Omit<ToolExecutionResult, "durationMs">;

  switch (validation.toolName) {
    case "list_directory":
      result = await handleListDirectory(call, validation.args as ListDirectoryArgs, ctx);
      break;
    case "search_files":
      result = await handleSearchFiles(call, validation.args as SearchFilesArgs, ctx);
      break;
    case "search_code":
      result = await handleSearchCode(call, validation.args as SearchCodeArgs, ctx);
      break;
    case "read_file":
      result = await handleReadFile(call, validation.args as ReadFileArgs, ctx);
      break;
    case "read_file_range":
      result = await handleReadFileRange(call, validation.args as ReadFileRangeArgs, ctx);
      break;
    case "run_command":
      result = await handleRunCommand(call, validation.args as RunCommandArgs, ctx);
      break;
    case "list_project_commands":
      result = await handleListProjectCommands(call, validation.args as ListProjectCommandsArgs, ctx);
      break;
    case "read_command_output":
      result = await handleReadCommandOutput(call, validation.args as ReadCommandOutputArgs, ctx);
      break;
    // ── Browser Runtime V1 ──────────────────────────────────────────────────
    case "browser_list_sessions":
      result = await handleBrowserListSessions(call, validation.args as BrowserListSessionsArgs, ctx);
      break;
    case "browser_new_tab":
      result = await handleBrowserNewTab(call, validation.args as BrowserNewTabArgs, ctx);
      break;
    case "browser_close_tab":
      result = await handleBrowserTabAction(call, "close_tab", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_switch_tab":
      result = await handleBrowserTabAction(call, "switch_tab", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_open_url":
      result = await handleBrowserOpenUrl(call, validation.args as BrowserOpenUrlArgs, ctx);
      break;
    case "browser_back":
      result = await handleBrowserTabAction(call, "back", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_forward":
      result = await handleBrowserTabAction(call, "forward", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_reload":
      result = await handleBrowserTabAction(call, "reload", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_stop":
      result = await handleBrowserTabAction(call, "stop", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_read_page":
      result = await handleBrowserReadPage(call, validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_find_text":
      result = await handleBrowserFindText(call, validation.args as BrowserFindTextArgs, ctx);
      break;
    case "browser_click":
      result = await handleBrowserClick(call, validation.args as BrowserClickArgs, ctx);
      break;
    case "browser_type":
      result = await handleBrowserType(call, validation.args as BrowserTypeArgs, ctx);
      break;
    case "browser_fill":
      result = await handleBrowserFill(call, validation.args as BrowserFillArgs, ctx);
      break;
    case "browser_select":
      result = await handleBrowserSelect(call, validation.args as BrowserSelectArgs, ctx);
      break;
    case "browser_press_key":
      result = await handleBrowserPressKey(call, validation.args as BrowserPressKeyArgs, ctx);
      break;
    case "browser_scroll":
      result = await handleBrowserScroll(call, validation.args as BrowserScrollArgs, ctx);
      break;
    case "browser_screenshot":
      result = await handleBrowserTabAction(call, "screenshot", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_get_console":
      result = await handleBrowserTabAction(call, "get_console", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_get_network_summary":
      result = await handleBrowserTabAction(call, "get_network", validation.args as BrowserTabRefArgs, ctx);
      break;
    case "browser_list_profiles":
      result = await handleBrowserListProfiles(call, ctx);
      break;
    case "browser_create_session":
      result = await handleBrowserCreateSession(call, validation.args as BrowserCreateSessionArgs, ctx);
      break;
    case "browser_use_session":
      result = await handleBrowserUseSession(call, validation.args as BrowserUseSessionArgs, ctx);
      break;
    case "browser_wait_for":
      result = await handleBrowserWaitFor(call, validation.args as BrowserWaitForArgs, ctx);
      break;
    // ── Browser Runtime V3 — Extended Interaction ────────────────────────
    case "browser_hover":
      result = await handleBrowserRefAction(call, "hover", validation.args as BrowserHoverArgs, ctx);
      break;
    case "browser_double_click":
      result = await handleBrowserRefAction(call, "double_click", validation.args as BrowserDoubleClickArgs, ctx);
      break;
    case "browser_focus":
      result = await handleBrowserRefAction(call, "focus", validation.args as BrowserFocusArgs, ctx);
      break;
    case "browser_clear":
      result = await handleBrowserRefAction(call, "clear", validation.args as BrowserClearArgs, ctx);
      break;
    case "browser_scroll_into_view":
      result = await handleBrowserRefAction(call, "scroll_into_view", validation.args as BrowserScrollIntoViewArgs, ctx);
      break;
    case "browser_drag":
      result = await handleBrowserDrag(call, validation.args as BrowserDragArgs, ctx);
      break;
    case "browser_checkbox":
      result = await handleBrowserCheckbox(call, validation.args as BrowserCheckboxArgs, ctx);
      break;
    case "browser_upload_file":
      result = await handleBrowserUploadFile(call, validation.args as BrowserUploadFileArgs, ctx);
      break;
    case "browser_get_media":
      result = await handleBrowserGetMedia(call, validation.args as BrowserGetMediaArgs, ctx);
      break;
    case "browser_control_media":
      result = await handleBrowserControlMedia(call, validation.args as BrowserControlMediaArgs, ctx);
      break;
    case "browser_handle_dialog":
      result = await handleBrowserHandleDialog(call, validation.args as BrowserHandleDialogArgs, ctx);
      break;
    case "is_browser_open":
      result = await handleIsBrowserOpen(call, ctx);
      break;
    case "get_browser_status":
      result = await handleGetBrowserStatus(call, ctx);
      break;
    case "browser_open":
      result = await handleBrowserOpen(call, ctx);
      break;
    case "start_project_process":
      result = await handleStartProjectProcess(call, validation.args as StartProjectProcessArgs, ctx);
      break;
    case "list_project_processes":
      result = await handleListProjectProcesses(call, ctx);
      break;
    case "read_project_process_output":
      result = await handleReadProjectProcessOutput(call, validation.args as ReadProjectProcessOutputArgs, ctx);
      break;
    case "stop_project_process":
      result = await handleStopProjectProcess(call, validation.args as StopProjectProcessArgs, ctx);
      break;
  }

  return { ...result, durationMs: Date.now() - started };
}

// ── Tool handlers ───────────────────────────────────────────────────────────

async function handleListDirectory(
  call: ForgeToolCall,
  args: ListDirectoryArgs,
  ctx: ToolExecutionContext
): Promise<Omit<ToolExecutionResult, "durationMs">> {
  const relPath = args.path ?? "";
  const depth = args.depth ?? 1;
  const limit = args.limit ?? TOOL_LIMITS.MAX_DIRECTORY_RESULTS;

  // Recursively collect entries up to depth
  const entries = collectDirectoryEntries(ctx.projectRoot, ctx.projectId, relPath, depth, limit);

  const data = {
    path: relPath || ".",
    entries: entries.slice(0, limit),
    totalCount: entries.length,
    truncated: entries.length > limit,
  };

  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data,
    },
  };
}

function collectDirectoryEntries(
  projectRoot: string,
  projectId: string,
  relPath: string,
  depth: number,
  limit: number,
  _currentDepth = 0
): Array<{ name: string; relativePath: string; kind: "file" | "directory"; size?: number; isSensitive?: boolean }> {
  const result = service.listDirectory(projectId, projectRoot, relPath);
  if (!result.ok) return [];

  const entries: Array<{ name: string; relativePath: string; kind: "file" | "directory"; size?: number; isSensitive?: boolean }> = [];

  for (const entry of result.entries) {
    if (entries.length >= limit) break;
    entries.push({
      name: entry.name,
      relativePath: entry.relativePath,
      kind: entry.kind,
      ...(entry.size !== undefined && { size: entry.size }),
      ...(entry.isSensitive && { isSensitive: true }),
    });

    // Recurse into directories if depth allows
    if (entry.kind === "directory" && _currentDepth < depth - 1) {
      const children = collectDirectoryEntries(
        projectRoot,
        projectId,
        entry.relativePath,
        depth,
        limit - entries.length,
        _currentDepth + 1
      );
      entries.push(...children.slice(0, limit - entries.length));
    }
  }

  return entries;
}

async function handleSearchFiles(
  call: ForgeToolCall,
  args: SearchFilesArgs,
  ctx: ToolExecutionContext
): Promise<Omit<ToolExecutionResult, "durationMs">> {
  const limit = args.limit ?? TOOL_LIMITS.MAX_SEARCH_RESULTS;
  const results = service.searchFiles(ctx.projectId, ctx.projectRoot, args.query, limit);

  const data = {
    query: args.query,
    matches: results.map((r) => ({
      relativePath: r.relativePath,
      name: r.name,
    })),
    count: results.length,
    truncated: results.length >= limit,
  };

  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data,
    },
  };
}

async function handleSearchCode(
  call: ForgeToolCall,
  args: SearchCodeArgs,
  ctx: ToolExecutionContext
): Promise<Omit<ToolExecutionResult, "durationMs">> {
  const limit = args.limit ?? TOOL_LIMITS.MAX_CODE_SEARCH_RESULTS;
  const caseSensitive = args.caseSensitive ?? false;

  const searchResult = searchCode(ctx.projectId, ctx.projectRoot, args.query, caseSensitive, limit);

  if (!searchResult.ok) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: searchResult.errorCode,
        errorMessage: searchResult.errorMessage,
      },
    };
  }

  const data = {
    query: args.query,
    caseSensitive,
    matches: searchResult.matches,
    count: searchResult.matches.length,
    truncated: searchResult.truncated,
    totalScanned: searchResult.totalScanned,
  };

  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data,
    },
  };
}

async function handleReadFile(
  call: ForgeToolCall,
  args: ReadFileArgs,
  ctx: ToolExecutionContext
): Promise<Omit<ToolExecutionResult, "durationMs">> {
  // Budget check BEFORE reading
  if (ctx.readBytesUsed >= TOOL_LIMITS.MAX_TOTAL_AGENT_READ_BYTES) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "TOOL_BUDGET_EXHAUSTED",
        errorMessage: `Read budget exhausted (${TOOL_LIMITS.MAX_TOTAL_AGENT_READ_BYTES} bytes). No more file reads allowed this request.`,
      },
    };
  }

  // Capture immutable snapshot — this applies ALL eligibility rules
  const snapResult = service.captureSnapshot(
    ctx.projectId,
    ctx.projectRoot,
    args.path
    // no lineStart/lineEnd → full file
  );

  if (!snapResult.ok) {
    const errorCode = mapServiceError(snapResult.error);
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode,
        errorMessage: sanitizeError(snapResult.error),
      },
    };
  }

  const { ref } = snapResult;

  // Single-file size limit
  if (ref.size > TOOL_LIMITS.MAX_SINGLE_FILE_READ_BYTES) {
    // Clean up the snapshot we just wrote — file is too large
    try {
      const fs = await import("fs");
      fs.unlinkSync(ref.snapshotPath);
    } catch {
      // best-effort
    }
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "FILE_TOO_LARGE_FOR_FULL_READ",
        errorMessage: `File is ${Math.round(ref.size / 1024)} KB. Max is ${Math.round(TOOL_LIMITS.MAX_SINGLE_FILE_READ_BYTES / 1024)} KB. Use read_file_range to read sections.`,
      },
    };
  }

  // Read content from snapshot
  const content = service.readSnapshot(ref.snapshotPath);
  if (content === null) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "SNAPSHOT_UNAVAILABLE",
        errorMessage: "Failed to read captured file content",
      },
    };
  }

  // Update budget
  ctx.readBytesUsed += ref.size;

  // Build AgentReadRef for ledger
  const agentReadRef: AgentReadRef = {
    id: ref.id,
    requestId: ctx.requestId,
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    relativePath: ref.relativePath,
    snapshotPath: ref.snapshotPath,
    contentHash: ref.contentHash,
    capturedAt: ref.capturedAt,
    size: ref.size,
    language: ref.language,
    fullFile: true,
  };

  // Truncate content in result if above tool result limit
  let resultContent = content;
  let truncated = false;
  if (Buffer.byteLength(resultContent, "utf8") > TOOL_LIMITS.MAX_TOOL_RESULT_BYTES) {
    const buf = Buffer.from(resultContent, "utf8").slice(0, TOOL_LIMITS.MAX_TOOL_RESULT_BYTES);
    resultContent = buf.toString("utf8") + "\n\n[... content truncated in tool result — full content captured in snapshot ...]";
    truncated = true;
  }

  const data = {
    relativePath: ref.relativePath,
    language: ref.language,
    size: ref.size,
    snapshotId: ref.id,
    contentHash: ref.contentHash,
    content: resultContent,
    truncated,
    fullFile: true,
  };

  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data,
    },
    agentReadRef,
  };
}

async function handleReadFileRange(
  call: ForgeToolCall,
  args: ReadFileRangeArgs,
  ctx: ToolExecutionContext
): Promise<Omit<ToolExecutionResult, "durationMs">> {
  // Budget check
  if (ctx.readBytesUsed >= TOOL_LIMITS.MAX_TOTAL_AGENT_READ_BYTES) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "TOOL_BUDGET_EXHAUSTED",
        errorMessage: `Read budget exhausted. No more file reads allowed this request.`,
      },
    };
  }

  const readResult = service.readFile(
    ctx.projectRoot,
    args.path,
    args.startLine,
    args.endLine,
    false // not for context (no snapshot)
  );

  if (!readResult.ok) {
    const errorCode = mapServiceError(readResult.error);
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode,
        errorMessage: sanitizeError(readResult.error),
      },
    };
  }

  const contentBytes = Buffer.byteLength(readResult.content, "utf8");
  ctx.readBytesUsed += contentBytes;

  // Capture a range snapshot for ledger tracking (fullFile=false — not a valid edit base)
  const snapResult = service.captureSnapshot(
    ctx.projectId,
    ctx.projectRoot,
    args.path,
    args.startLine,
    args.endLine
  );

  let agentReadRef: AgentReadRef | undefined;
  if (snapResult.ok) {
    agentReadRef = {
      id: snapResult.ref.id,
      requestId: ctx.requestId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      relativePath: snapResult.ref.relativePath,
      snapshotPath: snapResult.ref.snapshotPath,
      contentHash: snapResult.ref.contentHash,
      capturedAt: snapResult.ref.capturedAt,
      size: snapResult.ref.size,
      language: snapResult.ref.language,
      fullFile: false, // range read — NOT valid as edit base
      lineStart: args.startLine,
      lineEnd: args.endLine,
    };
  }

  // Truncate if over tool result limit
  let resultContent = readResult.content;
  let truncated = false;
  if (Buffer.byteLength(resultContent, "utf8") > TOOL_LIMITS.MAX_TOOL_RESULT_BYTES) {
    const buf = Buffer.from(resultContent, "utf8").slice(0, TOOL_LIMITS.MAX_TOOL_RESULT_BYTES);
    resultContent = buf.toString("utf8") + "\n\n[... content truncated ...]";
    truncated = true;
  }

  const displayPath = path.normalize(args.path).replace(/\\/g, "/");

  const data = {
    relativePath: displayPath,
    language: readResult.language,
    startLine: args.startLine,
    endLine: args.endLine,
    content: resultContent,
    truncated,
    fullFile: false,
    note: "Range reads cannot be used as Safe File Editing bases. Call read_file for complete content if you plan to modify this file.",
  };

  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data,
    },
    ...(agentReadRef !== undefined && { agentReadRef }),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map service error strings to structured error codes.
 * Never exposes absolute paths in the returned code.
 */
function mapServiceError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("traversal") || lower.includes("outside")) return "PATH_OUTSIDE_PROJECT";
  if (lower.includes("sensitive")) return "SENSITIVE_FILE";
  if (lower.includes("binary")) return "BINARY_FILE";
  if (lower.includes("not found")) return "NOT_FOUND";
  if (lower.includes("too large")) return "FILE_TOO_LARGE";
  if (lower.includes("gitignore") || lower.includes("ignored")) return "FILE_IGNORED";
  if (lower.includes("utf-8") || lower.includes("utf8")) return "BINARY_FILE";
  return "READ_ERROR";
}

/**
 * Sanitize error messages — remove any absolute paths before sending to model.
 */
function sanitizeError(error: string): string {
  // Remove absolute path segments
  return error.replace(/\/[^\s"']+/g, "<path>").slice(0, 200);
}


// ── run_command handler ─────────────────────────────────────────────────────

async function handleRunCommand(
  call: ForgeToolCall,
  args: RunCommandArgs,
  ctx: ToolExecutionContext
): Promise<Omit<ToolExecutionResult, "durationMs">> {
  // Per-request command budget (COMMAND_BUDGET_EXCEEDED)
  if (ctx.commandsRunThisRequest >= COMMAND_LIMITS.MAX_COMMANDS_PER_AGENT_RUN) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "COMMAND_BUDGET_EXCEEDED",
        errorMessage: `Command budget exhausted: maximum ${COMMAND_LIMITS.MAX_COMMANDS_PER_AGENT_RUN} run_command calls per agent run.`,
      },
    };
  }
  // Increment budget counter before proposal (prevents race if two tool calls overlap)
  ctx.commandsRunThisRequest++;

  // Lazy import to avoid circular dependency
  const { propose } = await import("../commands/command-manager.js");
  const { COMMAND_TERMINAL_STATES } = await import("../../shared/types.js");
  const { buildEvidenceRef } = await import("../commands/command-manager.js");

  let record;
  try {
    record = propose({
      projectId: ctx.projectId,
      projectRoot: ctx.projectRoot,
      spec: {
        executable: args.executable,
        args: args.args,
        cwdRelative: args.cwdRelative,
        ...(args.purpose !== undefined && { purpose: args.purpose }),
        ...(args.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
      },
      source: "agent",
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "COMMAND_POLICY_BLOCK",
        errorMessage: `Command blocked by policy: ${message.slice(0, 120)}`,
      },
    };
  }

  // Blocked by policy immediately
  if (record.state === "blocked") {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "COMMAND_POLICY_BLOCK",
        errorMessage: `Command blocked by policy: ${record.displayCommand}`,
      },
    };
  }

  // Awaiting user approval — return immediately with pending status
  if (record.state === "awaiting_approval") {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: true,
        data: {
          commandId: record.id,
          status: "awaiting_approval",
          displayCommand: record.displayCommand,
          message: "Command is awaiting user approval. Re-call with the same commandId once approved, or wait for approval.",
        },
      },
    };
  }

  // Auto-approved (trusted/approved_once) — wait for completion
  const MAX_WAIT_MS = (args.timeoutMs ?? 60_000) + 5_000;
  const POLL_INTERVAL_MS = 200;
  const { getCommand } = await import("../commands/command-manager.js");

  const deadline = Date.now() + MAX_WAIT_MS;
  let finalRecord = record;

  while (!COMMAND_TERMINAL_STATES.has(finalRecord.state)) {
    if (Date.now() >= deadline) break;
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    const latest = getCommand(record.id);
    if (latest) finalRecord = latest;
  }

  if (!COMMAND_TERMINAL_STATES.has(finalRecord.state)) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "COMMAND_TIMEOUT",
        errorMessage: `Command timed out after ${MAX_WAIT_MS}ms: ${finalRecord.displayCommand}`,
      },
    };
  }

  const evidenceRef = buildEvidenceRef(record.id);

  if (finalRecord.state === "cancelled") {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "COMMAND_CANCELLED",
        errorMessage: `Command was cancelled: ${finalRecord.displayCommand}`,
      },
      ...(evidenceRef !== null && { commandEvidenceRef: evidenceRef }),
    };
  }

  if (finalRecord.state !== "succeeded") {
    const exitStr = finalRecord.exitCode !== undefined ? ` (exit ${finalRecord.exitCode})` : "";
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "COMMAND_FAILED",
        errorMessage: `Command failed${exitStr}: ${finalRecord.displayCommand}`,
        data: evidenceRef ? {
          commandId: record.id,
          exitCode: finalRecord.exitCode,
          outputSummary: evidenceRef.outputSummary,
          modelOutput: evidenceRef.modelOutput,
        } : undefined,
      },
      ...(evidenceRef !== null && { commandEvidenceRef: evidenceRef }),
    };
  }

  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data: evidenceRef ? {
        commandId: record.id,
        exitCode: finalRecord.exitCode ?? 0,
        durationMs: finalRecord.durationMs,
        outputSummary: evidenceRef.outputSummary,
        modelOutput: evidenceRef.modelOutput,
      } : {
        commandId: record.id,
        exitCode: finalRecord.exitCode ?? 0,
      },
    },
    ...(evidenceRef !== null && { commandEvidenceRef: evidenceRef }),
  };
}

// ── list_project_commands handler ───────────────────────────────────────────

async function handleListProjectCommands(
  call: ForgeToolCall,
  args: ListProjectCommandsArgs,
  ctx: ToolExecutionContext
): Promise<Omit<ToolExecutionResult, "durationMs">> {
  const { listCommands } = await import("../commands/command-manager.js");

  const allForProject = listCommands(ctx.projectId, args.conversationId);

  // Optional state filter
  let filtered = args.state
    ? allForProject.filter((c) => c.state === args.state)
    : allForProject;

  // Sort newest first
  filtered = filtered.sort((a, b) => b.createdAt - a.createdAt);

  const limit = args.limit ?? 20;
  const results = filtered.slice(0, limit).map((c) => ({
    commandId: c.id,
    state: c.state,
    displayCommand: c.displayCommand,
    source: c.source,
    riskClass: c.policyDecision.riskClass,
    exitCode: c.exitCode ?? null,
    durationMs: c.durationMs ?? null,
    createdAt: c.createdAt,
    ...(c.authorizationState && { authorizationState: c.authorizationState }),
  }));

  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data: {
        projectId: ctx.projectId,
        count: results.length,
        totalCount: filtered.length,
        commands: results,
      },
    },
  };
}

// ── read_command_output handler ──────────────────────────────────────────────

async function handleReadCommandOutput(
  call: ForgeToolCall,
  args: ReadCommandOutputArgs,
  ctx: ToolExecutionContext
): Promise<Omit<ToolExecutionResult, "durationMs">> {
  const { getCommand, readCommandOutput } = await import("../commands/command-manager.js");

  const record = getCommand(args.commandId);

  // Cross-project access guard — agent may only read commands in its own project
  if (!record) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "NOT_FOUND",
        errorMessage: `Command not found: ${args.commandId}`,
      },
    };
  }

  if (record.projectId !== ctx.projectId) {
    return {
      result: {
        callId: call.callId,
        toolName: call.name,
        ok: false,
        errorCode: "ACCESS_DENIED",
        errorMessage: `Command ${args.commandId} belongs to a different project.`,
      },
    };
  }

  const page = readCommandOutput(
    args.commandId,
    args.offsetBytes ?? 0,
    args.limitBytes ?? COMMAND_LIMITS.MAX_MODEL_OUTPUT_BYTES
  );

  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data: {
        commandId: args.commandId,
        state: record.state,
        text: page.text,
        truncated: page.truncated,
        totalBytes: page.totalBytes,
        offsetBytes: args.offsetBytes ?? 0,
      },
    },
  };
}

/**
 * Generate a stable tool activity result summary string.
 */
export function buildResultSummary(toolName: string, result: ForgeToolResult): string {
  if (!result.ok) return `Error: ${result.errorCode ?? "unknown"}`;
  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return "ok";

  switch (toolName) {
    case "list_directory": {
      const count = (data["entries"] as unknown[])?.length ?? 0;
      const truncated = data["truncated"] ? "+" : "";
      return `${count}${truncated} entries`;
    }
    case "search_files": {
      const count = (data["count"] as number) ?? 0;
      return `${count} file${count !== 1 ? "s" : ""}`;
    }
    case "search_code": {
      const count = (data["count"] as number) ?? 0;
      const truncated = data["truncated"] ? "+" : "";
      return `${count}${truncated} match${count !== 1 ? "es" : ""}`;
    }
    case "read_file": {
      const size = (data["size"] as number) ?? 0;
      return `read ${formatBytes(size)}`;
    }
    case "read_file_range": {
      const start = data["startLine"] as number;
      const end = data["endLine"] as number;
      return `lines ${start}–${end}`;
    }
    case "run_command": {
      const exitCode = data["exitCode"] as number | undefined;
      const exitStr = exitCode !== undefined ? ` exit ${exitCode}` : "";
      return `${exitStr}`;
    }
    case "list_project_commands": {
      const count = (data["count"] as number) ?? 0;
      return `${count} command${count !== 1 ? "s" : ""}`;
    }
    case "read_command_output": {
      const totalBytes = (data["totalBytes"] as number) ?? 0;
      const truncated = data["truncated"] ? "+" : "";
      return `${formatBytes(totalBytes)}${truncated} output`;
    }
    default:
      return "ok";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Generate a stable unique ID for tool activity entries */
export function newActivityId(): string {
  return randomUUID();
}
// ── Browser Runtime V1 handlers ─────────────────────────────────────────────

async function handleBrowserListSessions(
  call: ForgeToolCall,
  args: BrowserListSessionsArgs,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const state = bm.getBrowserRuntimeState();
  let sessions = state.sessions;
  if (args.profile_id) {
    sessions = sessions.filter((s) => s.profileId === args.profile_id);
  }
  const summary = sessions.map((s) => ({
    sessionId: s.id,
    profileId: s.profileId,
    tabCount: s.tabIds.length,
    activeTabUrl: state.tabs.find((t) => t.id === s.activeTabId)?.url ?? null,
  }));
  return {
    result: {
      callId: call.callId,
      toolName: call.name,
      ok: true,
      data: { sessions: summary, total: summary.length },
    },
  };
}

async function handleBrowserNewTab(
  call: ForgeToolCall,
  args: BrowserNewTabArgs,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const { BROWSER_LIMITS } = await import('../../shared/types.js');
  const state = bm.getBrowserRuntimeState();
  const targetSession = state.sessions.find((s) => s.id === args.session_id);
  if (!targetSession) {
    return {
      result: {
        callId: call.callId, toolName: call.name, ok: false,
        errorCode: 'NOT_FOUND', errorMessage: `Session not found: ${args.session_id}`,
      },
    };
  }
  if (targetSession.tabIds.length >= BROWSER_LIMITS.MAX_TABS_PER_SESSION) {
    return {
      result: {
        callId: call.callId, toolName: call.name, ok: false,
        errorCode: 'BUDGET_EXCEEDED', errorMessage: 'Tab limit reached for this session.',
      },
    };
  }
  const tab = await bm.newBrowserTab(args.session_id, args.url);
  return {
    result: {
      callId: call.callId, toolName: call.name, ok: true,
      data: { tabId: tab.id, url: tab.url, sessionId: tab.sessionId },
    },
  };
}

async function handleBrowserTabAction(
  call: ForgeToolCall,
  action: 'close_tab' | 'switch_tab' | 'back' | 'forward' | 'reload' | 'stop' | 'screenshot' | 'get_console' | 'get_network',
  args: BrowserTabRefArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  try {
    switch (action) {
      case 'close_tab': {
        bm.closeBrowserTab(args.tab_id);
        return { result: { callId: call.callId, toolName: call.name, ok: true, data: { closed: args.tab_id } } };
      }
      case 'switch_tab': {
        bm.activateTab(args.tab_id);
        return { result: { callId: call.callId, toolName: call.name, ok: true, data: { activeTabId: args.tab_id } } };
      }
      case 'back': {
        bm.navigateBack(args.tab_id);
        return { result: { callId: call.callId, toolName: call.name, ok: true, data: { action: 'back', tabId: args.tab_id } } };
      }
      case 'forward': {
        bm.navigateForward(args.tab_id);
        return { result: { callId: call.callId, toolName: call.name, ok: true, data: { action: 'forward', tabId: args.tab_id } } };
      }
      case 'reload': {
        bm.reloadTab(args.tab_id);
        return { result: { callId: call.callId, toolName: call.name, ok: true, data: { action: 'reload', tabId: args.tab_id } } };
      }
      case 'stop': {
        bm.stopTab(args.tab_id);
        return { result: { callId: call.callId, toolName: call.name, ok: true, data: { action: 'stop', tabId: args.tab_id } } };
      }
      case 'screenshot': {
        const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
        if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
        const screenshotResult = await bm.agentScreenshot(ctrlResult.ctrl, args.tab_id);
        // Strip data-URI prefix — inject as ImageContent in the next model turn
        const DATA_URI_PREFIX = 'data:image/png;base64,';
        const base64Data = screenshotResult.dataUrl.startsWith(DATA_URI_PREFIX)
          ? screenshotResult.dataUrl.slice(DATA_URI_PREFIX.length)
          : screenshotResult.dataUrl;
        return {
          result: { callId: call.callId, toolName: call.name, ok: true, data: { width: screenshotResult.width, height: screenshotResult.height, url: screenshotResult.url, timestamp: screenshotResult.timestamp } },
          imageAttachment: { mimeType: 'image/png', data: base64Data },
        };
      }
      case 'get_console': {
        const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
        if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
        const consoleEntries = bm.agentGetConsole(ctrlResult.ctrl, args.tab_id);
        return { result: { callId: call.callId, toolName: call.name, ok: true, data: { entries: consoleEntries, tabId: args.tab_id } } };
      }
      case 'get_network': {
        const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
        if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
        const networkSummary = bm.agentGetNetworkSummary(ctrlResult.ctrl, args.tab_id);
        return { result: { callId: call.callId, toolName: call.name, ok: true, data: { requests: networkSummary, tabId: args.tab_id } } };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserOpenUrl(
  call: ForgeToolCall,
  args: BrowserOpenUrlArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    const normalizedUrl = bm.normalizeNavigationInput(args.url);
    await bm.agentOpenUrl(ctrl, args.tab_id, normalizedUrl);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, url: normalizedUrl } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserReadPage(
  call: ForgeToolCall,
  args: BrowserTabRefArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    const snapshot = await bm.agentReadPage(ctrl, args.tab_id);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: snapshot } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserFindText(
  call: ForgeToolCall,
  args: BrowserFindTextArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    const result = await bm.agentFindText(ctrl, args.tab_id, args.query);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { query: args.query, matchCount: result.count } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserClick(
  call: ForgeToolCall,
  args: BrowserClickArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    await bm.agentClick(ctrl, args.tab_id, args.ref);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, ref: args.ref } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserType(
  call: ForgeToolCall,
  args: BrowserTypeArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    await bm.agentType(ctrl, args.tab_id, args.text);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, charsTyped: args.text.length } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserFill(
  call: ForgeToolCall,
  args: BrowserFillArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    await bm.agentFill(ctrl, args.tab_id, args.ref, args.value);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, ref: args.ref } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserSelect(
  call: ForgeToolCall,
  args: BrowserSelectArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    await bm.agentSelect(ctrl, args.tab_id, args.ref, args.value);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, ref: args.ref, value: args.value } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserPressKey(
  call: ForgeToolCall,
  args: BrowserPressKeyArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    await bm.agentPressKey(ctrl, args.tab_id, args.key);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, key: args.key } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserScroll(
  call: ForgeToolCall,
  args: BrowserScrollArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    await bm.agentScroll(ctrl, args.tab_id, args.delta_x ?? 0, args.delta_y ?? 0);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, delta_x: args.delta_x ?? 0, delta_y: args.delta_y ?? 0 } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

// ── Browser Runtime V1.1 handlers ──────────────────────────────────────────

async function handleBrowserListProfiles(
  call: ForgeToolCall,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const profiles = bm.listBrowserProfilesPublic();
  return { result: { callId: call.callId, toolName: call.name, ok: true, data: { profiles, total: profiles.length } } };
}

async function handleBrowserCreateSession(
  call: ForgeToolCall,
  args: BrowserCreateSessionArgs,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  try {
    // Resolve profile
    let profileId = args.profile_id;
    if (!profileId) {
      const profiles = bm.listBrowserProfilesPublic();
      const def = profiles.find((p) => p.isDefault) ?? profiles[0];
      if (!def) {
        return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'NO_PROFILE', errorMessage: 'No browser profiles exist. Create a profile first in Browser Settings.' } };
      }
      profileId = def.id;
    }
    const session = await bm.createBrowserSession(profileId, args.name ? { name: args.name } : undefined);
    const tabId = session.activeTabId ?? session.tabIds[0] ?? null;
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { sessionId: session.id, tabId, profileId: session.profileId } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserUseSession(
  call: ForgeToolCall,
  args: BrowserUseSessionArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  try {
    const result = await bm.bootstrapAgentControl({
      requestId: ctx.requestId,
      conversationId: ctx.conversationId,
      agentRunId: ctx.requestId, // use requestId as agentRunId proxy
      ...(args.session_id !== undefined && { sessionId: args.session_id }),
      ...(args.tab_id !== undefined && { tabId: args.tab_id }),
      ...(args.purpose !== undefined && { purpose: args.purpose }),
    });
    if (!result.ok) {
      const codeMap: Record<string, string> = {
        policy_off: 'BROWSER_ACCESS_DENIED',
        policy_rejected: 'BROWSER_ACCESS_DENIED',
        session_error: 'SESSION_ERROR',
        no_profile: 'NO_PROFILE',
      };
      return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: codeMap[result.reason] ?? 'TOOL_ERROR', errorMessage: result.message } };
    }
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { sessionId: result.sessionId, tabId: result.tabId, agentControlEstablished: true, policyDecision: result.policyDecision } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserWaitFor(
  call: ForgeToolCall,
  args: BrowserWaitForArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const { BROWSER_LIMITS } = await import('../../shared/types.js');
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;

  const timeoutMs = Math.min(args.timeout_ms ?? 10_000, BROWSER_LIMITS.MAX_WAIT_FOR_MS);
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 500;

  try {
    let met = false;
    while (Date.now() < deadline && !met) {
      const snapshot = await bm.agentReadPage(ctrl, args.tab_id);
      switch (args.condition) {
        case 'page_load':
          met = true; // page was readable — it loaded
          break;
        case 'text_present':
          met = !!args.value && snapshot.text.includes(args.value);
          break;
        case 'text_absent':
          met = !args.value || !snapshot.text.includes(args.value);
          break;
        case 'url_matches':
          met = !!args.value && snapshot.url.includes(args.value);
          break;
        case 'url_equals':
          met = !!args.value && snapshot.url === args.value;
          break;
        case 'title_contains':
          met = !!args.value && snapshot.title.toLowerCase().includes(args.value.toLowerCase());
          break;
        case 'element_present':
          // value is a ref string — check if it exists in the element list
          met = !!args.value && snapshot.elements.some((el: { ref: string }) => el.ref === args.value);
          break;
        case 'element_absent':
          met = !args.value || !snapshot.elements.some((el: { ref: string }) => el.ref === args.value);
          break;
        case 'element_enabled': {
          // value is a ref string — check if element exists and is not disabled
          const target = args.value ? snapshot.elements.find((el: { ref: string; disabled?: boolean }) => el.ref === args.value) : null;
          met = !!target && target.disabled !== true;
          break;
        }
        case 'navigation_settled':
          // agentReadPage succeeding means the page content is stable
          // Additional check: URL should not be about:blank
          met = snapshot.url !== 'about:blank' && snapshot.url !== '';
          break;
        case 'network_quiet': {
          // Check if recent network activity has settled (no requests in last 500ms)
          const netSummary = bm.agentGetNetworkSummary(ctrl, args.tab_id);
          const since = Date.now() - 1000;
          met = netSummary.filter((r: { timestamp: number }) => r.timestamp > since).length === 0;
          break;
        }
      }
      if (!met) await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { met, condition: args.condition, timedOut: !met } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

// ── Browser Runtime V2.1 handlers (read-only, no agent control required) ───

async function handleIsBrowserOpen(
  call: ForgeToolCall,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const isOpen = bm.isBrowserWindowOpen();
  return { result: { callId: call.callId, toolName: call.name, ok: true, data: { isOpen } } };
}

async function handleGetBrowserStatus(
  call: ForgeToolCall,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const status = bm.getBrowserStatus();
  return { result: { callId: call.callId, toolName: call.name, ok: true, data: status } };
}

async function handleBrowserOpen(
  call: ForgeToolCall,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  try {
    const bm = await import('../browser/browser-manager.js');
    // Open/focus the browser window — this is a read-only UI action, no agent control needed.
    bm.requestShowBrowser();
    const isOpen = bm.isBrowserWindowOpen();
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { opened: true, alreadyOpen: isOpen } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

// ── Browser Runtime V3 handlers ───────────────────────────────────────────

/** Generic handler for single-ref actions (hover, double_click, focus, clear, scroll_into_view). */
async function handleBrowserRefAction(
  call: ForgeToolCall,
  action: 'hover' | 'double_click' | 'focus' | 'clear' | 'scroll_into_view',
  args: { tab_id: string; ref: string },
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    switch (action) {
      case 'hover':           await bm.agentHover(ctrl, args.tab_id, args.ref); break;
      case 'double_click':    await bm.agentDoubleClick(ctrl, args.tab_id, args.ref); break;
      case 'focus':           await bm.agentFocus(ctrl, args.tab_id, args.ref); break;
      case 'clear':           await bm.agentClear(ctrl, args.tab_id, args.ref); break;
      case 'scroll_into_view': await bm.agentScrollIntoView(ctrl, args.tab_id, args.ref); break;
    }
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, ref: args.ref, action } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserDrag(
  call: ForgeToolCall,
  args: BrowserDragArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    await bm.agentDrag(ctrl, args.tab_id, args.source_ref, args.target_ref);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, sourceRef: args.source_ref, targetRef: args.target_ref } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserCheckbox(
  call: ForgeToolCall,
  args: BrowserCheckboxArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    await bm.agentCheckbox(ctrl, args.tab_id, args.ref, args.checked);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, ref: args.ref, checked: args.checked } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserUploadFile(
  call: ForgeToolCall,
  args: BrowserUploadFileArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    // Security: file must be within the project root
    const path_ = await import('path');
    const resolvedPath = path_.resolve(args.file_path);
    if (!resolvedPath.startsWith(ctx.projectRoot)) {
      return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'ACCESS_DENIED', errorMessage: 'browser_upload_file: file must be within the project root' } };
    }
    const result = await bm.agentUploadFile(ctrl, args.tab_id, args.ref, resolvedPath);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, ref: args.ref, ...result } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.startsWith('BROWSER_UPLOAD_FAILED') ? 'UPLOAD_FAILED' : 'TOOL_ERROR';
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: code, errorMessage: msg } };
  }
}

async function handleBrowserGetMedia(
  call: ForgeToolCall,
  args: BrowserGetMediaArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    const media = await bm.agentGetMedia(ctrl, args.tab_id);
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, media, count: media.length } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserControlMedia(
  call: ForgeToolCall,
  args: BrowserControlMediaArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  const ctrl = ctrlResult.ctrl;
  try {
    const result = await bm.agentControlMedia(ctrl, args.tab_id, args.action as never, args.ref, args.value);
    return { result: { callId: call.callId, toolName: call.name, ok: result.ok, data: { tabId: args.tab_id, action: args.action, ...result } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

async function handleBrowserHandleDialog(
  call: ForgeToolCall,
  args: BrowserHandleDialogArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const bm = await import('../browser/browser-manager.js');
  const ctrlResult = await bm.resolveAgentBrowserTarget(ctx.requestId, ctx.conversationId);
  if (!ctrlResult.ctrl) return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'BROWSER_ACCESS_DENIED', errorMessage: ctrlResult.errorMessage } };
  try {
    const resolved = bm.resolvePendingDialog(args.tab_id, args.dialog_id, args.action, args.value);
    if (!resolved) {
      return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'DIALOG_NOT_FOUND', errorMessage: `No pending dialog with id ${args.dialog_id} in tab ${args.tab_id}` } };
    }
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { tabId: args.tab_id, dialogId: args.dialog_id, action: args.action } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'TOOL_ERROR', errorMessage: msg } };
  }
}

// ── Dev Process handlers ────────────────────────────────────────────────────

async function handleStartProjectProcess(
  call: ForgeToolCall,
  args: StartProjectProcessArgs,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const { startDevProcess, resolveDevProcessCwd } = await import('../commands/dev-process-manager.js');

  const cwdAbsolute = resolveDevProcessCwd(ctx.projectRoot, args.cwd_relative);
  if (!cwdAbsolute) {
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'PATH_TRAVERSAL', errorMessage: 'cwd_relative would escape the project root.' } };
  }

  try {
    const record = startDevProcess({
      executable: args.executable,
      args: args.args,
      cwdAbsolute,
      projectId: ctx.projectId,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      agentRunId: ctx.requestId,
      ...(args.purpose !== undefined && { purpose: args.purpose }),
    });
    return { result: { callId: call.callId, toolName: call.name, ok: true, data: { processId: record.id, state: record.state, detectedUrls: record.detectedUrls } } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'SPAWN_ERROR', errorMessage: msg } };
  }
}

async function handleListProjectProcesses(
  call: ForgeToolCall,
  ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const { listDevProcesses } = await import('../commands/dev-process-manager.js');
  const processes = listDevProcesses(ctx.projectId);
  return { result: { callId: call.callId, toolName: call.name, ok: true, data: { processes, total: processes.length } } };
}

async function handleReadProjectProcessOutput(
  call: ForgeToolCall,
  args: ReadProjectProcessOutputArgs,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const { readDevProcessOutput } = await import('../commands/dev-process-manager.js');
  const { found, output } = readDevProcessOutput(args.process_id);
  if (!found) {
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'NOT_FOUND', errorMessage: `No active process with id: ${args.process_id}` } };
  }
  return { result: { callId: call.callId, toolName: call.name, ok: true, data: { processId: args.process_id, output } } };
}

async function handleStopProjectProcess(
  call: ForgeToolCall,
  args: StopProjectProcessArgs,
  _ctx: ToolExecutionContext,
): Promise<Omit<ToolExecutionResult, 'durationMs'>> {
  const { stopDevProcess } = await import('../commands/dev-process-manager.js');
  const { found } = stopDevProcess(args.process_id);
  if (!found) {
    return { result: { callId: call.callId, toolName: call.name, ok: false, errorCode: 'NOT_FOUND', errorMessage: `No active process with id: ${args.process_id}` } };
  }
  return { result: { callId: call.callId, toolName: call.name, ok: true, data: { processId: args.process_id, stopped: true } } };
}
