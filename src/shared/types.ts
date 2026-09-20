// ── Project ───────────────────────────────────────────────────────────────

/** Directory availability status checked at open time */
export type DirectoryStatus = "ok" | "missing" | "unknown";

/** Canonical project domain model */
export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Absolute normalized path to the working directory */
  workingDirectory: string;
  /** AgentProfile id to default for new conversations in this project */
  defaultAgentProfileId?: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  /** true = removed from Forge UI but kept for history integrity */
  archived?: boolean;
}

export type Protocol = "openai" | "anthropic";

/** @deprecated Use AgentProfile. Kept for one-time migration only. */
export interface AgentConfig {
  id: string;
  name: string;
  endpoint: string;
  protocol: Protocol;
  model: string;
  apiKeyHeader?: string;
  timeoutMs?: number;
  capabilities?: ProviderCapabilities;
}

/** Canonical per-agent connection profile. */
export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  endpoint: string;
  protocol: Protocol;
  model: string;
  /** Custom API key header (overrides protocol default) */
  apiKeyHeader?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Whether this is the global default profile */
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  lastConnectionStatus?: ConnectionStatus;
  lastConnectionTestAt?: number;
  /** true if removed but history references remain */
  archived?: boolean;
  /**
   * Explicit provider capability override. When set, beats all model-name heuristics.
   * Unknown custom endpoints without this field default to all-false (safe).
   */
  capabilities?: ProviderCapabilities;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "auth_failed"
  | "unreachable"
  | "invalid_response"
  | "timeout"
  | "model_unavailable"
  | "error";

export interface ConnectionTestResult {
  status: ConnectionStatus;
  message: string;
}

export type MessageRole = "user" | "assistant" | "error";

export interface Attachment {
  id: string;
  messageId: string;
  conversationId: string;
  mimeType: string;
  filename: string;
  localPath: string;
  size: number;
  width?: number;
  height?: number;
}

/** Attachment data passed from renderer to main for saving */
export interface AttachmentInput {
  /** base64-encoded file data */
  data: string;
  mimeType: string;
  filename: string;
  size: number;
  width?: number;
  height?: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  model?: string;
  durationMs?: number;
  /** true if this is an error message */
  isError?: boolean;
  /** attachment metadata (stored separately, joined on load) */
  attachments?: Attachment[];
  /** message being replied to */
  replyToMessageId?: string;
  /** Which AgentProfile produced this assistant message */
  agentProfileId?: string;
  /** Snapshot of agent name at time of generation (survives rename/delete) */
  agentNameSnapshot?: string;
  /** Snapshot of model at time of generation */
  modelSnapshot?: string;
  /** Project file snapshots attached to this message as context */
  contextRefs?: ContextRef[];
  /** The QueueManager requestId that produced this assistant message (for invariant dedup) */
  requestId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinnedAt?: number;
  archivedAt?: number;
  parentConversationId?: string;
  branchedFromMessageId?: string;
  /** The AgentProfile selected as default for this conversation */
  defaultAgentProfileId?: string;
  /**
   * If set: this conversation belongs to a Project.
   * If null/undefined: this is a Global Chat conversation.
   */
  projectId?: string;
}

export interface SendMessageRequest {
  conversationId: string;
  content: string;
  /** attachment IDs already saved to disk */
  attachmentIds?: string[];
  /** message being quoted/replied to */
  replyToMessageId?: string;
  /**
   * If set: new conversations created for this message will be scoped to this project.
   * Ignored if the conversation already exists (its existing projectId is used instead).
   */
  projectId?: string;
}

export interface SendMessageResponse {
  message: ChatMessage;
}

export interface AppState {
  onboardingComplete: boolean;
  /** @deprecated use defaultAgentProfileId */
  agentConfigId?: string | null;
  /** Global default AgentProfile id */
  defaultAgentProfileId: string | null;
}

// ── Message Queue ──────────────────────────────────────────────────────────

export type QueueItemStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

export interface QueueItem {
  id: string;
  conversationId: string;
  /** The persisted user message ID (after insertion) */
  messageId: string;
  content: string;
  attachmentIds: string[];
  replyToMessageId?: string;
  status: QueueItemStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  attemptCount: number;
  lastError?: string;
  /** Agent profile captured at enqueue time — immutable after enqueue */
  targetAgentProfileId: string;
  /** Project file context refs captured at enqueue time — immutable */
  contextRefs?: ContextRef[];
  /**
   * Execution owner — when set to "task", the QueueManager skips normal AgentRun
   * and delegates execution to the TaskManager. Exactly one owner per user request.
   */
  executionOwner?: "task";
  // ── Task metadata (optional — only set for task-step queue entries) ──
  /** Task this queue entry belongs to (task steps only) */
  taskId?: string;
  /** Step ID within the task plan (task steps only) */
  stepId?: string;
  /** Plan version at dispatch time */
  planVersion?: number;
  /** Step attempt number (1-based) */
  stepAttempt?: number;
}

/**
 * Snapshot of an actively-running (or just-completed) AgentRun that the renderer
 * uses to reconstruct transient streaming UI when mounting mid-run.
 * Only populated while a run is in progress; null means idle.
 *
 * V17: extended with agentRunId, state, waitingForHuman, approvalPending
 * so the renderer can derive ALL display booleans from this single snapshot.
 */
export interface ConvRuntimeState {
  conversationId: string;
  streamId: string;
  requestId: string;
  /** V17: canonical run identity for late-event firewall validation */
  agentRunId: string;
  /** V17: explicit state for UI derivation — no independent booleans needed */
  state: AgentRunState;
  agentProfileId: string;
  agentNameSnapshot: string;
  modelSnapshot: string;
  startedAt: number;
  /** Live tool activity accumulated so far — for re-constructing StreamingBubble */
  toolActivity: Array<{
    callId: string;
    name: string;
    args: Record<string, unknown>;
    startedAt: number;
    completedAt?: number;
    result?: string;
    durationMs?: number;
  }>;
  /** How many full-file agent reads have occurred so far */
  exploredCount: number;
  /** Monotonic revision counter — renderer ignores hydration older than current local revision */
  revision: number;
  /** V17: true when agent is waiting for human intervention (CAPTCHA/MFA/etc.) */
  waitingForHuman: boolean;
  /** V17: human-required reason if waitingForHuman is true */
  humanRequiredReason?: string;
  /** V17: true when a browser approval is pending for this run */
  approvalPending: boolean;
  /** V17: queue position (0 = currently running, >0 = waiting) */
  queuePosition: number;
}

/** What the renderer receives about a conversation's queue */
export interface ConvQueueState {
  conversationId: string;
  items: QueueItem[];
  /** Whether the queue is paused (after stop or failure) */
  paused: boolean;
}

/** IPC channel names */
export const IPC = {
  // Agent profiles (multi-profile)
  PROFILE_LIST: "profile:list",
  PROFILE_SAVE: "profile:save",
  PROFILE_GET: "profile:get",
  PROFILE_DELETE: "profile:delete",
  PROFILE_SET_DEFAULT: "profile:setDefault",
  PROFILE_UPDATE_STATUS: "profile:updateStatus",

  // Legacy single-agent config (kept for migration path only)
  CONFIG_SAVE: "config:save",
  CONFIG_GET: "config:get",
  CONFIG_DELETE: "config:delete",

  // Credentials
  SECRET_SET: "secret:set",
  SECRET_HAS: "secret:has",
  SECRET_DELETE: "secret:delete",

  // Connection test
  TEST_CONNECTION: "agent:testConnection",

  // Chat (direct send path is now enqueue)
  // sendMessage req now includes targetAgentProfileId
  CHAT_SEND: "chat:send",
  CHAT_STREAM_START: "chat:streamStart",
  CHAT_STREAM_CHUNK: "chat:streamChunk",
  CHAT_STREAM_END: "chat:streamEnd",
  CHAT_STREAM_ERROR: "chat:streamError",
  CHAT_CANCEL: "chat:cancel",
  /** Pushed from main when a tool call starts during agent loop */
  CHAT_STREAM_TOOL_START: "chat:streamToolStart",
  /** Pushed from main when a tool call completes during agent loop */
  CHAT_STREAM_TOOL_END: "chat:streamToolEnd",
  /** Pushed from main with intermediate (non-terminal) turn text — transient, never persisted */
  CHAT_STREAM_ACTIVITY_TEXT: "chat:streamActivityText",

  // Queue management
  /** Renderer invokes this on mount/conv-switch to hydrate active run state */
  RUNTIME_STATE_GET: "runtime:stateGet",

  QUEUE_GET: "queue:get",
  QUEUE_EDIT: "queue:edit",
  QUEUE_REMOVE: "queue:remove",
  QUEUE_REORDER: "queue:reorder",
  QUEUE_RESUME: "queue:resume",
  QUEUE_CLEAR: "queue:clear",
  QUEUE_STATE: "queue:state", // push from main → renderer

  // Conversations
  CONV_LIST: "conv:list",
  CONV_GET: "conv:get",
  CONV_CREATE: "conv:create",
  CONV_UPDATE: "conv:update",
  CONV_DELETE: "conv:delete",
  CONV_SEARCH: "conv:search",
  CONV_EXPORT: "conv:export",
  CONV_BRANCH: "conv:branch",

  // Messages per conversation
  CONV_MESSAGES: "conv:messages",
  MSG_SEARCH: "msg:search",

  // Attachments
  ATTACH_SAVE: "attach:save",
  ATTACH_READ: "attach:read",
  ATTACH_DELETE: "attach:delete",

  // App state
  APP_STATE_GET: "appState:get",
  APP_STATE_SET: "appState:set",

  // Projects
  PROJECT_LIST: "project:list",
  PROJECT_GET: "project:get",
  PROJECT_CREATE: "project:create",
  PROJECT_UPDATE: "project:update",
  PROJECT_REMOVE: "project:remove",
  PROJECT_VALIDATE_DIR: "project:validateDir",
  PROJECT_PICK_DIR: "project:pickDir",
  PROJECT_REVEAL_DIR: "project:revealDir",

  // Test-only: fake provider checkpoint control
  // Only active when FORGE_TEST_PROVIDER=fake
  TEST_CHECKPOINT_RELEASE: "test:checkpointRelease",
  TEST_CHECKPOINT_WAIT: "test:checkpointWait",
} as const;

/** Extended send request including per-message agent target */
export interface SendMessageWithProfileRequest {
  conversationId: string;
  content: string;
  attachmentIds?: string[];
  replyToMessageId?: string;
  /** Profile to use for this message. Defaults to conversation/global default. */
  targetAgentProfileId?: string;
}

// ── Project File System (V0.2) ─────────────────────────────────────────────

/** A single entry returned from a directory listing */
export interface ProjectFileEntry {
  name: string;
  /** Path relative to project workingDirectory, using forward slashes */
  relativePath: string;
  kind: "file" | "directory";
  extension?: string;
  size?: number;
  modifiedAt?: number;
  /** true if the entry is a symbolic link */
  isSymlink?: boolean;
  /** true if excluded by ignore rules */
  isIgnored?: boolean;
  /** true if likely contains secrets */
  isSensitive?: boolean;
}

/** A captured snapshot of a project file or line range, stored at enqueue time */
export interface ContextRef {
  /** Unique id for this ref */
  id: string;
  projectId: string;
  relativePath: string;
  /** 1-based start line (undefined = whole file) */
  lineStart?: number;
  /** 1-based end line (undefined = whole file) */
  lineEnd?: number;
  capturedAt: number;
  /** Byte size of the captured content */
  size: number;
  /** Detected language / mime */
  language: string;
  /** Absolute path inside app dataDir — NOT inside the project folder */
  snapshotPath: string;
  /** SHA-256 hex digest of the captured content — for integrity verification */
  contentHash: string;
}

/** UI representation of a staged context item in the composer */
export interface ContextChip {
  id: string;
  projectId: string;
  relativePath: string;
  displayName: string;
  lineStart?: number;
  lineEnd?: number;
  /** Estimated byte size */
  size: number;
  language: string;
  status: "ready" | "sensitive" | "too_large" | "missing" | "unsupported";
}

/** Result of a directory listing call */
export interface DirListResult {
  ok: true;
  entries: ProjectFileEntry[];
}
export interface DirListError {
  ok: false;
  error: string;
}

/** Result of a file read call */
export interface FileReadResult {
  ok: true;
  content: string;
  language: string;
  size: number;
  modifiedAt?: number;
  truncated?: boolean;
  lineCount?: number;
  /** true if file exceeded MAX_FILE_SIZE_BYTES but was still partially readable */
  tooLarge?: boolean;
}
export interface FileReadError {
  ok: false;
  error: string;
  /** true when file is binary */
  isBinary?: boolean;
  /** true when file is too large */
  tooLarge?: boolean;
  /** true when file is sensitive */
  isSensitive?: boolean;
}

/** Result of a snapshot capture */
export interface SnapshotResult {
  ok: true;
  ref: ContextRef;
  /** true if a warning should be shown (sensitive) */
  isSensitive?: boolean;
}
export interface SnapshotError {
  ok: false;
  error: string;
  isSensitive?: boolean;
}

/** File metadata index status */
export interface FileIndexStatus {
  projectId: string;
  state: "idle" | "indexing" | "ready" | "error";
  fileCount?: number;
  lastIndexedAt?: number;
  error?: string;
}

// Extend IPC with project file channels
export const PROJECT_FILE_IPC = {
  PROJECT_DIR_LIST: "project:dirList",
  PROJECT_FILE_READ: "project:fileRead",
  PROJECT_FILE_SNAPSHOT: "project:fileSnapshot",
  PROJECT_FILE_SEARCH: "project:fileSearch",
  PROJECT_INDEX_STATUS: "project:indexStatus",
  PROJECT_INDEX_BUILD: "project:indexBuild",
  PROJECT_SNAPSHOT_READ: "project:snapshotRead",
  PROJECT_FOLDER_CONTEXT_PREVIEW: "project:folderContextPreview",
} as const;

/** Extended send request that can carry project context refs */
export interface SendMessageWithContextRequest extends SendMessageRequest {
  /** Staged context refs to capture at enqueue time */
  stagedContextRefs?: Array<{
    projectId: string;
    relativePath: string;
    lineStart?: number;
    lineEnd?: number;
  }>;
}

// ── Safe File Editing (V0.3) ─────────────────────────────────────────────

/**
 * Status of a single file edit within a proposal.
 * - ready            — base snapshot verified, can be applied
 * - needs_context    — no full-file ContextRef found; user must add it
 * - ambiguous_context — multiple matching ContextRefs; user must disambiguate
 * - stale            — target file changed since proposal was generated
 * - applied          — already applied to disk
 * - rejected         — user rejected this specific file edit
 * - failed           — apply failed (I/O error, preflight failure)
 * - missing          — proposal target resource file is gone
 */
export type FileEditStatus =
  | "ready"
  | "needs_context"
  | "ambiguous_context"
  | "stale"
  | "applied"
  | "rejected"
  | "failed"
  | "missing";

/** One file modification within an EditProposal */
export interface FileEdit {
  id: string;
  proposalId: string;
  /** Relative path from project root */
  relativePath: string;
  /** Absolute path to the resource file holding proposed content (dataDir/proposals/...) */
  targetResourcePath: string;
  /** SHA-256 hash of the proposed content as stored in targetResourcePath */
  targetContentHash: string;
  /** ContextRef.id of the verified base snapshot (set when status=ready) */
  baseSnapshotId?: string;
  /** SHA-256 of base file content at proposal time (from ContextRef.contentHash) */
  baseContentHash?: string;
  status: FileEditStatus;
  /** Human-readable reason for the current status (non-ready states) */
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Overall status of an EditProposal.
 * - draft             — being assembled (transient, never persisted durably)
 * - ready             — all file edits are ready or rejected; can be applied
 * - needs_context     — at least one edit is needs_context
 * - ambiguous_context — at least one edit is ambiguous_context
 * - partiallyApplied  — some applied, some not yet
 * - applied           — all selected edits applied
 * - rejected          — user rejected the whole proposal
 * - stale             — one or more target files changed
 * - failed            — apply failed
 * - cancelled         — conversation deleted or otherwise invalidated
 */
export type EditProposalStatus =
  | "draft"
  | "ready"
  | "needs_context"
  | "ambiguous_context"
  | "partiallyApplied"
  | "applied"
  | "rejected"
  | "stale"
  | "failed"
  | "cancelled";

/** An AI-generated proposal to edit one or more files */
export interface EditProposal {
  id: string;
  conversationId: string;
  /** The assistant ChatMessage.id that contained the proposal fence */
  messageId: string;
  projectId: string;
  status: EditProposalStatus;
  /** Short summary from the model's proposal */
  summary: string;
  /** Longer explanation from the model's proposal */
  explanation?: string;
  /** The raw JSON fence block (stripped from ChatMessage.content) */
  rawProposalJson: string;
  /** Individual file edits */
  fileEdits: FileEdit[];
  createdAt: number;
  updatedAt: number;
}

/** One successful apply of a FileEdit to disk */
export interface AppliedEdit {
  id: string;
  proposalId: string;
  fileEditId: string;
  conversationId: string;
  projectId: string;
  relativePath: string;
  /** Absolute path to the backup resource in dataDir/backups/ */
  backupResourcePath: string;
  /** SHA-256 hash of the backup (original) content */
  backupContentHash: string;
  /** SHA-256 hash of the content that was written */
  appliedContentHash: string;
  appliedAt: number;
  /** Set when the edit was undone */
  undoneAt?: number;
}

/**
 * Write journal entry — tracks in-flight atomic temp files.
 * Temp files live in the project directory (same parent dir as target)
 * so fs.renameSync can be atomic. Journal lives in dataDir.
 */
export interface WriteJournalEntry {
  id: string;
  projectId: string;
  /** Path relative to project root, e.g. "src/.forge-tmp-a1b2c3" */
  tempRelativePath: string;
  /** Path relative to project root, e.g. "src/auth.ts" */
  targetRelativePath: string;
  createdAt: number;
}

/** Preflight check result for a single file edit */
export interface PreflightResult {
  fileEditId: string;
  relativePath: string;
  ok: boolean;
  /** Why preflight failed (if ok=false) */
  reason?: string;
}

/** Result of APPLY_SELECTED */
export interface ApplyResult {
  ok: boolean;
  /** Applied edit IDs for successful files */
  appliedEditIds?: string[];
  /** Per-file preflight failures (if any) */
  preflightFailures?: PreflightResult[];
  error?: string;
}

/** IPC channels for V0.3 file editing */
export const EDIT_IPC = {
  /** Get full proposal by id */
  PROPOSAL_GET: "proposal:get",
  /** List proposals for a conversation */
  PROPOSAL_LIST: "proposal:list",
  /** Reject a proposal (or specific fileEditIds within it) */
  PROPOSAL_REJECT: "proposal:reject",
  /** Read the current content of a proposal target resource (for diff display) */
  PROPOSAL_READ_TARGET: "proposal:readTarget",
  /** Preflight check without writing */
  PREFLIGHT_CHECK: "edit:preflightCheck",
  /** Apply selected file edits */
  APPLY_SELECTED: "edit:applySelected",
  /** Undo an applied edit */
  UNDO_APPLY: "edit:undoApply",
  /** List applied edit history for a project */
  EDIT_HISTORY_LIST: "edit:historyList",
  /** Push from main when a proposal's status changes */
  PROPOSAL_UPDATE: "proposal:update",
} as const;

/** Folder context preview result */
export interface FolderContextPreview {
  ok: true;
  relativePath: string;
  includedFiles: ProjectFileEntry[];
  skippedIgnored: number;
  skippedBinary: number;
  skippedSensitive: number;
  skippedTooLarge: number;
  totalSize: number;
}

// ── Project Intelligence + Agent Read Tools (V0.4) ────────────────────────

/**
 * A file autonomously read by the Agent during a request.
 * fullFile=true means the complete file was read — valid as a V0.3 edit base.
 * fullFile=false means only a line range was read — NOT a valid edit base.
 */
export interface AgentReadRef {
  /** UUID — same as snapshot file basename */
  id: string;
  requestId: string;
  conversationId: string;
  projectId: string;
  relativePath: string;
  /** Absolute path inside app dataDir/snapshots/ */
  snapshotPath: string;
  /** SHA-256 hex of captured content */
  contentHash: string;
  capturedAt: number;
  /** Byte size of captured content */
  size: number;
  language: string;
  /** true = whole file; false = line range only */
  fullFile: boolean;
  lineStart?: number;
  lineEnd?: number;
}

/** One agent tool invocation recorded for audit and UI display */
export interface ToolActivityEntry {
  id: string;
  requestId: string;
  conversationId: string;
  /** e.g. "search_code", "read_file" */
  toolName: string;
  /** The arguments the model passed */
  arguments: Record<string, unknown>;
  /** Human-readable summary e.g. "12 matches" or "read 3.2 KB" */
  resultSummary: string;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  executedAt: number;
}

/** All context seen by the model during one generation request */
export interface RequestContextLedger {
  requestId: string;
  conversationId: string;
  projectId: string;
  agentProfileId: string;
  /** QueueItem.contextRefs IDs that were in scope for this request */
  manualRefIds: string[];
  /** Files the agent autonomously read */
  agentReadRefs: AgentReadRef[];
  /** Commands the agent ran via run_command tool */
  commandEvidenceRefs: CommandEvidenceRef[];
  /** Ordered log of all tool invocations */
  toolActivity: ToolActivityEntry[];
  createdAt: number;
  updatedAt: number;
}

/** A tool call parsed from model output (native or forge_tool fallback) */
export interface ForgeToolCall {
  /** Provider-assigned or Forge-generated stable ID */
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool result to feed back to the model */
export interface ForgeToolResult {
  callId: string;
  toolName: string;
  ok: boolean;
  data?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

/** Normalized single-turn response from the model */
export interface NormalizedAgentResponse {
  type: "final" | "tool_calls";
  /** Accumulated text content (final text or prose before tool calls) */
  content: string;
  toolCalls?: ForgeToolCall[];
}

/**
 * V0.6 — Canonical normalized decision returned by normalizeDecision().
 * Every provider turn (native or fallback) resolves to exactly one of these.
 * The agent loop acts on the kind — never on raw text heuristics.
 */
export type NormalizedAgentDecision =
  | {
      kind: "tool_calls";
      calls: ForgeToolCall[];
    }
  | {
      /**
       * Terminal turn. `content` is the user-visible prose (forge_final envelope stripped).
       * `proposalFenceRaw` is the raw forge_edit_proposal JSON if one was present.
       */
      kind: "final";
      content: string;
      proposalFenceRaw?: string;
      /** Structured outcome parsed from forge_final JSON (project mode) */
      outcome?: ForgeAgentFinal;
    }
  | {
      /**
       * Protocol violation: naked prose, empty response, malformed envelope, etc.
       * `recoverable` means a correction injection should be attempted.
       */
      kind: "invalid";
      reason: string;
      recoverable: boolean;
    }
  | {
      /**
       * Human intervention required. The run suspends in `waiting_for_human` state
       * until the user clicks "Return Control".
       * Only set when forge_final contains a structurally valid `blocker` object.
       */
      kind: "human_required";
      reason: HumanRequiredReason;
      content: string;
    };

/**
 * V0.9 — Structured outcome that model must provide inside forge_final envelope.
 * status: 'completed' = goal achieved; 'blocked' = could not proceed;
 * 'failed' = goal not achieved.
 */
/**
 * Structured reason a browser task requires human intervention.
 * Only runtime/tool evidence or a structurally validated agent decision may
 * set this. Keyword inference is never used.
 */
export type HumanRequiredKind =
  | "captcha"
  | "mfa"
  | "passkey"
  | "credentials"
  | "browser_permission"
  | "explicit_user_takeover"
  | "unsupported_human_only_step";

export interface HumanRequiredReason {
  kind: HumanRequiredKind;
  description: string;
  browserContextRef?: { sessionId: string; tabId: string };
  evidenceRefs?: string[];
}

/**
 * Explicit provider capability flags for an AgentProfile.
 * Explicit override wins over all model-name heuristics.
 * Unknown custom endpoints default to unknown/false for all capabilities.
 */
export interface ProviderCapabilities {
  vision?: boolean;
  tools?: boolean;
  json?: boolean;
  streaming?: boolean;
  maxContextTokens?: number;
}

export interface ForgeAgentFinal {
  status: "completed" | "blocked" | "failed";
  summary: string;
  evidenceRefs?: string[];
  /** Structured blocker — required when status is "blocked" */
  blocker?: {
    kind: HumanRequiredKind;
    description: string;
    evidenceRefs?: string[];
  };
}

/**
 * Request-scoped goal progress state for loop/stall detection.
 * Created at processItem start, updated on each tool call.
 */
export interface AgentGoalState {
  requestId: string;
  conversationId: string;
  goal: string;
  stuckScore: number;
  lastObservationHash: string;
  lastActionSignature: string;
  sameObservationCount: number;
  sameActionCount: number;
  effectObserved: boolean;
  toolCallCount: number;
  replanCount: number;
}

/**
 * Pending browser JS dialog awaiting agent or policy decision.
 */
export interface BrowserPendingDialog {
  id: string;
  tabId: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;  // for prompt dialogs
  requestedAt: number;
}

/**
 * V0.6 — Agent run state machine states.
 * Transitions are strictly validated by the runtime.
 */
export type AgentRunState =
  | "queued"
  | "starting"
  | "waiting_for_model"
  | "processing_turn"
  | "executing_tools"
  | "continuing"
  | "finalizing"
  | "waiting_for_human"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * V0.6 — In-memory record for one logical Agent run.
 * Not persisted — ephemeral per request. RequestContextLedger holds the durable record.
 */
export interface AgentRun {
  requestId: string;
  conversationId: string;
  projectId: string;
  agentProfileId: string;
  state: AgentRunState;
  startedAt: number;
  completedAt?: number;
  toolStepCount: number;
  recoveryCount: number;
  readByteCount: number;
  failureCode?: string;
  failureMessage?: string;
  /** Loop/stall detection: number of consecutive repeated observations */
  stuckScore: number;
  /** Hash of last observation for stall detection */
  lastObservationHash?: string;
  /** Hash of last action signature for stall detection */
  lastActionHash?: string;
  /**
   * Set to true when the run has entered a terminal state (completed/cancelled/failed).
   * Once true, all further callbacks (onChunk, onToolStart, onToolEnd) are no-ops.
   * This is the canonical authority — renderer guards are defensive UI only.
   */
  terminated: boolean;
  // ── Task step identity (optional — only set for task-step runs) ──────
  /** Task ID when this run executes a task step */
  taskId?: string;
  /** Step ID when this run executes a task step */
  stepId?: string;
}

/** IPC channels for V0.4 agent tool ledger */
export const AGENT_TOOL_IPC = {
  /** Get the RequestContextLedger for a given requestId */
  LEDGER_GET: "agentTool:ledgerGet",
  /** Get tool activity entries for a given requestId */
  TOOL_ACTIVITY_GET: "agentTool:activityGet",
} as const;

// ── V0.9 Reliability Hardening ─────────────────────────────────────────────

/**
 * Canonical typed failure codes shared across agent-loop, QueueManager, edit-service.
 * Used for incident fingerprinting — never fingerprint arbitrary display strings.
 */
export type ForgeFailureCode =
  | "PROTOCOL_RECOVERY_EXHAUSTED"
  | "PROVIDER_ERROR"
  | "CONTEXT_INTEGRITY_ERROR"
  | "RESOURCE_MISSING"
  | "EDIT_PROPOSAL_INVALID"
  | "EDIT_PROPOSAL_TRUNCATED"
  | "EDIT_PROPOSAL_AMBIGUOUS"
  | "TOOL_BUDGET_EXHAUSTED"
  | "CANCELLED"
  | "PROJECT_UNAVAILABLE"
  | "INVARIANT_VIOLATION"
  | "INVALID_STATE_TRANSITION"
  | "CROSS_RUN_CONTAMINATION"
  | "DUPLICATE_FINAL_MESSAGE"
  | "STALE_BASE_WRITE"
  | "RESOURCE_GC_VIOLATION"
  // ── Command Execution failure codes ───────────────────────────────────
  | "COMMAND_CWD_ESCAPE"
  | "COMMAND_SPAWN_FAILED"
  | "COMMAND_TIMEOUT"
  | "COMMAND_POLICY_BLOCK"
  | "COMMAND_DUPLICATE_SPAWN"
  | "COMMAND_INVALID_TRUST"
  | "COMMAND_SECRET_ENV_LEAK"
  | "COMMAND_OUTPUT_OVERFLOW"
  | "COMMAND_INVALID_STATE_TRANSITION"
  | "COMMAND_PROCESS_ORPHAN"
  | "COMMAND_BUDGET_EXCEEDED"
  | "COMMAND_APPROVAL_BYPASS"
  | "COMMAND_SOURCE_WRITE_BYPASS"
  | "UNKNOWN"
  // ── Browser Runtime failure codes ─────────────────────────────────────
  | "BROWSER_PROFILE_NOT_FOUND"
  | "BROWSER_SESSION_NOT_FOUND"
  | "BROWSER_TAB_NOT_FOUND"
  | "BROWSER_ACCESS_DENIED"
  | "BROWSER_AGENT_ACCESS_DISABLED"
  | "BROWSER_APPROVAL_REJECTED"
  | "BROWSER_NAVIGATION_FAILED"
  | "BROWSER_TIMEOUT"
  | "BROWSER_STALE_ELEMENT_REF"
  | "BROWSER_ACTION_BUDGET_EXCEEDED"
  | "BROWSER_PAGE_CRASHED"
  | "BROWSER_PRIVATE_SESSION_CLOSED"
  | "BROWSER_DOWNLOAD_BLOCKED"
  | "BROWSER_UNSAFE_URL"
  | "BROWSER_CONTENT_TOO_LARGE"
  | "BROWSER_DIALOG_DEADLOCK"
  | "BROWSER_HUMAN_TAKEOVER"
  | "BROWSER_UPLOAD_FAILED"
  | "BROWSER_MEDIA_NOT_FOUND"
  | "BROWSER_FRAME_NOT_FOUND"
  | "BROWSER_SHADOW_ROOT_CLOSED"
  | "AGENT_GOAL_STALLED"
  | "AGENT_FINAL_INTENT_ONLY"
  | "AGENT_FINAL_MISSING_STATUS"
  | "AGENT_WAITING_FOR_HUMAN"
  // ── Task Runtime failure codes ────────────────────────────────────────
  | "TASK_PLAN_INVALID"
  | "TASK_PLAN_CYCLE"
  | "TASK_PLAN_MISSING_STEP"
  | "TASK_STEP_WRONG_TASK"
  | "TASK_AGENTRUN_WRONG_STEP"
  | "TASK_ADVANCED_WITH_FAILED_DEPENDENCY"
  | "TASK_COMPLETED_WITH_UNVERIFIED_GOAL"
  | "TASK_TERMINAL_WITH_ACTIVE_AGENTRUN"
  | "TASK_CANCELLED_BUT_STEP_CONTINUED"
  | "TASK_STALLED"
  | "TASK_DUPLICATE_ACTIVE_STEP"
  | "TASK_BUDGET_EXCEEDED"
  | "TASK_VERIFICATION_FAILED"
  | "TASK_STEP_MAX_ATTEMPTS"
  | "TASK_LOOP_UNEXPECTED_EXIT"
  | "TASK_RUNNING_STEP_NO_AGENTRUN"
  | "TASK_PAUSED_HAS_ACTIVE_AGENTRUN"
  | "TASK_EVIDENCE_REF_INVALID"
  | "TASK_VERIFICATION_NO_EVIDENCE"
  | "TASK_CALLBACK_LEAKED"
  | "TASK_RUNTIME_METADATA_MISMATCH"
  | "TASK_STALE_RUNNING_STEP_AFTER_RESTART"
  | "TASK_DUPLICATE_USER_MESSAGE";

/** Severity levels for invariants and incidents */
export type ForgeSeverity = "critical" | "high" | "medium" | "low";

/** Broad incident categories */
export type IncidentCategory =
  | "AGENT_RUNTIME"
  | "PROTOCOL"
  | "QUEUE"
  | "CONCURRENCY"
  | "NAVIGATION"
  | "PERSISTENCE"
  | "RESOURCE_LIFECYCLE"
  | "PROJECT_INTELLIGENCE"
  | "SAFE_EDITING"
  | "PROVIDER"
  | "INDEXING"
  | "IPC_ROUTING"
  | "SECURITY_INVARIANT"
  | "COMMAND_EXECUTION"
  | "BROWSER_RUNTIME"
  | "TASK_RUNTIME";

/** A canonical incident record — stored locally, never sent without opt-in */
export interface ForgeIncident {
  id: string;
  fingerprint: string;
  invariantId: string;
  category: IncidentCategory;
  severity: ForgeSeverity;
  failureCode: ForgeFailureCode;
  forgeVersion: string;
  runtimeSchemaVersion: number;
  requestId?: string;
  conversationId?: string;
  projectId?: string;
  agentRunId?: string;
  observedState: Record<string, unknown>;
  expectedState?: Record<string, unknown>;
  traceId?: string;
  recoveryApplied?: string;
  recoveryResult?: "success" | "failed" | "skipped";
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  knownIssue?: boolean;
  sanitizedSharePayload?: Record<string, unknown>;
}

/** A trace event emitted during an AgentRun for reliability observability */
export interface TraceEvent {
  traceId: string;
  requestId: string;
  conversationId: string;
  projectId?: string;
  sequence: number;
  timestamp: number;
  kind:
    | "RUN_CREATED"
    | "RUN_STATE_CHANGED"
    | "PROVIDER_REQUEST_STARTED"
    | "PROVIDER_RESPONSE_NORMALIZED"
    | "TOOL_REQUESTED"
    | "TOOL_STARTED"
    | "TOOL_COMPLETED"
    | "TOOL_FAILED"
    | "FILE_READ"
    | "SNAPSHOT_CAPTURED"
    | "LEDGER_UPDATED"
    | "PROTOCOL_RECOVERY"
    | "FINAL_NORMALIZED"
    | "PROPOSAL_CREATED"
    | "QUEUE_STATE_CHANGED"
    | "NAVIGATION_REHYDRATED"
    | "RUN_COMPLETED"
    | "RUN_FAILED"
    | "RUN_CANCELLED"
    | "INVARIANT_VIOLATION"
    // ── Command execution trace events ────────────────────────────────
    | "COMMAND_PROPOSED"
    | "COMMAND_POLICY_EVALUATED"
    | "COMMAND_APPROVED"
    | "COMMAND_REJECTED"
    | "COMMAND_SPAWNED"
    | "COMMAND_OUTPUT_RECEIVED"
    | "COMMAND_COMPLETED"
    | "COMMAND_CANCELLED"
    | "COMMAND_TIMED_OUT"
    | "COMMAND_TRUST_GRANTED"
    | "COMMAND_TRUST_INVALIDATED"
    // ── Browser runtime trace events ──────────────────────────────────
    | "BROWSER_SESSION_CREATED"
    | "BROWSER_SESSION_CLOSED"
    | "BROWSER_TAB_CREATED"
    | "BROWSER_NAVIGATION_STARTED"
    | "BROWSER_NAVIGATION_COMPLETED"
    | "BROWSER_AGENT_CONTROL_STARTED"
    | "BROWSER_AGENT_ACTION"
    | "BROWSER_AGENT_ACTION_BLOCKED"
    | "BROWSER_APPROVAL_REQUESTED"
    | "BROWSER_DOWNLOAD_REQUESTED"
    | "BROWSER_CRASHED";
  /** Structured metadata — no secrets, no raw content, no absolute paths */
  meta: Record<string, unknown>;
  /** Optional tool call ID for tool events */
  toolCallId?: string;
  /** Optional resource ID for resource events */
  resourceId?: string;
}

/**
 * V0.9 Structured Edit IR — enables compact multi-file edit proposals.
 * Model does NOT supply hashes — Forge derives from immutable base.
 */
export type EditOperationType = "full_content" | "exact_text_replace";

export interface FullContentEditOp {
  operation: "full_content";
  path: string;
  content: string;
}

export interface ExactTextReplaceOp {
  operation: "exact_text_replace";
  path: string;
  oldText: string;
  newText: string;
  /** Expected number of occurrences — required for determinism (1 = single match required) */
  expectedOccurrences: number;
}

export type EditOperationIR = FullContentEditOp | ExactTextReplaceOp;

/** A compact multi-file edit proposal using Edit IR */
export interface StructuredEditProposal {
  summary: string;
  explanation?: string;
  operations: EditOperationIR[];
}

// ── App Settings ──────────────────────────────────────────────────────────

/**
 * Persisted application settings (distinct from AgentProfile/AgentConfig).
 * Stored in DB appSettings field; defaults applied on first read.
 */
export interface AppSettings {
  /**
   * Incident sharing is OFF by default.
   * When false: "Get Share Payload" returns null without populating incident data.
   * When true: sanitized payload is built and returned for user to share.
   */
  incidentSharingEnabled: boolean;
  /**
   * Permission Center V1 — persisted capability policy store.
   * Session grants are NEVER stored here (in-memory only).
   */
  capabilityPolicies?: CapabilityPolicyStore;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  incidentSharingEnabled: false,
};

// ── Safe Terminal / Command Execution (V1) ──────────────────────────────

/**
 * Source of a command request.
 * - "user" — typed directly by the user in the terminal panel
 * - "agent" — requested by the Agent via run_command tool
 */
export type CommandSource = "user" | "agent";

/**
 * Risk classification assigned by deterministic CommandPolicy.
 * Never assigned by LLM. AI cost = 0.
 */
export type CommandRiskClass =
  | "verification"       // safe verification (typecheck, test, lint, build)
  | "read_only"          // reading without side effects
  | "project_script"     // package.json scripts (pnpm run X)
  | "mutation"           // writes/deletes files but not source-write bypass
  | "network"            // curl, wget, fetch-like
  | "remote_execution"   // npx, pnpm dlx, yarn dlx, bunx — arbitrary remote code
  | "package_install"    // pnpm add, npm install, pip install
  | "shell_interpreter"  // bash -c, sh, node -e, python -c — escape classes
  | "source_write_bypass"// sed -i, awk -i, perl -i — direct source mutation
  | "git"                // any git subcommand (blocked in V1)
  | "destructive"        // rm -rf, format, wipe-class
  | "unknown";           // unrecognized — ASK

/**
 * Policy decision with full context for UI rendering and reliability audit.
 * Deterministic: same (projectId, spec, trustState) → same decision. No LLM.
 */
export interface CommandPolicyDecision {
  decision: "allow" | "ask" | "block";
  riskClass: CommandRiskClass;
  /** Typed reason code for reliability fingerprinting and UI display */
  reasonCode:
    | "TRUSTED_EXACT_MATCH"
    | "TRUSTED_SCRIPT_HASH_MATCH"
    | "TRUSTED_SCRIPT_HASH_CHANGED"
    | "BLOCKED_SHELL_INTERPRETER"
    | "BLOCKED_SOURCE_WRITE_BYPASS"
    | "BLOCKED_GIT"
    | "BLOCKED_REMOTE_EXECUTION"
    | "BLOCKED_DESTRUCTIVE"
    | "BLOCKED_UNKNOWN_EXECUTABLE"
    | "ASK_PACKAGE_INSTALL"
    | "ASK_NETWORK"
    | "ASK_MUTATION"
    | "ASK_PROJECT_SCRIPT"
    | "ASK_VERIFICATION"
    | "ASK_READ_ONLY"
    | "ASK_UNKNOWN";
  /** If a trust rule matched, its ID */
  trustRuleId?: string;
}

/**
 * Structured command specification — what actually gets executed.
 * argv[] is used directly. shell:false always. No interpolation.
 */
export interface CommandSpec {
  /** Executable name or path (never a shell) */
  executable: string;
  /** Ordered argument list — no shell operators */
  args: string[];
  /** Relative path within project root for cwd. "" or "." = project root */
  cwdRelative: string;
  /** Optional human-readable purpose from Agent. Never used for security decisions. */
  purpose?: string;
  /** Timeout in milliseconds (bounded by COMMAND_LIMITS.MAX_TIMEOUT_MS) */
  timeoutMs?: number;
}

/**
 * Authorization state of a CommandExecution.
 */
export type CommandAuthorizationState =
  | "pending"          // not yet decided
  | "approved_once"    // user approved for this run only
  | "trusted"          // matched an exact trust rule
  | "rejected"         // user or policy rejected
  | "blocked_by_policy"; // deterministic policy block

/**
 * Lifecycle state of a CommandExecution.
 * State machine:
 *   proposed → awaiting_approval → queued → running → succeeded/failed/timed_out
 *                                │
 *                                └→ rejected (user/policy)
 *   Any active state → cancelled (user Stop or Agent cancel)
 *   On main-process restart: running/queued → cancelled (startup reconciliation)
 */
export type CommandState =
  | "proposed"          // created, policy evaluating or trust check pending
  | "awaiting_approval" // policy=ask, waiting for user decision
  | "queued"            // approved, waiting for concurrency slot
  | "running"           // process spawned
  | "succeeded"         // process exited 0
  | "failed"            // process exited non-zero or spawn error
  | "cancelled"         // cancelled by user, Agent stop, or app shutdown
  | "timed_out"         // exceeded timeoutMs
  | "blocked";          // deterministic policy block (never queued)

/** Set of terminal CommandState values */
export const COMMAND_TERMINAL_STATES = new Set<CommandState>([
  "succeeded", "failed", "cancelled", "timed_out", "blocked",
]);

/**
 * Metadata about captured command output.
 */
export interface CommandOutputMetadata {
  totalBytesReceived: number;
  /** true if output exceeded MAX_OUTPUT_BYTES and was truncated */
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  /** Number of output chunks emitted via IPC */
  chunkCount: number;
}

/**
 * A trust rule for an exact command (or project script + content hash).
 * "Always allow this exact command" creates one of these.
 */
export interface CommandTrustRule {
  id: string;
  projectId: string;
  /** Normalized spec identity: `executable ++ " " ++ args.join(" ") ++ " (cwd=" ++ cwdRelative ++ ")"` */
  normalizedSpec: string;
  /** SHA-256 hex of the package.json script body at trust time (for script commands) */
  scriptContentHash?: string;
  /** The raw script body captured at trust time for display */
  scriptBodySnapshot?: string;
  createdAt: number;
  lastUsedAt?: number;
  /** How many times this rule has matched and auto-approved */
  useCount: number;
}

/**
 * Evidence reference stored in RequestContextLedger for commands run during an AgentRun.
 * Process handles are never persisted — only serializable evidence.
 */
export interface CommandEvidenceRef {
  commandId: string;
  executable: string;
  args: string[];
  cwdRelative: string;
  exitCode: number | null;
  state: CommandState;
  /** SHA-256 hex of the sanitized output used as model evidence */
  outputHash?: string;
  /** Bounded sanitized output visible to the model */
  modelOutput: string;
  /** Human summary e.g. "pnpm test — 3 failures" */
  outputSummary: string;
  durationMs?: number;
  executedAt: number;
}

/**
 * Full canonical command execution domain record.
 * Persisted to DB (serializable only — no process handles).
 */
export interface CommandExecution {
  id: string;
  projectId: string;
  /** Set when command originates from an AgentRun */
  conversationId?: string;
  requestId?: string;
  /** The QueueItem.id that triggered this (for agent commands) */
  queueItemId?: string;
  source: CommandSource;
  spec: CommandSpec;
  /** Deterministic display string — what user sees in UI and approval card */
  displayCommand: string;
  policyDecision: CommandPolicyDecision;
  authorizationState: CommandAuthorizationState;
  state: CommandState;
  /** The absolute resolved cwd used for spawn (never sent to renderer) */
  // Not persisted in DB — re-resolved at spawn time
  // resolvedCwd: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  /** Process exit code (null if cancelled/timed-out before exit) */
  exitCode?: number | null;
  /** Signal that terminated process (e.g. "SIGTERM") */
  signal?: string;
  outputMetadata?: CommandOutputMetadata;
  /** Failure code for reliability/incident pipeline */
  failureCode?: ForgeFailureCode;
}

/** Bounded output page returned for UI rendering or model consumption */
export interface CommandOutputPage {
  commandId: string;
  /** ANSI-stripped safe text */
  text: string;
  truncated: boolean;
  totalBytes: number;
}

/**
 * Centralized command limits — no magic numbers in implementation code.
 */
export const COMMAND_LIMITS = {
  /** Max args per command */
  MAX_ARGS: 64,
  /** Max length of a single argument */
  MAX_ARG_LENGTH: 4096,
  /** Max length of cwdRelative */
  MAX_CWD_LENGTH: 1024,
  /** Max length of purpose string */
  MAX_PURPOSE_LENGTH: 512,
  /** Max commands an Agent may request per AgentRun */
  MAX_COMMANDS_PER_AGENT_RUN: 10,
  /** Default command timeout in ms */
  DEFAULT_TIMEOUT_MS: 120_000,
  /** Maximum command timeout in ms (2 hours) */
  MAX_TIMEOUT_MS: 7_200_000,
  /** Minimum command timeout in ms */
  MIN_TIMEOUT_MS: 1_000,
  /** Max raw output bytes accumulated in memory per command */
  MAX_OUTPUT_BYTES: 512 * 1024,
  /** Max sanitized output bytes sent to model as evidence */
  MAX_MODEL_OUTPUT_BYTES: 8 * 1024,
  /** Head bytes retained when output is truncated (2KB) */
  OUTPUT_HEAD_BYTES: 2 * 1024,
  /** Tail bytes retained when output is truncated (8KB) */
  OUTPUT_TAIL_BYTES: 8 * 1024,
  /** Max history records per project */
  MAX_HISTORY_PER_PROJECT: 500,
  /** Max concurrent running commands per project */
  MAX_CONCURRENT_PER_PROJECT: 3,
  /** Output IPC batch interval in ms */
  OUTPUT_BATCH_INTERVAL_MS: 100,
  /** Output IPC batch size trigger in bytes */
  OUTPUT_BATCH_SIZE_BYTES: 4096,
  /** Max rows returned by commands:list */
  MAX_LIST_RESULTS: 100,
  /** Max bytes per paged output read */
  OUTPUT_PAGE_BYTES: 32 * 1024,
} as const;

/** IPC channels for Safe Terminal V1 */
export const COMMAND_IPC = {
  // Invoked by renderer → main
  LIST:           "commands:list",
  GET:            "commands:get",
  RUN_USER:       "commands:runUser",
  APPROVE:        "commands:approve",
  REJECT:         "commands:reject",
  CANCEL:         "commands:cancel",
  READ_OUTPUT:    "commands:readOutput",
  LIST_TRUST:     "commands:listTrust",
  REVOKE_TRUST:   "commands:revokeTrust",
  RUNTIME_STATE:  "commands:runtimeState",
  // Pushed from main → renderer
  STATE_CHANGE:   "commands:stateChange",
  OUTPUT_CHUNK:   "commands:outputChunk",
  COMPLETE:       "commands:complete",
} as const;

/** V0.9 IPC channels for settings */
export const SETTINGS_IPC = {
  GET: "settings:get",
  SET: "settings:set",
} as const;

// ── Browser Runtime V1 — Canonical Types ─────────────────────────────────

export type BrowserPersistenceMode = "persistent" | "private";

export type BrowserAgentAccessPolicy = "off" | "ask" | "allowed";

/** A browser identity/storage profile. Persistent profiles keep cookies etc. across sessions. */
export interface BrowserProfile {
  id: string;
  name: string;
  persistenceMode: BrowserPersistenceMode;
  agentAccessPolicy: BrowserAgentAccessPolicy;
  /** Electron session partition string — derived, never mutated after creation */
  partition: string;
  isDefault?: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export type BrowserSessionLifecycle = "active" | "suspended" | "closing" | "closed";

/** Tab URL/title pairs persisted for session restore */
export interface BrowserRestoreState {
  tabs: Array<{ id: string; url: string; title: string }>;
  activeTabId: string | null;
  savedAt: number;
}

/** A browser workspace instance — owns an ordered set of tabs */
export interface BrowserSession {
  id: string;
  profileId: string;
  name?: string;
  lifecycle: BrowserSessionLifecycle;
  activeTabId: string | null;
  /** Ordered tab IDs */
  tabIds: string[];
  /** For persistent profiles only — restored on open */
  restoreState?: BrowserRestoreState;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
}

export type BrowserTabLoadState = "idle" | "loading" | "loaded" | "crashed";

/** A single browser tab */
export interface BrowserTab {
  id: string;
  sessionId: string;
  profileId: string;
  url: string;
  title: string;
  faviconDataUrl?: string;
  loadState: BrowserTabLoadState;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Incremented on every navigation — used to detect stale element refs */
  navigationGeneration: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Opaque binding between a browser resource and a conversation/request.
 * Main process is authoritative — renderer never constructs this directly.
 */
export interface BrowserContextRef {
  id: string;
  profileId: string;
  sessionId: string;
  tabId: string;
  navigationGeneration: number;
  createdAt: number;
  conversationId?: string;
  requestId?: string;
  agentRunId?: string;
}

/** Agent browser control token — must be validated before every browser action */
export interface BrowserAgentControl {
  sessionId: string;
  tabId: string;
  conversationId: string;
  requestId: string;
  agentRunId: string;
  startedAt: number;
}

/** Full runtime state broadcast to renderer */
export interface BrowserRuntimeState {
  profiles: BrowserProfile[];
  sessions: BrowserSession[];
  tabs: BrowserTab[];
  activeSessionId: string | null;
  agentControl: BrowserAgentControl | null;
  revision: number;
}

/** An interactive element extracted from a page for agent targeting */
export interface PageSemanticElement {
  /** Stable ref key tied to this navigation generation: "b17", "i4", "l22" */
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

/** Bounded semantic snapshot of a browser page — safe to send to model */
export interface PageSemanticSnapshot {
  url: string;
  title: string;
  navigationGeneration: number;
  tabId: string;
  sessionId: string;
  capturedAt: number;
  /** Bounded visible text (max BROWSER_LIMITS.MAX_PAGE_TEXT_BYTES) */
  text: string;
  /** Interactive elements (max BROWSER_LIMITS.MAX_ELEMENTS_PER_SNAPSHOT) */
  elements: PageSemanticElement[];
  truncated: boolean;
}

/** Risk classification for agent browser actions — deterministic, no LLM */
export type BrowserActionRisk =
  | "READ"
  | "NAVIGATION"
  | "INTERACTION"
  | "FORM_SUBMISSION"
  | "DOWNLOAD"
  | "UPLOAD"
  | "AUTHENTICATION"
  | "ACCOUNT_CHANGE"
  | "DESTRUCTIVE"
  | "EXTERNAL_PROTOCOL"
  | "UNKNOWN";

export type BrowserActionDecision = "allow" | "ask" | "block";

/** Pending browser action awaiting user approval */
export interface BrowserPendingApproval {
  id: string;
  sessionId: string;
  tabId: string;
  url: string;
  action: string;
  risk: BrowserActionRisk;
  agentPurpose?: string;
  requestedAt: number;
}

/** Evidence of browser interaction attached to a request context ledger */
export interface BrowserEvidenceRef {
  id: string;
  requestId: string;
  browserSessionId: string;
  tabId: string;
  url: string;
  title: string;
  timestamp: number;
  navigationGeneration: number;
  snapshotHash?: string;
  /** Path to bounded text extract (session-scoped, request-scoped) */
  extractedTextPath?: string;
  /** Path to screenshot file */
  screenshotPath?: string;
  type: "page_read" | "screenshot" | "console" | "network";
}

/** A saved browser bookmark */
export interface BrowserBookmark {
  id: string;
  profileId: string;
  url: string;
  title: string;
  favicon?: string;
  folderId?: string;
  createdAt: number;
  updatedAt: number;
}

/** A browsing history entry (never persisted for private profiles) */
export interface BrowserHistoryEntry {
  id: string;
  profileId: string;
  url: string;
  title: string;
  visitedAt: number;
}

/** Browser status snapshot — read-only, no agent control required */
export interface BrowserStatusSnapshot {
  isWindowOpen: boolean;
  tabCount: number;
  activeUrl: string | null;
  activeTitle: string | null;
  activeProfileName: string | null;
  agentControlActive: boolean;
}

/** Download item visible to renderer */
export interface BrowserDownloadItem {
  id: string;
  sessionId: string;
  url: string;
  filename: string;
  savePath?: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  /** true = agent-initiated (requires policy/approval) */
  agentInitiated: boolean;
  startedAt: number;
}

/** Per-agent-run browser budget tracking */
export interface BrowserAgentBudget {
  actionsUsed: number;
  navigationsUsed: number;
  screenshotsUsed: number;
  readBytesUsed: number;
}

/** Extended wait conditions for browser_wait_for */
export type BrowserWaitConditionExtended =
  | "page_load"
  | "text_present"
  | "text_absent"
  | "url_matches"
  | "url_equals"
  | "title_contains"
  | "element_present"
  | "element_absent"
  | "element_enabled"
  | "navigation_settled"
  | "network_quiet";

/** Media state exposed to model (sensitive URL parts redacted) */
export interface BrowserMediaState {
  ref: string;
  elementTag: "video" | "audio";
  srcRedacted: string;
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  readyState: number;
  visible: boolean;
}

/** Browser operation limits */
export const BROWSER_LIMITS = {
  /** Max agent browser actions per AgentRun */
  MAX_ACTIONS_PER_REQUEST: 50,
  /** Max navigations per AgentRun */
  MAX_NAVIGATIONS_PER_REQUEST: 20,
  /** Max screenshots per AgentRun */
  MAX_SCREENSHOTS_PER_REQUEST: 5,
  /** Max page-read bytes per AgentRun */
  MAX_READ_BYTES_PER_REQUEST: 256 * 1024,
  /** Max visible page text bytes in one snapshot */
  MAX_PAGE_TEXT_BYTES: 16 * 1024,
  /** Max interactive elements per snapshot */
  MAX_ELEMENTS_PER_SNAPSHOT: 200,
  /** Max console entries returned per call */
  MAX_CONSOLE_ENTRIES: 50,
  /** Max network entries returned per call */
  MAX_NETWORK_ENTRIES: 50,
  /** Max concurrent browser sessions */
  MAX_SESSIONS: 10,
  /** Max tabs per session */
  MAX_TABS_PER_SESSION: 20,
  /** Max concurrent agent-controlled tabs across all runs */
  MAX_CONCURRENT_AGENT_TABS: 2,
  /** Max screenshot width */
  MAX_SCREENSHOT_WIDTH: 1280,
  /** Max screenshot height */
  MAX_SCREENSHOT_HEIGHT: 800,
  /** Max ms to wait in browser_wait_for */
  MAX_WAIT_FOR_MS: 30_000,
} as const;

/** IPC channels for Browser Runtime V1 */
export const BROWSER_IPC = {
  // Renderer → Main (invoke)
  LIST_PROFILES:         "browser:listProfiles",
  CREATE_PROFILE:        "browser:createProfile",
  UPDATE_PROFILE:        "browser:updateProfile",
  DELETE_PROFILE:        "browser:deleteProfile",
  LIST_SESSIONS:         "browser:listSessions",
  CREATE_SESSION:        "browser:createSession",
  CLOSE_SESSION:         "browser:closeSession",
  LIST_TABS:             "browser:listTabs",
  NEW_TAB:               "browser:newTab",
  CLOSE_TAB:             "browser:closeTab",
  NAVIGATE:              "browser:navigate",
  NAVIGATE_BACK:         "browser:navigateBack",
  NAVIGATE_FORWARD:      "browser:navigateForward",
  RELOAD:                "browser:reload",
  STOP:                  "browser:stop",
  ACTIVATE_SESSION:      "browser:activateSession",
  ACTIVATE_TAB:          "browser:activateTab",
  RESIZE_VIEW:           "browser:resizeView",
  HIDE_VIEW:             "browser:hideView",
  SHOW_VIEW:             "browser:showView",
  GRANT_AGENT_ACCESS:    "browser:grantAgentAccess",
  REVOKE_AGENT_ACCESS:   "browser:revokeAgentAccess",
  APPROVE_ACTION:        "browser:approveAction",
  REJECT_ACTION:         "browser:rejectAction",
  USER_TAKE_CONTROL:     "browser:userTakeControl",
  RETURN_TO_AGENT:       "browser:returnToAgent",
  GET_RUNTIME_STATE:     "browser:getRuntimeState",
  // Main → Renderer (send)
  TAB_UPDATED:           "browser:tabUpdated",
  SESSION_UPDATED:       "browser:sessionUpdated",
  RUNTIME_STATE_PUSH:    "browser:runtimeStatePush",
  APPROVAL_REQUESTED:    "browser:approvalRequested",
  AGENT_CONTROL_CHANGED: "browser:agentControlChanged",
  DOWNLOAD_STARTED:      "browser:downloadStarted",
  // Main → Renderer (send): request UI to show browser workspace
  REQUEST_SHOW_BROWSER:  "browser:requestShowBrowser",
  // Renderer → Main: user switched the visible tab
  USER_TAB_CHANGED:      "browser:userTabChanged",
  // Main → Browser renderer: open/focus window command
  OPEN_WINDOW:           "browser:openWindow",
  FOCUS_WINDOW:          "browser:focusWindow",
  // Browser renderer → Main: renderer is ready
  BROWSER_RENDERER_READY: "browser:rendererReady",
  // Bookmark CRUD
  BOOKMARK_LIST:         "browser:bookmarkList",
  BOOKMARK_ADD:          "browser:bookmarkAdd",
  BOOKMARK_REMOVE:       "browser:bookmarkRemove",
  BOOKMARK_UPDATE:       "browser:bookmarkUpdate",
  // History
  HISTORY_LIST:          "browser:historyList",
  HISTORY_CLEAR:         "browser:historyClear",
  // Read-only status (no agent control required)
  BROWSER_STATUS:        "browser:status",
  // Approval dialog shown in browser renderer
  APPROVAL_SHOW:         "browser:approvalShow",
  // Agent run waiting for human (CAPTCHA/MFA)
  WAITING_FOR_HUMAN:     "browser:waitingForHuman",
  // Agent control released (terminal path)
  AGENT_CONTROL_RELEASED: "browser:agentControlReleased",
  // JS dialog intercepted — notify renderer (for agent tools)
  DIALOG_PENDING:        "browser:dialogPending",
  DIALOG_RESOLVED:       "browser:dialogResolved",
  // Human takeover detected
  HUMAN_TAKEOVER:        "browser:humanTakeover",
  // Return control to agent
  RETURN_CONTROL:        "browser:returnControl",
} as const;

// ── Dev Process (Long-Running Project Processes) ──────────────────────────

export type DevProcessState =
  | "proposed"
  | "awaiting_approval"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type DevProcessReadyState = "unknown" | "detecting" | "ready" | "timeout";

export interface DevProcessRecord {
  id: string;
  projectId: string;
  conversationId?: string;
  requestId?: string;
  agentRunId?: string;
  /** Structured command spec — shell:false always */
  executable: string;
  args: string[];
  cwd: string;
  state: DevProcessState;
  readyState: DevProcessReadyState;
  /** Detected localhost URLs from process output */
  detectedUrls: string[];
  /** Primary ready URL (first detected and probed OK) */
  readyUrl?: string;
  pid?: number;
  startedAt: number;
  stoppedAt?: number;
  /** Whether the user explicitly started this (survives agent run end) */
  userOwned: boolean;
}

export const DEV_PROCESS_IPC = {
  LIST:           "devProcess:list",
  READ_OUTPUT:    "devProcess:readOutput",
  STOP:           "devProcess:stop",
  // Main → Renderer push
  STATE_CHANGED:  "devProcess:stateChanged",
} as const;

/** V17 IPC channels for structured telemetry / Dev Panel */
export const TELEMETRY_IPC = {
  /** Get recent log entries (optionally filtered) */
  GET_EVENTS: "telemetry:getEvents",
  /** Clear log ring buffer */
  CLEAR: "telemetry:clear",
  /** Set minimum log level */
  SET_LEVEL: "telemetry:setLevel",
} as const;

/** V17 IPC channels for developer diagnostics panel */
export const DEV_PANEL_IPC = {
  /** Get full dev snapshot (runs, streams, queue, browser, incidents) */
  GET_SNAPSHOT: "devPanel:getSnapshot",
  /** Get semantic timeline for one agentRunId */
  GET_RUN_TIMELINE: "devPanel:getRunTimeline",
  /** Export sanitized diagnostic bundle */
  EXPORT_BUNDLE: "devPanel:exportBundle",
  /** Push from main: snapshot invalidated (live updates) */
  SNAPSHOT_UPDATED: "devPanel:snapshotUpdated",
} as const;

/** V0.9 IPC channels for reliability */
export const RELIABILITY_IPC = {
  /** Get current incident summary list */
  INCIDENTS_LIST: "reliability:incidentsList",
  /** Get full incident by id */
  INCIDENT_GET: "reliability:incidentGet",
  /** Get sanitized share payload for an incident */
  INCIDENT_SHARE_PAYLOAD: "reliability:incidentSharePayload",
  /** Clear all incidents */
  INCIDENTS_CLEAR: "reliability:incidentsClear",
  /** Get current reliability metrics */
  METRICS_GET: "reliability:metricsGet",
  /** Push from main: new incident recorded */
  INCIDENT_RECORDED: "reliability:incidentRecorded",
} as const;

// ── Permission Center V1 ──────────────────────────────────────────────────

/**
 * Permission Center capability policy level.
 * Canonical authorization decision for a capability.
 */
export type CapabilityPolicy =
  | "DENY"            // always block, no approval possible
  | "ASK"             // suspend and ask user on each occurrence
  | "ALLOW_SESSION"   // allow for this app session (in-memory, reset on restart)
  | "ALLOW_PROJECT"   // allow for a specific project (persisted by projectId)
  | "ALWAYS_ALLOW";   // allow globally (persisted)

/**
 * Resolved permission decision returned by resolvePermission().
 */
export type PermissionDecision = "ALLOW" | "DENY" | "ASK";

/**
 * Source that determined the resolved permission decision.
 * Used in Dev Panel diagnostics and ForgeLogger events.
 */
export type PermissionSource =
  | "default"    // capability defaultPolicy
  | "preset"     // preset (SAFE / ASK / FULL_ACCESS)
  | "global"     // user-set global override
  | "project"    // project-specific override
  | "session"    // in-memory session grant
  | "agentRun";  // not used for initial resolution (future)

/**
 * Full result of resolvePermission().
 */
export interface PermissionResult {
  decision: PermissionDecision;
  source: PermissionSource;
  capabilityId: string;
  /** Human-readable reason for diagnostics */
  reason: string;
}

/**
 * Risk level of a capability.
 */
export type CapabilityRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Category of a capability.
 */
export type CapabilityCategory =
  | "browser"
  | "terminal"
  | "git"
  | "filesystem"
  | "network"
  | "process"
  | "device"
  | "future";

/**
 * Canonical capability definition in the registry.
 */
export interface CapabilityDef {
  id: string;
  category: CapabilityCategory;
  name: string;
  description: string;
  risk: CapabilityRisk;
  defaultPolicy: CapabilityPolicy;
  requiresProject: boolean;
  isDestructive: boolean;
  isNetworked: boolean;
  isCredentialSensitive: boolean;
  requiresHumanPresence?: boolean;
}

/**
 * Context passed to resolvePermission().
 * Used for scope lookup and audit logging.
 */
export interface PermissionCheckContext {
  capabilityId: string;
  projectId?: string;
  /** Present when called from agent tool executor; absent from IPC-level callers */
  conversationId?: string;
  requestId?: string;
  agentRunId?: string;
  toolCallId?: string;
  /** Optional human-readable resource hint for approval UI */
  resource?: string;
}

/**
 * Persisted capability policy store.
 * Stored in AppSettings (via db.ts).
 * Session grants are NEVER stored here.
 */
export interface CapabilityPolicyStore {
  /** Optional active preset */
  preset?: "SAFE" | "ASK" | "FULL_ACCESS";
  /** Global overrides keyed by capabilityId */
  globalPolicies: Record<string, CapabilityPolicy>;
  /** Project-specific overrides keyed by projectId, then capabilityId */
  projectOverrides: Record<string, Record<string, CapabilityPolicy>>;
}

export const DEFAULT_CAPABILITY_POLICY_STORE: CapabilityPolicyStore = {
  globalPolicies: {},
  projectOverrides: {},
};

/**
 * Optional presets for the Permission Center.
 * Presets define default resolution baselines.
 * Explicit per-capability overrides are applied ON TOP of the preset.
 */
export type PermissionPreset = "SAFE" | "ASK" | "FULL_ACCESS";

/**
 * A single recorded permission check for Dev Panel display.
 */
export interface PermissionCheckRecord {
  id: string;
  capabilityId: string;
  decision: PermissionDecision;
  source: PermissionSource;
  reason: string;
  projectId?: string;
  conversationId?: string;
  requestId?: string;
  agentRunId?: string;
  approvalId?: string;
  durationMs: number;
  checkedAt: number;
}

/** IPC channels for Permission Center V1 */
export const PERMISSION_IPC = {
  /** Get the full CapabilityPolicyStore */
  GET_STORE:              "permission:getStore",
  /** Set global policy for a capability */
  SET_GLOBAL:             "permission:setGlobal",
  /** Set project override for a capability */
  SET_PROJECT:            "permission:setProject",
  /** Clear project override for a capability */
  CLEAR_PROJECT:          "permission:clearProject",
  /** Set preset (overrides defaults, explicit overrides remain) */
  SET_PRESET:             "permission:setPreset",
  /** Clear preset (revert to capability defaults) */
  CLEAR_PRESET:           "permission:clearPreset",
  /** Reset all global policies to defaults */
  RESET_GLOBAL:           "permission:resetGlobal",
  /** Reset project overrides for a project */
  RESET_PROJECT:          "permission:resetProject",
  /** Get all capability definitions */
  GET_CAPABILITIES:       "permission:getCapabilities",
  /** Get recent permission check records (for Dev Panel) */
  GET_CHECKS:             "permission:getChecks",
  /** Grant session-level permission for a capability (in-memory only) */
  GRANT_SESSION:          "permission:grantSession",
  /** Revoke session-level permission for a capability */
  REVOKE_SESSION:         "permission:revokeSession",
  /** Get all active session grants */
  GET_SESSION_GRANTS:     "permission:getSessionGrants",
  /** Main→renderer: pending approval request (sent when resolvePermission returns ASK) */
  APPROVAL_REQUEST:        "permission:approvalRequest",
  /** Renderer→main: user responded to an approval request */
  APPROVAL_RESPOND:        "permission:approvalRespond",
  /** Main→renderer: approval was cancelled (e.g. Stop button) */
  APPROVAL_CANCELLED:      "permission:approvalCancelled",
} as const;

/** User action in response to a permission approval prompt */
export type PermissionApprovalAction =
  | "allow_once"      // this exact operation only (requestId+toolCallId scoped)
  | "allow_session"   // rest of this app session
  | "allow_project"   // persisted for this project
  | "always_allow"    // persisted globally
  | "deny";           // deny this one operation

/** Pending permission approval payload sent to renderer */
export interface PermissionApprovalRequest {
  approvalId: string;
  capabilityId: string;
  capabilityName: string;
  reason: string;          // human-readable why this was triggered
  projectId?: string;
  conversationId?: string;
  requestId?: string;
  agentRunId?: string;
  toolCallId?: string;
}

/** User's response to a permission approval prompt */
export interface PermissionApprovalResponse {
  approvalId: string;
  action: PermissionApprovalAction;
}

// ── Task / Plan Runtime V1 ─────────────────────────────────────────────────

export type TaskStatus =
  | "draft"
  | "planning"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_human"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_human"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"
  /** Step was aborted mid-run (task paused/cancelled) — safe to retry */
  | "interrupted";

export type TaskStepType =
  | "inspect"
  | "run"
  | "browse"
  | "edit"
  | "test"
  | "git"
  | "verify"
  | "research"
  | "generic";

export type TaskStepResultStatus =
  | "completed"
  | "blocked"
  | "failed"
  | "replan_required"
  /** Inference was ambiguous — use protocol recovery/retry instead of guessing */
  | "protocol_recovery";

export interface TaskBlocker {
  kind: "permission_denied" | "human_required" | "missing_info" | "unsupported" | "external_failure";
  message: string;
  capabilityId?: string;
  stepId?: string;
}

export interface TaskStepResult {
  status: TaskStepResultStatus;
  summary: string;
  evidenceRefs: string[];
  observations?: string;
  recommendedPlanChanges?: string;
}

export interface ForgeTaskStep {
  id: string;
  taskId: string;
  title: string;
  description?: string;
  type: TaskStepType;
  status: TaskStepStatus;
  /** Step IDs that must be completed before this step is ready */
  dependencies: string[];
  /** Capability hints for context injection */
  capabilityHints: string[];
  expectedOutcome?: string;
  /** Evidence artifact refs produced by this step */
  evidenceRefs: string[];
  attemptCount: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  /** Most recent step result */
  lastResult?: TaskStepResult;
}

export interface ForgeTaskPlan {
  taskId: string;
  version: number;
  steps: ForgeTaskStep[];
  createdAt: number;
  updatedAt: number;
  reasonForRevision?: string;
}

export interface ForgeTask {
  id: string;
  conversationId: string;
  projectId?: string;
  goal: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
  planVersion: number;
  currentStepId?: string;
  summary?: string;
  failure?: { code: string; message: string };
  blocker?: TaskBlocker;
  verificationStatus?: "pending" | "passed" | "failed" | "skipped";
  /** The ChatMessage ID of the user message that triggered this task */
  triggerMessageId?: string;
  /** Whether this task requires verified evidence before completion */
  requiresVerification: boolean;
  /** Evidence policy for verification */
  verificationPolicy: "none" | "evidence_required" | "build_test" | "browser";
  /** If set, this task is queued to start after the referenced task completes */
  queuedAfter?: string;
  metadata: Record<string, unknown>;
}

/** Classification of a user message for task routing */
export type TaskClassification = "conversation" | "simple_action" | "task";

/** Typed planner output — validated before persisting */
export interface StructuredPlannerOutput {
  goalSummary: string;
  steps: Array<{
    id: string;
    title: string;
    type: TaskStepType;
    description?: string;
    dependencies: string[];
    expectedOutcome?: string;
    capabilityHints: string[];
  }>;
}

/** Snapshot pushed to renderer — revisioned to drop stale events */
export interface TaskRuntimeSnapshot {
  task: ForgeTask;
  plan: ForgeTaskPlan;
  revision: number;
}

export const TASK_IPC = {
  // Renderer → Main
  /** Check whether task runtime is enabled (FORGE_TASKS_ENABLED env var) */
  IS_ENABLED:          "task:isEnabled",
  /** Get the current task for a conversation, if any */
  GET_ACTIVE:          "task:getActive",
  /** Get a task by id */
  GET_TASK:            "task:get",
  /** List all tasks for a conversation */
  LIST_BY_CONV:        "task:listByConv",
  /** Pause the active task */
  PAUSE:               "task:pause",
  /** Resume a paused task */
  RESUME:              "task:resume",
  /** Cancel the active task */
  CANCEL:              "task:cancel",
  /** Retry a failed task */
  RETRY:               "task:retry",
  /** Retry a specific failed step */
  RETRY_STEP:          "task:retryStep",
  /** Skip a non-critical step */
  SKIP_STEP:           "task:skipStep",

  // Main → Renderer (push events)
  /** Task created */
  TASK_CREATED:        "task:created",
  /** Task snapshot updated (status, plan, step) */
  TASK_UPDATED:        "task:updated",
  /** Task reached a terminal state */
  TASK_TERMINAL:       "task:terminal",
  /** Plan was revised */
  TASK_REPLANNED:      "task:replanned",
  /** Step status changed */
  STEP_UPDATED:        "task:stepUpdated",
  /** Startup: task was interrupted, reconciled to paused */
  TASK_RECONCILED:     "task:reconciled",
} as const;

/** ForgeLogger event names for task runtime — used for structured telemetry */
export type TaskLogEvent =
  | "TASK_CREATED"
  | "TASK_PLANNING_STARTED"
  | "TASK_PLAN_CREATED"
  | "TASK_STARTED"
  | "TASK_STEP_READY"
  | "TASK_STEP_STARTED"
  | "TASK_STEP_COMPLETED"
  | "TASK_STEP_FAILED"
  | "TASK_STEP_BLOCKED"
  | "TASK_REPLAN_STARTED"
  | "TASK_REPLANNED"
  | "TASK_PAUSED"
  | "TASK_RESUMED"
  | "TASK_VERIFICATION_STARTED"
  | "TASK_VERIFICATION_COMPLETED"
  | "TASK_VERIFICATION_FAILED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_CANCELLED"
  | "TASK_STALLED"
  | "TASK_RECONCILED"
  | "TASK_STEP_ATTEMPT"
  | "TASK_BUDGET_EXCEEDED";

