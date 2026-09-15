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
