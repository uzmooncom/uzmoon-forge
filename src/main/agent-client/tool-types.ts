/**
 * tool-types.ts — Forge agent tool definitions and runtime validators.
 *
 * Single source of truth for:
 * - Tool argument types
 * - Runtime validation (untrusted model input)
 * - Tool limit constants
 * - Provider-neutral tool definition serialization
 *
 * ProjectToolExecutor and AgentLoop import from here.
 * Provider adapters (client.ts) import tool definition serializers from here.
 */
import path from "path";
import type { ForgeToolCall } from "../../shared/types.js";

// ── Central limits ──────────────────────────────────────────────────────────

export const TOOL_LIMITS = {
  /** Max tool invocations per request before the loop is forcibly stopped */
  MAX_TOOL_STEPS_PER_REQUEST: 25,
  /** Max file name/path matches returned by search_files */
  MAX_SEARCH_RESULTS: 20,
  /** Max matches returned by search_code */
  MAX_CODE_SEARCH_RESULTS: 20,
  /** Max entries returned by list_directory */
  MAX_DIRECTORY_RESULTS: 100,
  /** Cumulative bytes the agent may read in one request */
  MAX_TOTAL_AGENT_READ_BYTES: 2 * 1024 * 1024,   // 2 MB
  /** Max bytes for a single file read (= MAX_CONTEXT_BYTES from eligibility) */
  MAX_SINGLE_FILE_READ_BYTES: 512 * 1024,          // 512 KB
  /** Max bytes a single tool result may contain before truncation */
  MAX_TOOL_RESULT_BYTES: 32 * 1024,                // 32 KB
  /** Max depth for list_directory recursive traversal */
  MAX_LIST_DEPTH: 5,
} as const;

// ── Tool argument types ──────────────────────────────────────────────────────

export interface ListDirectoryArgs {
  path?: string;
  depth?: number;
  limit?: number;
}

export interface SearchFilesArgs {
  query: string;
  limit?: number;
}

export interface SearchCodeArgs {
  query: string;
  limit?: number;
  caseSensitive?: boolean;
}

export interface ReadFileArgs {
  path: string;
}

export interface ReadFileRangeArgs {
  path: string;
  startLine: number;
  endLine: number;
}

export type KnownToolName =
  | "list_directory"
  | "search_files"
  | "search_code"
  | "read_file"
  | "read_file_range"
  | "run_command"
  | "list_project_commands"
  | "read_command_output"
  // ── Browser Runtime V1 ────────────────────────────────────────────
  | "browser_list_sessions"
  | "browser_new_tab"
  | "browser_close_tab"
  | "browser_switch_tab"
  | "browser_open_url"
  | "browser_back"
  | "browser_forward"
  | "browser_reload"
  | "browser_stop"
  | "browser_read_page"
  | "browser_find_text"
  | "browser_click"
  | "browser_type"
  | "browser_fill"
  | "browser_select"
  | "browser_press_key"
  | "browser_scroll"
  | "browser_screenshot"
  | "browser_get_console"
  | "browser_get_network_summary"
  // ── Browser Runtime V1.1 ──────────────────────────────────────────
  | "browser_list_profiles"
  | "browser_create_session"
  | "browser_use_session"
  | "browser_wait_for"
  // ── Browser Runtime V3 — Extended Interaction ────────────────────
  | "browser_hover"
  | "browser_double_click"
  | "browser_drag"
  | "browser_focus"
  | "browser_clear"
  | "browser_scroll_into_view"
  | "browser_checkbox"
  | "browser_upload_file"
  | "browser_get_media"
  | "browser_control_media"
  | "browser_handle_dialog"
  // ── Browser Runtime V2.1 (read-only + open) ───────────────────────
  | "is_browser_open"
  | "get_browser_status"
  | "browser_open"
  // ── Dev Process (Long-Running Project Processes) ──────────────────
  | "start_project_process"
  | "list_project_processes"
  | "read_project_process_output"
  | "stop_project_process";

export const KNOWN_TOOL_NAMES = new Set<string>([
  "list_directory",
  "search_files",
  "search_code",
  "read_file",
  "read_file_range",
  "run_command",
  "list_project_commands",
  "read_command_output",
  // Browser Runtime V1
  "browser_list_sessions",
  "browser_new_tab",
  "browser_close_tab",
  "browser_switch_tab",
  "browser_open_url",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_stop",
  "browser_read_page",
  "browser_find_text",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_select",
  "browser_press_key",
  "browser_scroll",
  "browser_screenshot",
  "browser_get_console",
  "browser_get_network_summary",
  // Browser Runtime V1.1
  "browser_list_profiles",
  "browser_create_session",
  "browser_use_session",
  "browser_wait_for",
  // Browser Runtime V3 — Extended Interaction
  "browser_hover",
  "browser_double_click",
  "browser_drag",
  "browser_focus",
  "browser_clear",
  "browser_scroll_into_view",
  "browser_checkbox",
  "browser_upload_file",
  "browser_get_media",
  "browser_control_media",
  "browser_handle_dialog",
  // Browser Runtime V2.1
  "is_browser_open",
  "get_browser_status",
  "browser_open",
  // Dev Process
  "start_project_process",
  "list_project_processes",
  "read_project_process_output",
  "stop_project_process",
]);

// ── Validation result ───────────────────────────────────────────────────────

export interface RunCommandArgs {
  executable: string;
  args: string[];
  cwdRelative: string;
  purpose?: string;
  timeoutMs?: number;
}

export interface ListProjectCommandsArgs {
  /** Optional filter: only return commands from a specific conversation */
  conversationId?: string;
  /** Optional filter: only return commands with this state */
  state?: string;
  /** Max results (default 20, max 100) */
  limit?: number;
}

export interface ReadCommandOutputArgs {
  /** The command ID returned by run_command */
  commandId: string;
  /** Byte offset to start reading from (default 0) */
  offsetBytes?: number;
  /** Max bytes to return (default 8192, max 32768) */
  limitBytes?: number;
}

export interface ValidationOk {
  ok: true;
  toolName: KnownToolName;
  args:
    | ListDirectoryArgs
    | SearchFilesArgs
    | SearchCodeArgs
    | ReadFileArgs
    | ReadFileRangeArgs
    | RunCommandArgs
    | ListProjectCommandsArgs
    | ReadCommandOutputArgs
    | BrowserListSessionsArgs
    | BrowserNewTabArgs
    | BrowserTabRefArgs
    | BrowserOpenUrlArgs
    | BrowserFindTextArgs
    | BrowserClickArgs
    | BrowserTypeArgs
    | BrowserFillArgs
    | BrowserSelectArgs
    | BrowserPressKeyArgs
    | BrowserScrollArgs
    // Browser Runtime V1.1
    | BrowserCreateSessionArgs
    | BrowserUseSessionArgs
    | BrowserWaitForArgs
    // Browser Runtime V3
    | BrowserHoverArgs
    | BrowserDoubleClickArgs
    | BrowserDragArgs
    | BrowserFocusArgs
    | BrowserClearArgs
    | BrowserScrollIntoViewArgs
    | BrowserCheckboxArgs
    | BrowserUploadFileArgs
    | BrowserGetMediaArgs
    | BrowserControlMediaArgs
    | BrowserHandleDialogArgs
    // Dev Process
    | StartProjectProcessArgs
    | ReadProjectProcessOutputArgs
    | StopProjectProcessArgs
    | Record<string, never>;
}

export interface ValidationError {
  ok: false;
  errorCode: string;
  errorMessage: string;
}

export type ValidationResult = ValidationOk | ValidationError;

// ── Runtime validators ──────────────────────────────────────────────────────

/**
 * Validate a tool call from the model.
 * Every field is validated — untrusted model input must not bypass security.
 */
export function validateToolCall(call: ForgeToolCall): ValidationResult {
  const { name, arguments: args } = call;

  if (!KNOWN_TOOL_NAMES.has(name)) {
    return {
      ok: false,
      errorCode: "UNKNOWN_TOOL",
      errorMessage: `Unknown tool: "${name}". Available: ${[...KNOWN_TOOL_NAMES].join(", ")}`,
    };
  }

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return {
      ok: false,
      errorCode: "INVALID_ARGUMENTS",
      errorMessage: "Tool arguments must be a JSON object",
    };
  }

  switch (name as KnownToolName) {
    case "list_directory":
      return validateListDirectory(args);
    case "search_files":
      return validateSearchFiles(args);
    case "search_code":
      return validateSearchCode(args);
    case "read_file":
      return validateReadFile(args);
    case "read_file_range":
      return validateReadFileRange(args);
    case "run_command":
      return validateRunCommand(args);
    case "list_project_commands":
      return validateListProjectCommands(args);
    case "read_command_output":
      return validateReadCommandOutput(args);
    // ── Browser Runtime V1 ──────────────────────────────────────────────
    case "browser_list_sessions":   return validateBrowserListSessions(args);
    case "browser_new_tab":         return validateBrowserNewTab(args);
    case "browser_close_tab":       return validateBrowserTabRef("browser_close_tab", args);
    case "browser_switch_tab":      return validateBrowserTabRef("browser_switch_tab", args);
    case "browser_open_url":        return validateBrowserOpenUrl(args);
    case "browser_back":            return validateBrowserTabRef("browser_back", args);
    case "browser_forward":         return validateBrowserTabRef("browser_forward", args);
    case "browser_reload":          return validateBrowserTabRef("browser_reload", args);
    case "browser_stop":            return validateBrowserTabRef("browser_stop", args);
    case "browser_read_page":       return validateBrowserTabRef("browser_read_page", args);
    case "browser_find_text":       return validateBrowserFindText(args);
    case "browser_click":           return validateBrowserClick(args);
    case "browser_type":            return validateBrowserType(args);
    case "browser_fill":            return validateBrowserFill(args);
    case "browser_select":          return validateBrowserSelect(args);
    case "browser_press_key":       return validateBrowserPressKey(args);
    case "browser_scroll":          return validateBrowserScroll(args);
    case "browser_screenshot":      return validateBrowserTabRef("browser_screenshot", args);
    case "browser_get_console":     return validateBrowserTabRef("browser_get_console", args);
    case "browser_get_network_summary": return validateBrowserTabRef("browser_get_network_summary", args);
    // ── Browser Runtime V1.1 ──────────────────────────────────────────
    case "browser_list_profiles":   return { ok: true, toolName: "browser_list_profiles", args: {} };
    case "browser_create_session":  return validateBrowserCreateSession(args);
    case "browser_use_session":     return validateBrowserUseSession(args);
    case "browser_wait_for":        return validateBrowserWaitFor(args);
    // ── Browser Runtime V3 — Extended Interaction ─────────────────────
    case "browser_hover":           return validateBrowserRefOnly("browser_hover", args);
    case "browser_double_click":    return validateBrowserRefOnly("browser_double_click", args);
    case "browser_drag":            return validateBrowserDrag(args);
    case "browser_focus":           return validateBrowserRefOnly("browser_focus", args);
    case "browser_clear":           return validateBrowserRefOnly("browser_clear", args);
    case "browser_scroll_into_view": return validateBrowserRefOnly("browser_scroll_into_view", args);
    case "browser_checkbox":        return validateBrowserCheckbox(args);
    case "browser_upload_file":     return validateBrowserUploadFile(args);
    case "browser_get_media":       return validateBrowserTabRef("browser_get_media", args);
    case "browser_control_media":   return validateBrowserControlMedia(args);
    case "browser_handle_dialog":   return validateBrowserHandleDialog(args);
    // ── Browser Runtime V2.1 ──────────────────────────────────────────
    case "is_browser_open":        return { ok: true, toolName: "is_browser_open", args: {} };
    case "get_browser_status":     return { ok: true, toolName: "get_browser_status", args: {} };
    case "browser_open":           return { ok: true, toolName: "browser_open", args: {} };
    // ── Dev Process ───────────────────────────────────────────────────
    case "start_project_process":        return validateStartProjectProcess(args);
    case "list_project_processes":       return { ok: true, toolName: "list_project_processes", args: {} };
    case "read_project_process_output":  return validateReadProjectProcessOutput(args);
    case "stop_project_process":         return validateStopProjectProcess(args);
  }
}

function validatePath(p: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (p === undefined || p === null) return { ok: true, value: "" };
  if (typeof p !== "string") return { ok: false, error: "path must be a string" };
  if (p.trim() === "") return { ok: true, value: "" };

  // Block absolute paths
  if (path.isAbsolute(p)) {
    return { ok: false, error: "Absolute paths are not allowed. Use a relative path from the project root." };
  }

  // Block obvious traversal
  const normalized = path.normalize(p);
  if (normalized.startsWith("..")) {
    return { ok: false, error: "Path traversal is not allowed." };
  }

  // Block Windows-style absolute paths forwarded as strings
  if (/^[A-Za-z]:[/\\]/.test(p)) {
    return { ok: false, error: "Absolute paths are not allowed." };
  }

  return { ok: true, value: p };
}

function validatePositiveInt(
  v: unknown,
  name: string,
  min: number,
  max: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: min };
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    return { ok: false, error: `${name} must be an integer` };
  }
  if (v < min) return { ok: false, error: `${name} must be >= ${min}` };
  if (v > max) return { ok: false, error: `${name} must be <= ${max}` };
  return { ok: true, value: v };
}

function validateListDirectory(args: Record<string, unknown>): ValidationResult {
  const pathResult = validatePath(args["path"]);
  if (!pathResult.ok) return { ok: false, errorCode: "INVALID_PATH", errorMessage: pathResult.error };

  const depthResult = validatePositiveInt(args["depth"], "depth", 1, TOOL_LIMITS.MAX_LIST_DEPTH);
  if (!depthResult.ok) return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: depthResult.error };

  const limitResult = validatePositiveInt(args["limit"], "limit", 1, TOOL_LIMITS.MAX_DIRECTORY_RESULTS);
  if (!limitResult.ok) return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: limitResult.error };

  const listDirArgs: ListDirectoryArgs = {};
  if (pathResult.value) listDirArgs.path = pathResult.value;
  if (args["depth"] !== undefined) listDirArgs.depth = depthResult.value;
  if (args["limit"] !== undefined) listDirArgs.limit = limitResult.value;
  return { ok: true, toolName: "list_directory", args: listDirArgs };
}

function validateSearchFiles(args: Record<string, unknown>): ValidationResult {
  const query = args["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "search_files requires a non-empty query string" };
  }
  if (query.length > 500) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "query must be 500 characters or fewer" };
  }

  const limitResult = validatePositiveInt(args["limit"], "limit", 1, TOOL_LIMITS.MAX_SEARCH_RESULTS);
  if (!limitResult.ok) return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: limitResult.error };

  const searchFilesArgs: SearchFilesArgs = { query: query.trim() };
  if (args["limit"] !== undefined) searchFilesArgs.limit = limitResult.value;
  return { ok: true, toolName: "search_files", args: searchFilesArgs };
}

function validateSearchCode(args: Record<string, unknown>): ValidationResult {
  const query = args["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "search_code requires a non-empty query string" };
  }
  if (query.length > 500) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "query must be 500 characters or fewer" };
  }

  const limitResult = validatePositiveInt(args["limit"], "limit", 1, TOOL_LIMITS.MAX_CODE_SEARCH_RESULTS);
  if (!limitResult.ok) return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: limitResult.error };

  const caseSensitive = args["caseSensitive"];
  if (caseSensitive !== undefined && typeof caseSensitive !== "boolean") {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "caseSensitive must be a boolean" };
  }

  const searchCodeArgs: SearchCodeArgs = { query: query.trim() };
  if (args["limit"] !== undefined) searchCodeArgs.limit = limitResult.value;
  if (typeof caseSensitive === "boolean") searchCodeArgs.caseSensitive = caseSensitive;
  return { ok: true, toolName: "search_code", args: searchCodeArgs };
}

function validateReadFile(args: Record<string, unknown>): ValidationResult {
  const pathResult = validatePath(args["path"]);
  if (!pathResult.ok) return { ok: false, errorCode: "INVALID_PATH", errorMessage: pathResult.error };
  if (!pathResult.value) {
    return { ok: false, errorCode: "INVALID_PATH", errorMessage: "read_file requires a path" };
  }

  return {
    ok: true,
    toolName: "read_file",
    args: { path: pathResult.value },
  };
}

function validateReadFileRange(args: Record<string, unknown>): ValidationResult {
  const pathResult = validatePath(args["path"]);
  if (!pathResult.ok) return { ok: false, errorCode: "INVALID_PATH", errorMessage: pathResult.error };
  if (!pathResult.value) {
    return { ok: false, errorCode: "INVALID_PATH", errorMessage: "read_file_range requires a path" };
  }

  const startResult = validatePositiveInt(args["startLine"], "startLine", 1, 1_000_000);
  if (!startResult.ok) return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: startResult.error };

  const endResult = validatePositiveInt(args["endLine"], "endLine", 1, 1_000_000);
  if (!endResult.ok) return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: endResult.error };

  if (endResult.value < startResult.value) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "endLine must be >= startLine" };
  }

  return {
    ok: true,
    toolName: "read_file_range",
    args: {
      path: pathResult.value,
      startLine: startResult.value,
      endLine: endResult.value,
    },
  };
}

// ── run_command validator ──────────────────────────────────────────────────

/**
 * Validate run_command arguments from model.
 * Strips shell operators and validates against COMMAND_LIMITS before handing off.
 */
function validateRunCommand(args: unknown): ValidationResult {
  if (typeof args !== "object" || args === null) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "run_command: args must be an object" };
  }
  const a = args as Record<string, unknown>;

  // executable — single token, no slashes for remote risk, no shell operators
  const executable = a["executable"];
  if (typeof executable !== "string" || executable.trim().length === 0) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "run_command: executable must be a non-empty string" };
  }
  const SHELL_OP_RE = /[|;&><`$(){}[\]*?\\]/;
  if (SHELL_OP_RE.test(executable)) {
    return { ok: false, errorCode: "SHELL_OPERATOR_REJECTED", errorMessage: "run_command: executable must not contain shell operators" };
  }

  // args — array of strings, each without shell operators
  const argList = a["args"];
  if (!Array.isArray(argList)) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "run_command: args must be an array" };
  }
  for (const item of argList) {
    if (typeof item !== "string") {
      return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "run_command: each arg must be a string" };
    }
  }

  // cwd_relative — string, no absolute path, no traversal
  const cwdRelative = a["cwd_relative"];
  if (typeof cwdRelative !== "string") {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "run_command: cwd_relative must be a string" };
  }
  if (typeof cwdRelative === "string" && (cwdRelative.startsWith("/") || cwdRelative.includes("\\"))) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "run_command: cwd_relative must be a relative path" };
  }

  // purpose — optional string
  const purpose = a["purpose"];
  if (purpose !== undefined && typeof purpose !== "string") {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "run_command: purpose must be a string" };
  }

  // timeout_ms — optional integer, bounded
  const timeoutMsRaw = a["timeout_ms"];
  let timeoutMs: number | undefined;
  if (timeoutMsRaw !== undefined) {
    if (typeof timeoutMsRaw !== "number" || !Number.isInteger(timeoutMsRaw)) {
      return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "run_command: timeout_ms must be an integer" };
    }
    // Clamp to allowed range
    const MAX_TIMEOUT = 300_000;
    const MIN_TIMEOUT = 1_000;
    timeoutMs = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, timeoutMsRaw));
  }

  const runArgs: RunCommandArgs = {
    executable: executable.trim(),
    args: argList as string[],
    cwdRelative: cwdRelative.trim(),
    ...(purpose !== undefined && { purpose: purpose as string }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  };

  return { ok: true, toolName: "run_command", args: runArgs };
}

// ── list_project_commands validator ───────────────────────────────────────

function validateListProjectCommands(args: Record<string, unknown>): ValidationResult {
  const conversationId = args["conversation_id"];
  if (conversationId !== undefined && typeof conversationId !== "string") {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "list_project_commands: conversation_id must be a string" };
  }

  const state = args["state"];
  if (state !== undefined && typeof state !== "string") {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "list_project_commands: state must be a string" };
  }

  let limit: number | undefined;
  const limitRaw = args["limit"];
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw)) {
      return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "list_project_commands: limit must be an integer" };
    }
    limit = Math.max(1, Math.min(100, limitRaw));
  }

  const lcArgs: ListProjectCommandsArgs = {
    ...(conversationId !== undefined && { conversationId: conversationId as string }),
    ...(state !== undefined && { state: state as string }),
    ...(limit !== undefined && { limit }),
  };

  return { ok: true, toolName: "list_project_commands", args: lcArgs };
}

// ── read_command_output validator ──────────────────────────────────────────

function validateReadCommandOutput(args: Record<string, unknown>): ValidationResult {
  const commandId = args["command_id"];
  if (typeof commandId !== "string" || commandId.trim().length === 0) {
    return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "read_command_output: command_id must be a non-empty string" };
  }

  let offsetBytes: number | undefined;
  const offsetRaw = args["offset_bytes"];
  if (offsetRaw !== undefined) {
    if (typeof offsetRaw !== "number" || !Number.isInteger(offsetRaw) || offsetRaw < 0) {
      return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "read_command_output: offset_bytes must be a non-negative integer" };
    }
    offsetBytes = offsetRaw;
  }

  let limitBytes: number | undefined;
  const limitRaw = args["limit_bytes"];
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1) {
      return { ok: false, errorCode: "INVALID_ARGUMENT", errorMessage: "read_command_output: limit_bytes must be a positive integer" };
    }
    limitBytes = Math.min(32768, limitRaw);
  }

  const rcArgs: ReadCommandOutputArgs = {
    commandId: commandId.trim(),
    ...(offsetBytes !== undefined && { offsetBytes }),
    ...(limitBytes !== undefined && { limitBytes }),
  };

  return { ok: true, toolName: "read_command_output", args: rcArgs };
}

// ── Provider tool definition serialization ──────────────────────────────────

/** OpenAI function/tool definition shape */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Anthropic tool definition shape */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const TOOL_DEFS: Array<{
  name: KnownToolName;
  description: string;
  parameters: Record<string, unknown>;
}> = [
  {
    name: "list_directory",
    description:
      "List the contents of a directory in the project. Default: project root. Returns file/directory names and relative paths. Never returns absolute paths.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from project root. Default: project root.",
        },
        depth: {
          type: "integer",
          description: "Recursion depth (1 = single level). Max 5.",
          minimum: 1,
          maximum: 5,
        },
        limit: {
          type: "integer",
          description: `Max entries to return. Max ${TOOL_LIMITS.MAX_DIRECTORY_RESULTS}.`,
          minimum: 1,
          maximum: TOOL_LIMITS.MAX_DIRECTORY_RESULTS,
        },
      },
      required: [],
    },
  },
  {
    name: "search_files",
    description:
      "Search project files by filename or relative path. Returns matching relative paths. Use to discover which files exist.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Filename or path fragment to search for (e.g. 'auth', 'login.ts').",
        },
        limit: {
          type: "integer",
          description: `Max results. Max ${TOOL_LIMITS.MAX_SEARCH_RESULTS}.`,
          minimum: 1,
          maximum: TOOL_LIMITS.MAX_SEARCH_RESULTS,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_code",
    description:
      "Search project file contents for a string. Returns file path, line number, and a small surrounding snippet. Results are clues — call read_file for complete understanding.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Literal string to search for (e.g. 'PrismaClient', 'createSession').",
        },
        limit: {
          type: "integer",
          description: `Max results. Max ${TOOL_LIMITS.MAX_CODE_SEARCH_RESULTS}.`,
          minimum: 1,
          maximum: TOOL_LIMITS.MAX_CODE_SEARCH_RESULTS,
        },
        caseSensitive: {
          type: "boolean",
          description: "If true, search is case-sensitive. Default: false.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the complete content of a project file. Creates an immutable snapshot that can serve as a base for Safe File Editing proposals. Required before proposing file modifications.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from project root (e.g. 'src/auth/login.ts').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file_range",
    description:
      "Read a specific line range from a project file. Useful for targeted inspection. NOTE: range reads cannot be used as Safe File Editing bases — call read_file for complete content if you intend to modify the file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from project root.",
        },
        startLine: {
          type: "integer",
          description: "First line to read (1-based, inclusive).",
          minimum: 1,
        },
        endLine: {
          type: "integer",
          description: "Last line to read (1-based, inclusive).",
          minimum: 1,
        },
      },
      required: ["path", "startLine", "endLine"],
    },
  },
  {
    name: "run_command",
    description:
      "Propose a safe terminal command for execution within the project directory. " +
      "The command is evaluated by a deterministic policy engine (no AI classifier). " +
      "High-risk commands pause for user approval; trusted commands run immediately. " +
      "Shell operators (|, &&, ;, >, <, $()) are NEVER allowed — pass a single executable with an explicit args list. " +
      "Use this to run tests, type-check, lint, build, or inspect package scripts. " +
      "Remote execution (curl, wget, npx, bunx) is blocked by policy. " +
      "Returns a CommandEvidenceRef when the command completes. " +
      "IMPORTANT: do not call run_command in a loop — wait for the result before continuing.",
    parameters: {
      type: "object",
      properties: {
        executable: {
          type: "string",
          description:
            "Executable name (e.g. 'pnpm', 'node', 'python3'). Must be a single token — no paths, no shell operators.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "Ordered argument list. Each element is a distinct argument — no shell quoting needed.",
        },
        cwd_relative: {
          type: "string",
          description:
            "Working directory relative to project root (e.g. '' for root, 'packages/api' for a workspace package). Must not escape the project root.",
        },
        purpose: {
          type: "string",
          description: "One-sentence explanation of why this command is needed. Shown to the user in the approval UI.",
        },
        timeout_ms: {
          type: "integer",
          description:
            "Optional timeout in milliseconds. Defaults to 60000 (60s). Maximum is 300000 (5min). Command is killed on timeout.",
          minimum: 1000,
          maximum: 300000,
        },
      },
      required: ["executable", "args", "cwd_relative"],
    },
  },
  {
    name: "list_project_commands",
    description:
      "List recent command executions for this project. " +
      "Use this to check the status of a previously proposed command, " +
      "or to review what commands have been run in this session. " +
      "Returns commandId, state, displayCommand, exitCode, and outputSummary for each entry.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          description: "Optional: filter to commands from a specific conversation.",
        },
        state: {
          type: "string",
          description: "Optional: filter by state (e.g. 'awaiting_approval', 'running', 'succeeded', 'failed').",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return (default 20, max 100).",
          minimum: 1,
          maximum: 100,
        },
      },
      required: [],
    },
  },
  {
    name: "read_command_output",
    description:
      "Read the captured stdout/stderr output of a completed or running command. " +
      "Output is ANSI-stripped and sanitized (secrets redacted). " +
      "Use offsetBytes + limitBytes to page through large outputs. " +
      "The commandId is returned by run_command or list_project_commands.",
    parameters: {
      type: "object",
      properties: {
        command_id: {
          type: "string",
          description: "The command ID to read output for.",
        },
        offset_bytes: {
          type: "integer",
          description: "Byte offset to start reading from (default 0).",
          minimum: 0,
        },
        limit_bytes: {
          type: "integer",
          description: "Max bytes to read (default 8192, max 32768).",
          minimum: 1,
          maximum: 32768,
        },
      },
      required: ["command_id"],
    },
  },
  // ── Browser Runtime V1 tool definitions ──────────────────────────────────
  {
    name: 'browser_list_sessions',
    description:
      'List active browser sessions (open browser windows). ' +
      'Returns session_id, profile name, number of tabs, and active tab URL for each session. ' +
      'Use this first to discover available sessions before using other browser tools.',
    parameters: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Optional: filter by browser profile ID.' },
      },
      required: [],
    },
  },
  {
    name: 'browser_new_tab',
    description:
      'Open a new tab in an existing browser session. ' +
      'Returns the new tab_id. The tab starts at about:blank or the given url.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session_id (from browser_list_sessions).' },
        url: { type: 'string', description: 'Optional initial URL.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close a browser tab by its tab_id.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id to close.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_switch_tab',
    description: 'Switch focus to a different tab within the same session.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id to switch to.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_open_url',
    description:
      'Navigate a browser tab to a URL. Only http/https URLs are permitted. ' +
      'Bare hostnames and search queries are also accepted.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id to navigate.' },
        url: { type: 'string', description: 'URL or search query.' },
      },
      required: ['tab_id', 'url'],
    },
  },
  {
    name: 'browser_back',
    description: 'Navigate back in a tab history.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_forward',
    description: 'Navigate forward in a tab history.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_reload',
    description: 'Reload the current page in a tab.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_stop',
    description: 'Stop the current page load in a tab.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_read_page',
    description:
      'Extract a bounded semantic snapshot of the current page. ' +
      'Returns visible text (up to 16KB) and interactive elements with stable ref IDs. ' +
      'Use refs with browser_click, browser_fill, browser_select. ' +
      'Refs become stale after any navigation — call browser_read_page again.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_find_text',
    description: 'Search for text on the current page. Returns match count.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id.' },
        query: { type: 'string', description: 'Text to search for.' },
      },
      required: ['tab_id', 'query'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an interactive element by its ref ID from browser_read_page. ' +
      'Refs are tied to the current navigation — read_page first if unsure.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id.' },
        ref: { type: 'string', description: 'Element ref (e.g. b1, l3, i2) from browser_read_page.' },
      },
      required: ['tab_id', 'ref'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the currently focused element.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id.' },
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['tab_id', 'text'],
    },
  },
  {
    name: 'browser_fill',
    description:
      'Set the value of an input or textarea field by ref ID. ' +
      'Prefer this over browser_type for form fields.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id.' },
        ref: { type: 'string', description: 'Input ref (e.g. i1) from browser_read_page.' },
        value: { type: 'string', description: 'Value to set.' },
      },
      required: ['tab_id', 'ref', 'value'],
    },
  },
  {
    name: 'browser_select',
    description: 'Select an option in a dropdown by ref ID.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id.' },
        ref: { type: 'string', description: 'Select ref (e.g. s1) from browser_read_page.' },
        value: { type: 'string', description: 'Option value to select.' },
      },
      required: ['tab_id', 'ref', 'value'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key in the current tab (Return, Escape, Tab, ArrowDown, etc.).',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id.' },
        key: { type: 'string', description: 'Key name (e.g. Return, Escape, Tab, ArrowDown).' },
      },
      required: ['tab_id', 'key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page by a number of pixels.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id.' },
        delta_x: { type: 'number', description: 'Horizontal scroll delta in pixels.' },
        delta_y: { type: 'number', description: 'Vertical scroll delta in pixels (positive = down).' },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a screenshot of the current tab as a base64 PNG data URL. ' +
      'Limited to 5 per agent run. Prefer browser_read_page for structure.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_get_console',
    description: 'Get recent browser console log entries for a tab. Returns up to 50 entries.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_get_network_summary',
    description:
      'Get a summary of recent network requests made by a tab. ' +
      'Returns URL (sensitive params redacted), method, HTTP status, resource type, timestamp.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string', description: 'The tab_id.' } }, required: ['tab_id'] },
  },
  // ── Browser Runtime V1.1 ────────────────────────────────────────────────
  {
    name: 'browser_list_profiles',
    description: 'List all browser profiles (persistent and private). Returns profile IDs, names, and agent access policy.',
    parameters: { type: 'object', properties: {} as Record<string, unknown>, required: [] as never[] },
  },
  {
    name: 'browser_create_session',
    description: 'Create a new browser session for a given profile. Returns the session ID and an initial tab ID ready for use.',
    parameters: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Profile ID (from browser_list_profiles). If omitted, uses the default persistent profile.' },
        name: { type: 'string', description: 'Optional human-readable session name.' },
      },
      required: [] as never[],
    },
  },
  {
    name: 'browser_use_session',
    description:
      'Establish browser agent control for this request. ' +
      'Resolves a suitable session (existing or new), requests UI to show the browser, and returns the active tab_id. ' +
      'ALWAYS call this before any browser interaction tool (browser_open_url, browser_click, etc.). ' +
      'If agent access requires approval, this tool waits for the user to approve or reject.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Preferred session ID. If omitted, Forge selects the best available session.' },
        tab_id: { type: 'string', description: 'Preferred tab ID within the session. If omitted, uses the active tab.' },
        purpose: { type: 'string', description: 'Brief description of what the agent intends to do (shown in approval UI).' },
      },
      required: [] as never[],
    },
  },
  {
    name: 'browser_wait_for',
    description:
      'Wait until a condition is true in the browser tab. ' +
      'Conditions: page_load, text_present, text_absent, url_matches, url_equals, title_contains, ' +
      'element_present, element_absent, element_enabled, navigation_settled, network_quiet. ' +
      'Bounded timeout — do not use arbitrary sleeps instead.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab_id.' },
        condition: { type: 'string', enum: ['page_load', 'text_present', 'text_absent', 'url_matches', 'url_equals', 'title_contains', 'element_present', 'element_absent', 'element_enabled', 'navigation_settled', 'network_quiet'], description: 'Condition to wait for.' },
        value: { type: 'string', description: 'Required for text_present, text_absent, url_matches, url_equals, title_contains, element_present/absent/enabled (element ref).' },
        timeout_ms: { type: 'number', description: 'Max wait in ms (default 10000, max 30000).' },
      },
      required: ['tab_id', 'condition'],
    },
  },
  // ── Browser Runtime V3 — Extended Interaction ────────────────────────────
  {
    name: 'browser_hover',
    description: 'Move the mouse over an element without clicking. Triggers hover/tooltip state. Use before browser_click when a hover menu must open first.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, ref: { type: 'string', description: 'Element ref from browser_read_page.' } }, required: ['tab_id', 'ref'] },
  },
  {
    name: 'browser_double_click',
    description: 'Double-click an element. Use for opening items in file managers, activating inline editors, or any UI that requires double-click.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, ref: { type: 'string', description: 'Element ref from browser_read_page.' } }, required: ['tab_id', 'ref'] },
  },
  {
    name: 'browser_drag',
    description: 'Drag an element from source_ref and drop it on target_ref. Uses synthetic drag events.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, source_ref: { type: 'string', description: 'Element ref to drag.' }, target_ref: { type: 'string', description: 'Element ref to drop onto.' } }, required: ['tab_id', 'source_ref', 'target_ref'] },
  },
  {
    name: 'browser_focus',
    description: 'Focus an element without clicking or typing. Use to trigger focus-dependent validation or expand a widget.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, ref: { type: 'string', description: 'Element ref from browser_read_page.' } }, required: ['tab_id', 'ref'] },
  },
  {
    name: 'browser_clear',
    description: 'Clear the value of an input or contenteditable element, leaving it empty. Use before browser_fill when the existing value must be replaced.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, ref: { type: 'string', description: 'Element ref from browser_read_page.' } }, required: ['tab_id', 'ref'] },
  },
  {
    name: 'browser_scroll_into_view',
    description: 'Scroll the page so that an element is visible in the viewport. Use before interacting with elements that are below/above the fold.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, ref: { type: 'string', description: 'Element ref from browser_read_page.' } }, required: ['tab_id', 'ref'] },
  },
  {
    name: 'browser_checkbox',
    description: 'Set the checked state of a checkbox or radio input. Use instead of browser_click for reliable boolean state control.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, ref: { type: 'string', description: 'Element ref from browser_read_page.' }, checked: { type: 'boolean', description: 'Target checked state (true = check, false = uncheck).' } }, required: ['tab_id', 'ref', 'checked'] },
  },
  {
    name: 'browser_upload_file',
    description: 'Upload a file to an <input type="file"> element. The file must be a project-scoped path returned from read_file or a FileRef. The file content is injected via DataTransfer — no file dialog appears.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, ref: { type: 'string', description: 'Input[type=file] element ref.' }, file_path: { type: 'string', description: 'Absolute project-scoped file path.' } }, required: ['tab_id', 'ref', 'file_path'] },
  },
  {
    name: 'browser_get_media',
    description: 'Enumerate all <video> and <audio> elements in the current tab. Returns ref, tag, src (redacted), paused, muted, volume, currentTime, duration, and visible status. Use before browser_control_media.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_control_media',
    description: 'Control a media element (video or audio). Actions: play, pause, mute, unmute, set_volume (value 0–1), seek (value = seconds), fullscreen_mute (mutes all). Omit ref to target the currently playing/audible media.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, action: { type: 'string', enum: ['play', 'pause', 'mute', 'unmute', 'set_volume', 'seek', 'fullscreen_mute'] }, ref: { type: 'string', description: 'Media element ref (optional — targets audible/playing if omitted).' }, value: { type: 'number', description: 'For set_volume (0–1) or seek (seconds).' } }, required: ['tab_id', 'action'] },
  },
  {
    name: 'browser_handle_dialog',
    description: 'Respond to a pending JS dialog (alert/confirm/prompt) intercepted in the browser tab. Call browser_read_page to see pending dialogs, then use this to accept or dismiss. For prompt dialogs, provide value.',
    parameters: { type: 'object', properties: { tab_id: { type: 'string' }, dialog_id: { type: 'string', description: 'Dialog ID from the pending dialog list.' }, action: { type: 'string', enum: ['accept', 'dismiss'] }, value: { type: 'string', description: 'For prompt dialogs: the value to submit.' } }, required: ['tab_id', 'dialog_id', 'action'] },
  },
  // ── Browser Runtime V2.1 ────────────────────────────────────────────────
  {
    name: 'is_browser_open',
    description:
      'Check whether Forge Browser is currently open. ' +
      'Returns { isOpen: boolean }. Does NOT require agent browser control. ' +
      'Use this to answer questions like "is the browser open?" without needing permissions.',
    parameters: { type: 'object', properties: {} as Record<string, unknown>, required: [] as never[] },
  },
  {
    name: 'get_browser_status',
    description:
      'Get a read-only snapshot of Forge Browser state: window open/closed, tab count, active URL/title, active profile name, agent control status. ' +
      'Does NOT require agent browser control. Use to answer state questions without requesting permissions.',
    parameters: { type: 'object', properties: {} as Record<string, unknown>, required: [] as never[] },
  },
  {
    name: 'browser_open',
    description:
      'Open or focus the Forge Browser window. ' +
      'If the browser is already open, brings it to front. ' +
      'If closed, creates it with the last-used session restored. ' +
      'Does NOT require agent browser control — this is a simple UI action like opening any application window. ' +
      'Use this when the user says "browser aç" or "open browser" before doing any navigation.',
    parameters: { type: 'object', properties: {} as Record<string, unknown>, required: [] as never[] },
  },
  // ── Dev Process (Long-Running Project Processes) ─────────────────────────
  {
    name: 'start_project_process',
    description:
      'Start a long-running project process (e.g. dev server: pnpm dev, npm run dev). ' +
      'The process stays alive after the agent run ends until explicitly stopped. ' +
      'Forge detects the localhost URL from output and reports it when ready. ' +
      'Do NOT use run_command for dev servers — use this tool instead.',
    parameters: {
      type: 'object',
      properties: {
        executable: { type: 'string', description: 'Executable to run (e.g. "pnpm", "npm", "bun").' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments (e.g. ["run", "dev"]).' },
        cwd_relative: { type: 'string', description: 'Working directory relative to project root.' },
        purpose: { type: 'string', description: 'What this process does (shown in UI).' },
      },
      required: ['executable', 'args'],
    },
  },
  {
    name: 'list_project_processes',
    description: 'List all running long-running project processes. Returns process IDs, state, detected URLs, and ready status.',
    parameters: { type: 'object', properties: {} as Record<string, unknown>, required: [] as never[] },
  },
  {
    name: 'read_project_process_output',
    description: 'Read the output buffer of a running project process. Returns bounded stdout/stderr text.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'Process ID (from start_project_process or list_project_processes).' },
      },
      required: ['process_id'],
    },
  },
  {
    name: 'stop_project_process',
    description: 'Stop a running project process by ID. Terminates the process tree cleanly.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'Process ID to stop.' },
      },
      required: ['process_id'],
    },
  },
] as Array<{ name: KnownToolName; description: string; parameters: Record<string, unknown> }>;


// ── Browser Runtime V1 arg interfaces ──────────────────────────────────────

export interface BrowserListSessionsArgs {
  profile_id?: string;
}

export interface BrowserNewTabArgs {
  session_id: string;
  url?: string;
}

export interface BrowserTabRefArgs {
  tab_id: string;
}

export interface BrowserOpenUrlArgs {
  tab_id: string;
  url: string;
}

export interface BrowserFindTextArgs {
  tab_id: string;
  query: string;
}

export interface BrowserClickArgs {
  tab_id: string;
  ref: string;
}

export interface BrowserTypeArgs {
  tab_id: string;
  text: string;
}

export interface BrowserFillArgs {
  tab_id: string;
  ref: string;
  value: string;
}

export interface BrowserSelectArgs {
  tab_id: string;
  ref: string;
  value: string;
}

export interface BrowserPressKeyArgs {
  tab_id: string;
  key: string;
}

export interface BrowserScrollArgs {
  tab_id: string;
  delta_x?: number;
  delta_y?: number;
}

// ── Browser Runtime V1.1 arg interfaces ────────────────────────────────────

export interface BrowserCreateSessionArgs {
  profile_id?: string;
  name?: string;
}

export interface BrowserUseSessionArgs {
  session_id?: string;
  tab_id?: string;
  purpose?: string;
}

/** Legacy 4-condition type kept for back-compat; new code uses BrowserWaitConditionExtended */
export type BrowserWaitCondition =
  | 'page_load'
  | 'text_present'
  | 'text_absent'
  | 'url_matches'
  | 'url_equals'
  | 'title_contains'
  | 'element_present'
  | 'element_absent'
  | 'element_enabled'
  | 'navigation_settled'
  | 'network_quiet';

export interface BrowserWaitForArgs {
  tab_id: string;
  condition: BrowserWaitCondition;
  value?: string;
  timeout_ms?: number;
}

// ── Browser Runtime V3 arg interfaces ──────────────────────────────────────

export interface BrowserHoverArgs {
  tab_id: string;
  ref: string;
}

export interface BrowserDoubleClickArgs {
  tab_id: string;
  ref: string;
}

export interface BrowserDragArgs {
  tab_id: string;
  source_ref: string;
  target_ref: string;
}

export interface BrowserFocusArgs {
  tab_id: string;
  ref: string;
}

export interface BrowserClearArgs {
  tab_id: string;
  ref: string;
}

export interface BrowserScrollIntoViewArgs {
  tab_id: string;
  ref: string;
}

export interface BrowserCheckboxArgs {
  tab_id: string;
  ref: string;
  checked: boolean;
}

export interface BrowserUploadFileArgs {
  tab_id: string;
  ref: string;
  /** Approved file path (project-scoped absolute path from FileRef) */
  file_path: string;
}

export interface BrowserGetMediaArgs {
  tab_id: string;
}

export type BrowserMediaAction = 'play' | 'pause' | 'mute' | 'unmute' | 'set_volume' | 'seek' | 'fullscreen_mute';

export interface BrowserControlMediaArgs {
  tab_id: string;
  action: BrowserMediaAction;
  /** Target media element ref (from browser_get_media). Omit to target playing/audible media. */
  ref?: string;
  /** For set_volume: 0.0–1.0 */
  value?: number;
}

export interface BrowserHandleDialogArgs {
  tab_id: string;
  dialog_id: string;
  action: 'accept' | 'dismiss';
  /** For prompt dialogs: the value to submit */
  value?: string;
}

// ── Dev Process arg interfaces ──────────────────────────────────────────────

export interface StartProjectProcessArgs {
  executable: string;
  args: string[];
  cwd_relative?: string;
  purpose?: string;
}

export interface ReadProjectProcessOutputArgs {
  process_id: string;
}

export interface StopProjectProcessArgs {
  process_id: string;
}

// ── Browser validators ─────────────────────────────────────────────────────

function validateBrowserListSessions(args: Record<string, unknown>): ValidationResult {
  const r: BrowserListSessionsArgs = {};
  if (args['profile_id'] !== undefined) {
    if (typeof args['profile_id'] !== 'string' || !args['profile_id']) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_list_sessions: profile_id must be a non-empty string' };
    }
    r.profile_id = args['profile_id'] as string;
  }
  return { ok: true, toolName: 'browser_list_sessions', args: r };
}

function validateBrowserNewTab(args: Record<string, unknown>): ValidationResult {
  if (typeof args['session_id'] !== 'string' || !args['session_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_new_tab: session_id must be a non-empty string' };
  }
  const r: BrowserNewTabArgs = { session_id: args['session_id'] as string };
  if (args['url'] !== undefined) {
    if (typeof args['url'] !== 'string') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_new_tab: url must be a string' };
    }
    r.url = args['url'] as string;
  }
  return { ok: true, toolName: 'browser_new_tab', args: r };
}

function validateBrowserTabRef(toolName: KnownToolName, args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: toolName + ': tab_id must be a non-empty string' };
  }
  const r: BrowserTabRefArgs = { tab_id: args['tab_id'] as string };
  return { ok: true, toolName, args: r };
}

function validateBrowserOpenUrl(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_open_url: tab_id must be a non-empty string' };
  }
  if (typeof args['url'] !== 'string' || !args['url']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_open_url: url must be a non-empty string' };
  }
  const r: BrowserOpenUrlArgs = { tab_id: args['tab_id'] as string, url: args['url'] as string };
  return { ok: true, toolName: 'browser_open_url', args: r };
}

function validateBrowserFindText(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_find_text: tab_id must be a non-empty string' };
  }
  if (typeof args['query'] !== 'string' || !args['query']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_find_text: query must be a non-empty string' };
  }
  const r: BrowserFindTextArgs = { tab_id: args['tab_id'] as string, query: args['query'] as string };
  return { ok: true, toolName: 'browser_find_text', args: r };
}

function validateBrowserClick(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_click: tab_id must be a non-empty string' };
  }
  if (typeof args['ref'] !== 'string' || !args['ref']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_click: ref must be a non-empty string' };
  }
  const r: BrowserClickArgs = { tab_id: args['tab_id'] as string, ref: args['ref'] as string };
  return { ok: true, toolName: 'browser_click', args: r };
}

function validateBrowserType(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_type: tab_id must be a non-empty string' };
  }
  if (typeof args['text'] !== 'string') {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_type: text must be a string' };
  }
  const r: BrowserTypeArgs = { tab_id: args['tab_id'] as string, text: args['text'] as string };
  return { ok: true, toolName: 'browser_type', args: r };
}

function validateBrowserFill(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_fill: tab_id must be a non-empty string' };
  }
  if (typeof args['ref'] !== 'string' || !args['ref']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_fill: ref must be a non-empty string' };
  }
  if (typeof args['value'] !== 'string') {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_fill: value must be a string' };
  }
  const r: BrowserFillArgs = { tab_id: args['tab_id'] as string, ref: args['ref'] as string, value: args['value'] as string };
  return { ok: true, toolName: 'browser_fill', args: r };
}

function validateBrowserSelect(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_select: tab_id must be a non-empty string' };
  }
  if (typeof args['ref'] !== 'string' || !args['ref']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_select: ref must be a non-empty string' };
  }
  if (typeof args['value'] !== 'string') {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_select: value must be a string' };
  }
  const r: BrowserSelectArgs = { tab_id: args['tab_id'] as string, ref: args['ref'] as string, value: args['value'] as string };
  return { ok: true, toolName: 'browser_select', args: r };
}

function validateBrowserPressKey(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_press_key: tab_id must be a non-empty string' };
  }
  if (typeof args['key'] !== 'string' || !args['key']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_press_key: key must be a non-empty string' };
  }
  const r: BrowserPressKeyArgs = { tab_id: args['tab_id'] as string, key: args['key'] as string };
  return { ok: true, toolName: 'browser_press_key', args: r };
}

function validateBrowserScroll(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_scroll: tab_id must be a non-empty string' };
  }
  const r: BrowserScrollArgs = { tab_id: args['tab_id'] as string };
  if (args['delta_x'] !== undefined) {
    if (typeof args['delta_x'] !== 'number') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_scroll: delta_x must be a number' };
    }
    r.delta_x = args['delta_x'] as number;
  }
  if (args['delta_y'] !== undefined) {
    if (typeof args['delta_y'] !== 'number') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_scroll: delta_y must be a number' };
    }
    r.delta_y = args['delta_y'] as number;
  }
  return { ok: true, toolName: 'browser_scroll', args: r };
}

/** Build OpenAI-format tool definitions */
// ── Browser Runtime V1.1 validators ───────────────────────────────────────

function validateBrowserCreateSession(args: Record<string, unknown>): ValidationResult {
  const r: BrowserCreateSessionArgs = {};
  if (args['profile_id'] !== undefined) {
    if (typeof args['profile_id'] !== 'string' || !args['profile_id']) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_create_session: profile_id must be a non-empty string' };
    }
    r.profile_id = args['profile_id'] as string;
  }
  if (args['name'] !== undefined) {
    if (typeof args['name'] !== 'string') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_create_session: name must be a string' };
    }
    r.name = args['name'] as string;
  }
  return { ok: true, toolName: 'browser_create_session', args: r };
}

function validateBrowserUseSession(args: Record<string, unknown>): ValidationResult {
  const r: BrowserUseSessionArgs = {};
  if (args['session_id'] !== undefined) {
    if (typeof args['session_id'] !== 'string' || !args['session_id']) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_use_session: session_id must be a non-empty string' };
    }
    r.session_id = args['session_id'] as string;
  }
  if (args['tab_id'] !== undefined) {
    if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_use_session: tab_id must be a non-empty string' };
    }
    r.tab_id = args['tab_id'] as string;
  }
  if (args['purpose'] !== undefined) {
    if (typeof args['purpose'] !== 'string') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_use_session: purpose must be a string' };
    }
    r.purpose = args['purpose'] as string;
  }
  return { ok: true, toolName: 'browser_use_session', args: r };
}

function validateBrowserWaitFor(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_wait_for: tab_id must be a non-empty string' };
  }
  const VALID_CONDITIONS: BrowserWaitCondition[] = ['page_load', 'text_present', 'text_absent', 'url_matches', 'url_equals', 'title_contains', 'element_present', 'element_absent', 'element_enabled', 'navigation_settled', 'network_quiet'];
  if (!VALID_CONDITIONS.includes(args['condition'] as BrowserWaitCondition)) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: `browser_wait_for: condition must be one of ${VALID_CONDITIONS.join(', ')}` };
  }
  const r: BrowserWaitForArgs = { tab_id: args['tab_id'] as string, condition: args['condition'] as BrowserWaitCondition };
  if (args['value'] !== undefined) {
    if (typeof args['value'] !== 'string') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_wait_for: value must be a string' };
    }
    r.value = args['value'] as string;
  }
  if (args['timeout_ms'] !== undefined) {
    if (typeof args['timeout_ms'] !== 'number' || args['timeout_ms'] <= 0) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_wait_for: timeout_ms must be a positive number' };
    }
    r.timeout_ms = args['timeout_ms'] as number;
  }
  return { ok: true, toolName: 'browser_wait_for', args: r };
}

// ── Browser Runtime V3 validators ─────────────────────────────────────────

/** Validates any tool that needs tab_id + ref only */
function validateBrowserRefOnly(toolName: KnownToolName, args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: `${toolName}: tab_id must be a non-empty string` };
  }
  if (typeof args['ref'] !== 'string' || !args['ref']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: `${toolName}: ref must be a non-empty string` };
  }
  return { ok: true, toolName, args: { tab_id: args['tab_id'] as string, ref: args['ref'] as string } };
}

function validateBrowserDrag(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_drag: tab_id must be a non-empty string' };
  }
  if (typeof args['source_ref'] !== 'string' || !args['source_ref']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_drag: source_ref must be a non-empty string' };
  }
  if (typeof args['target_ref'] !== 'string' || !args['target_ref']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_drag: target_ref must be a non-empty string' };
  }
  const r: BrowserDragArgs = { tab_id: args['tab_id'] as string, source_ref: args['source_ref'] as string, target_ref: args['target_ref'] as string };
  return { ok: true, toolName: 'browser_drag', args: r };
}

function validateBrowserCheckbox(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_checkbox: tab_id must be a non-empty string' };
  }
  if (typeof args['ref'] !== 'string' || !args['ref']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_checkbox: ref must be a non-empty string' };
  }
  if (typeof args['checked'] !== 'boolean') {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_checkbox: checked must be a boolean' };
  }
  const r: BrowserCheckboxArgs = { tab_id: args['tab_id'] as string, ref: args['ref'] as string, checked: args['checked'] as boolean };
  return { ok: true, toolName: 'browser_checkbox', args: r };
}

function validateBrowserUploadFile(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_upload_file: tab_id must be a non-empty string' };
  }
  if (typeof args['ref'] !== 'string' || !args['ref']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_upload_file: ref must be a non-empty string' };
  }
  if (typeof args['file_path'] !== 'string' || !args['file_path']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_upload_file: file_path must be a non-empty string' };
  }
  const r: BrowserUploadFileArgs = { tab_id: args['tab_id'] as string, ref: args['ref'] as string, file_path: args['file_path'] as string };
  return { ok: true, toolName: 'browser_upload_file', args: r };
}

const VALID_MEDIA_ACTIONS: BrowserMediaAction[] = ['play', 'pause', 'mute', 'unmute', 'set_volume', 'seek', 'fullscreen_mute'];

function validateBrowserControlMedia(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_control_media: tab_id must be a non-empty string' };
  }
  if (!VALID_MEDIA_ACTIONS.includes(args['action'] as BrowserMediaAction)) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: `browser_control_media: action must be one of ${VALID_MEDIA_ACTIONS.join(', ')}` };
  }
  const r: BrowserControlMediaArgs = { tab_id: args['tab_id'] as string, action: args['action'] as BrowserMediaAction };
  if (args['ref'] !== undefined) {
    if (typeof args['ref'] !== 'string') return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_control_media: ref must be a string' };
    r.ref = args['ref'] as string;
  }
  if (args['value'] !== undefined) {
    if (typeof args['value'] !== 'number') return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_control_media: value must be a number' };
    if ((r.action === 'set_volume') && (args['value'] as number < 0 || args['value'] as number > 1)) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_control_media: volume value must be between 0.0 and 1.0' };
    }
    r.value = args['value'] as number;
  }
  return { ok: true, toolName: 'browser_control_media', args: r };
}

function validateBrowserHandleDialog(args: Record<string, unknown>): ValidationResult {
  if (typeof args['tab_id'] !== 'string' || !args['tab_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_handle_dialog: tab_id must be a non-empty string' };
  }
  if (typeof args['dialog_id'] !== 'string' || !args['dialog_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_handle_dialog: dialog_id must be a non-empty string' };
  }
  if (args['action'] !== 'accept' && args['action'] !== 'dismiss') {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_handle_dialog: action must be "accept" or "dismiss"' };
  }
  const r: BrowserHandleDialogArgs = { tab_id: args['tab_id'] as string, dialog_id: args['dialog_id'] as string, action: args['action'] as 'accept' | 'dismiss' };
  if (args['value'] !== undefined) {
    if (typeof args['value'] !== 'string') return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'browser_handle_dialog: value must be a string' };
    r.value = args['value'] as string;
  }
  return { ok: true, toolName: 'browser_handle_dialog', args: r };
}

// ── Dev Process validators ──────────────────────────────────────────────────

function validateStartProjectProcess(args: Record<string, unknown>): ValidationResult {
  if (typeof args['executable'] !== 'string' || !args['executable']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'start_project_process: executable must be a non-empty string' };
  }
  if (!Array.isArray(args['args'])) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'start_project_process: args must be an array' };
  }
  const r: StartProjectProcessArgs = { executable: args['executable'] as string, args: args['args'] as string[] };
  if (args['cwd_relative'] !== undefined) {
    if (typeof args['cwd_relative'] !== 'string') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'start_project_process: cwd_relative must be a string' };
    }
    r.cwd_relative = args['cwd_relative'] as string;
  }
  if (args['purpose'] !== undefined) {
    if (typeof args['purpose'] !== 'string') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'start_project_process: purpose must be a string' };
    }
    r.purpose = args['purpose'] as string;
  }
  return { ok: true, toolName: 'start_project_process', args: r };
}

function validateReadProjectProcessOutput(args: Record<string, unknown>): ValidationResult {
  if (typeof args['process_id'] !== 'string' || !args['process_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'read_project_process_output: process_id must be a non-empty string' };
  }
  const r: ReadProjectProcessOutputArgs = { process_id: args['process_id'] as string };
  return { ok: true, toolName: 'read_project_process_output', args: r };
}

function validateStopProjectProcess(args: Record<string, unknown>): ValidationResult {
  if (typeof args['process_id'] !== 'string' || !args['process_id']) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT', errorMessage: 'stop_project_process: process_id must be a non-empty string' };
  }
  const r: StopProjectProcessArgs = { process_id: args['process_id'] as string };
  return { ok: true, toolName: 'stop_project_process', args: r };
}

export function buildOpenAIToolDefs(): OpenAIToolDef[] {
  return TOOL_DEFS.map((def) => ({
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  }));
}

/** Build Anthropic-format tool definitions */
export function buildAnthropicToolDefs(): AnthropicToolDef[] {
  return TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: def.parameters,
  }));
}