export type Protocol = "openai" | "anthropic";

export interface AgentConfig {
  id: string;
  name: string;
  endpoint: string;
  protocol: Protocol;
  model: string;
  /** custom header name for API key (optional) */
  apiKeyHeader?: string;
  /** timeout in milliseconds */
  timeoutMs?: number;
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
}

export interface SendMessageRequest {
  conversationId: string;
  content: string;
  /** attachment IDs already saved to disk */
  attachmentIds?: string[];
  /** message being quoted/replied to */
  replyToMessageId?: string;
}

export interface SendMessageResponse {
  message: ChatMessage;
}

export interface AppState {
  onboardingComplete: boolean;
  agentConfigId: string | null;
}

/** IPC channel names */
export const IPC = {
  // Agent config
  CONFIG_SAVE: "config:save",
  CONFIG_GET: "config:get",
  CONFIG_DELETE: "config:delete",

  // Credentials
  SECRET_SET: "secret:set",
  SECRET_HAS: "secret:has",
  SECRET_DELETE: "secret:delete",

  // Connection test
  TEST_CONNECTION: "agent:testConnection",

  // Chat
  CHAT_SEND: "chat:send",
  CHAT_STREAM_START: "chat:streamStart",
  CHAT_STREAM_CHUNK: "chat:streamChunk",
  CHAT_STREAM_END: "chat:streamEnd",
  CHAT_STREAM_ERROR: "chat:streamError",
  CHAT_CANCEL: "chat:cancel",

  // Conversations
  CONV_LIST: "conv:list",
  CONV_GET: "conv:get",
  CONV_CREATE: "conv:create",
  CONV_UPDATE: "conv:update",
  CONV_DELETE: "conv:delete",
  CONV_SEARCH: "conv:search",
  CONV_EXPORT: "conv:export",

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
} as const;