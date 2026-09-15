import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/types.js";
import type {
  AgentConfig,
  AppState,
  ChatMessage,
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
    }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; message?: ChatMessage; cancelled?: boolean }
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

  // ── History ──────────────────────────────────────────────────────────────
  getHistory: (): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IPC.HISTORY_GET),

  clearHistory: (): Promise<void> =>
    ipcRenderer.invoke(IPC.HISTORY_CLEAR),
};

contextBridge.exposeInMainWorld("forgeApi", forgeApi);

// Type augmentation for renderer TypeScript
export type ForgeApi = typeof forgeApi;