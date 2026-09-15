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

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  model?: string;
  durationMs?: number;
}

export interface SendMessageRequest {
  content: string;
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
  CHAT_STREAM_CHUNK: "chat:streamChunk",
  CHAT_STREAM_END: "chat:streamEnd",
  CHAT_STREAM_ERROR: "chat:streamError",
  CHAT_CANCEL: "chat:cancel",

  // History
  HISTORY_GET: "history:get",
  HISTORY_CLEAR: "history:clear",

  // App state
  APP_STATE_GET: "appState:get",
  APP_STATE_SET: "appState:set",
} as const;