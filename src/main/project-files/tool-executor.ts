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