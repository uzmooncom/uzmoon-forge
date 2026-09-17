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
  | "run_command";

export const KNOWN_TOOL_NAMES = new Set<string>([
  "list_directory",
  "search_files",
  "search_code",
  "read_file",
  "read_file_range",
  "run_command",
]);

// ── Validation result ───────────────────────────────────────────────────────

export interface RunCommandArgs {
  executable: string;
  args: string[];
  cwdRelative: string;
  purpose?: string;
  timeoutMs?: number;
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
    | RunCommandArgs;
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
];

/** Build OpenAI-format tool definitions */
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