import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/types.js";
import type {
  AgentConfig,
  AppState,
  ChatMessage,
  Conversation,
  Attachment,
  AttachmentInput,
  ConnectionTestResult,
  SendMessageRequest,
} from "../shared/types.js";

type UnsubFn = () => void;

const forgeApi = {
  // ── App State ──────────────────────────────────────────────────────────
  getAppState: (): Promise<AppState> =>
    ipcRenderer.invoke(IPC.APP_STATE_GET),

  setAppState: (state: AppState): Promise<void> =>
    ipcRenderer.invoke(IPC.APP_STATE_SET, state),

  // ── Agent Config ────────────────────────────────────────────────────────
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
  listConversations: (): Promise<Conversation[]> =>
    ipcRenderer.invoke(IPC.CONV_LIST),

  getConversation: (id: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC.CONV_GET, id),

  createConversation: (conv: Conversation): Promise<void> =>
    ipcRenderer.invoke(IPC.CONV_CREATE, conv),

  updateConversation: (
    id: string,
    patch: Partial<Pick<Conversation, "title" | "updatedAt">>
  ): Promise<void> => ipcRenderer.invoke(IPC.CONV_UPDATE, id, patch),

  deleteConversation: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CONV_DELETE, id),

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

  // ── Chat ────────────────────────────────────────────────────────────────
  sendMessage: (
    req: SendMessageRequest
  ): Promise<{
    streamId: string;
    userMessage: ChatMessage;
    error?: string;
    cancelled?: boolean;
  }> => ipcRenderer.invoke(IPC.CHAT_SEND, req),

  cancelStream: (streamId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_CANCEL, streamId),

  onStreamStart: (
    cb: (data: { streamId: string; userMessage: ChatMessage; conversation: Conversation }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; userMessage: ChatMessage; conversation: Conversation }
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
    }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string;
        message?: ChatMessage;
        cancelled?: boolean;
        conversation?: Conversation;
      }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_END, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_END, listener);
  },

  onStreamError: (
    cb: (data: { streamId: string; message: ChatMessage }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; message: ChatMessage }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_ERROR, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_ERROR, listener);
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