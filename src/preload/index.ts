import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/types.js";
import type {
  AgentConfig,
  AgentProfile,
  AppState,
  ChatMessage,
  Conversation,
  Attachment,
  AttachmentInput,
  ConnectionTestResult,
  SendMessageRequest,
  QueueItem,
  ConvQueueState,
} from "../shared/types.js";

type UnsubFn = () => void;

const forgeApi = {
  // ── App State ──────────────────────────────────────────────────────────
  getAppState: (): Promise<AppState> =>
    ipcRenderer.invoke(IPC.APP_STATE_GET),

  setAppState: (state: AppState): Promise<void> =>
    ipcRenderer.invoke(IPC.APP_STATE_SET, state),

  // ── Agent Profiles (multi-profile) ──────────────────────────────────────
  listProfiles: (): Promise<AgentProfile[]> =>
    ipcRenderer.invoke(IPC.PROFILE_LIST),

  getProfile: (id: string): Promise<AgentProfile | null> =>
    ipcRenderer.invoke(IPC.PROFILE_GET, id),

  saveProfile: (profile: AgentProfile): Promise<AgentProfile> =>
    ipcRenderer.invoke(IPC.PROFILE_SAVE, profile),

  deleteProfile: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PROFILE_DELETE, id),

  setDefaultProfile: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PROFILE_SET_DEFAULT, id),

  // ── Agent Config (legacy shim) ─────────────────────────────────────────
  saveConfig: (cfg: AgentConfig): Promise<void> =>
    ipcRenderer.invoke(IPC.CONFIG_SAVE, cfg),

  getConfig: (id: string): Promise<AgentConfig | null> =>
    ipcRenderer.invoke(IPC.CONFIG_GET, id),

  deleteConfig: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CONFIG_DELETE, id),

  // ── Secrets ─────────────────────────────────────────────────────────────
  setSecret: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SECRET_SET, key, value),

  hasSecret: (key: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SECRET_HAS, key),

  deleteSecret: (key: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SECRET_DELETE, key),

  // ── Connection Test ─────────────────────────────────────────────────────
  testConnection: (cfg: AgentConfig): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke(IPC.TEST_CONNECTION, cfg),

  // ── Conversations ────────────────────────────────────────────────────────
  listConversations: (includeArchived?: boolean): Promise<Conversation[]> =>
    ipcRenderer.invoke(IPC.CONV_LIST, includeArchived ?? false),

  getConversation: (id: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC.CONV_GET, id),

  createConversation: (conv: Conversation): Promise<void> =>
    ipcRenderer.invoke(IPC.CONV_CREATE, conv),

  updateConversation: (
    id: string,
    patch: Partial<Pick<Conversation, "title" | "updatedAt" | "pinnedAt" | "archivedAt" | "defaultAgentProfileId">>
  ): Promise<void> => ipcRenderer.invoke(IPC.CONV_UPDATE, id, patch),

  deleteConversation: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CONV_DELETE, id),

  searchConversations: (query: string): Promise<Conversation[]> =>
    ipcRenderer.invoke(IPC.CONV_SEARCH, query),

  exportConversation: (id: string): Promise<string> =>
    ipcRenderer.invoke(IPC.CONV_EXPORT, id),

  branchConversation: (sourceConvId: string, upToMessageId: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC.CONV_BRANCH, sourceConvId, upToMessageId),

  searchMessages: (query: string): Promise<Array<{ message: ChatMessage; conversation: Conversation }>> =>
    ipcRenderer.invoke(IPC.MSG_SEARCH, query),

  getConversationMessages: (convId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IPC.CONV_MESSAGES, convId),

  // ── Attachments ──────────────────────────────────────────────────────────
  saveAttachment: (
    convId: string,
    input: AttachmentInput
  ): Promise<{ ok: true; attachment: Attachment } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.ATTACH_SAVE, convId, input),

  readAttachment: (
    id: string
  ): Promise<{ ok: true; data: string; mimeType: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.ATTACH_READ, id),

  deleteAttachment: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ATTACH_DELETE, id),

  // ── Chat (enqueue) ──────────────────────────────────────────────────────
  sendMessage: (
    req: SendMessageRequest & { targetAgentProfileId?: string }
  ): Promise<{
    queueItemId?: string;
    userMessage?: ChatMessage;
    conversation?: Conversation;
    error?: string;
  }> => ipcRenderer.invoke(IPC.CHAT_SEND, req),

  /** Cancel the active stream for a conversation (stops processing, pauses queue) */
  cancelStream: (convId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_CANCEL, convId),

  // ── Queue management ─────────────────────────────────────────────────────
  getQueue: (convId: string): Promise<{ items: QueueItem[]; paused: boolean }> =>
    ipcRenderer.invoke(IPC.QUEUE_GET, convId),

  editQueueItem: (convId: string, itemId: string, content: string, attachmentIds?: string[]): Promise<boolean> =>
    ipcRenderer.invoke(IPC.QUEUE_EDIT, convId, itemId, content, attachmentIds),

  removeQueueItem: (convId: string, itemId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.QUEUE_REMOVE, convId, itemId),

  reorderQueue: (convId: string, orderedIds: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.QUEUE_REORDER, convId, orderedIds),

  resumeQueue: (convId: string, action?: "retry" | "skip", itemId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.QUEUE_RESUME, convId, action, itemId),

  clearQueue: (convId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.QUEUE_CLEAR, convId),

  // ── Stream events ────────────────────────────────────────────────────────
  onStreamStart: (
    cb: (data: {
      streamId: string;
      userMessage?: ChatMessage;
      conversation?: Conversation;
      queueItemId?: string;
      agentProfileId?: string;
      agentNameSnapshot?: string;
      modelSnapshot?: string;
    }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string;
        userMessage?: ChatMessage;
        conversation?: Conversation;
        queueItemId?: string;
        agentProfileId?: string;
        agentNameSnapshot?: string;
        modelSnapshot?: string;
      }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_START, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_START, listener);
  },

  onStreamChunk: (
    cb: (data: { streamId: string; chunk: string }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; chunk: string }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_CHUNK, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_CHUNK, listener);
  },

  onStreamEnd: (
    cb: (data: {
      streamId: string;
      message?: ChatMessage;
      cancelled?: boolean;
      conversation?: Conversation;
      queueItemId?: string;
    }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string;
        message?: ChatMessage;
        cancelled?: boolean;
        conversation?: Conversation;
        queueItemId?: string;
      }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_END, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_END, listener);
  },

  onStreamError: (
    cb: (data: { streamId: string; message: ChatMessage; queueItemId?: string }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; message: ChatMessage; queueItemId?: string }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_ERROR, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_ERROR, listener);
  },

  /** Queue state push from main (paused, items changed) */
  onQueueState: (
    cb: (state: ConvQueueState) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: ConvQueueState
    ) => cb(state);
    ipcRenderer.on(IPC.QUEUE_STATE, listener);
    return () => ipcRenderer.removeListener(IPC.QUEUE_STATE, listener);
  },

  // ── Clipboard ──────────────────────────────────────────────────────────────
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke("clipboard:write", text),

  // ── Legacy ────────────────────────────────────────────────────────────────
  getHistory: (): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IPC.CONV_MESSAGES, ""),

  clearHistory: (): Promise<void> =>
    ipcRenderer.invoke(IPC.CONV_UPDATE, "", {}),
};

contextBridge.exposeInMainWorld("forgeApi", forgeApi);

export type ForgeApi = typeof forgeApi;