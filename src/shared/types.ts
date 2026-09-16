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

  // Queue management
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
