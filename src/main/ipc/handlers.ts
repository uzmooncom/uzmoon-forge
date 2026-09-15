import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/types.js";
import type {
  AgentConfig,
  ChatMessage,
  AppState,
  SendMessageRequest,
} from "../../shared/types.js";
import type { SecretStore } from "../secret-store/secrets.js";
import * as db from "../database/db.js";
import { testConnection, makeRequest } from "../agent-client/client.js";
import type { SimpleMessage } from "../agent-client/client.js";

interface Services {
  secrets: SecretStore;
  database: true;
}

// Active streaming abort signals
const activeStreams = new Map<string, { aborted: boolean }>();

export function registerHandlers(services: Services): void {
  const { secrets, database } = services;

  // ── App State ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.APP_STATE_GET, () => {
    return db.getAppState(database);
  });

  ipcMain.handle(
    IPC.APP_STATE_SET,
    (_event: IpcMainInvokeEvent, state: AppState) => {
      db.setAppState(database, state);
    }
  );

  // ── Agent Config ──────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.CONFIG_SAVE,
    (_event: IpcMainInvokeEvent, cfg: AgentConfig) => {
      db.saveAgentConfig(database, cfg);
    }
  );

  ipcMain.handle(
    IPC.CONFIG_GET,
    (_event: IpcMainInvokeEvent, id: string): AgentConfig | null => {
      return db.getAgentConfig(database, id);
    }
  );

  ipcMain.handle(
    IPC.CONFIG_DELETE,
    (_event: IpcMainInvokeEvent, id: string) => {
      db.deleteAgentConfig(database, id);
    }
  );

  // ── Secrets ───────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.SECRET_SET,
    (_event: IpcMainInvokeEvent, key: string, value: string) => {
      secrets.set(key, value);
    }
  );

  ipcMain.handle(
    IPC.SECRET_HAS,
    (_event: IpcMainInvokeEvent, key: string): boolean => {
      return secrets.has(key);
    }
  );

  ipcMain.handle(
    IPC.SECRET_DELETE,
    (_event: IpcMainInvokeEvent, key: string) => {
      secrets.delete(key);
    }
  );

  // ── Connection Test ───────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.TEST_CONNECTION,
    async (_event: IpcMainInvokeEvent, cfg: AgentConfig) => {
      const apiKey = secrets.get(cfg.id);
      if (!apiKey) {
        return {
          status: "auth_failed",
          message: "No API key stored for this agent.",
        };
      }
      return testConnection(cfg, apiKey);
    }
  );

  // ── Chat ──────────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.CHAT_SEND,
    async (event: IpcMainInvokeEvent, req: SendMessageRequest) => {
      const state = db.getAppState(database);
      if (!state.agentConfigId) {
        return { error: "No agent configured." };
      }

      const cfg = db.getAgentConfig(database, state.agentConfigId);
      if (!cfg) {
        return { error: "Agent configuration not found." };
      }

      const apiKey = secrets.get(cfg.id);
      if (!apiKey) {
        return { error: "No API key found. Please reconfigure the agent." };
      }

      // Persist user message
      const userMsg: ChatMessage = {
        id: randomUUID(),
        role: "user",
        content: req.content,
        createdAt: Date.now(),
      };
      db.insertMessage(database, userMsg);

      // Build conversation context from history
      const history = db.getAllMessages(database).filter(
        (m) => m.role === "user" || m.role === "assistant"
      );
      const contextMessages: SimpleMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Set up abort signal
      const streamId = randomUUID();
      const signal = { aborted: false };
      activeStreams.set(streamId, signal);

      const sender: WebContents = event.sender;
      const startTime = Date.now();
      let fullText = "";

      try {
        fullText = await makeRequest({
          cfg,
          apiKey,
          messages: contextMessages,
          stream: true,
          signal,
          onChunk: (chunk) => {
            if (!sender.isDestroyed()) {
              sender.send(IPC.CHAT_STREAM_CHUNK, { streamId, chunk });
            }
          },
        });

        const durationMs = Date.now() - startTime;
        const assistantMsg: ChatMessage = {
          id: randomUUID(),
          role: "assistant",
          content: fullText,
          createdAt: Date.now(),
          model: cfg.model,
          durationMs,
        };
        db.insertMessage(database, assistantMsg);

        if (!sender.isDestroyed()) {
          sender.send(IPC.CHAT_STREAM_END, { streamId, message: assistantMsg });
        }

        return { streamId, userMessage: userMsg };
      } catch (err: unknown) {
        activeStreams.delete(streamId);

        if (err instanceof Error && err.message === "cancelled") {
          if (!sender.isDestroyed()) {
            sender.send(IPC.CHAT_STREAM_END, { streamId, cancelled: true });
          }
          return { streamId, userMessage: userMsg, cancelled: true };
        }

        const errMsg =
          err instanceof Error ? err.message : "Unknown error";
        const errorMessage: ChatMessage = {
          id: randomUUID(),
          role: "error",
          content: `Request failed: ${errMsg}`,
          createdAt: Date.now(),
        };
        db.insertMessage(database, errorMessage);

        if (!sender.isDestroyed()) {
          sender.send(IPC.CHAT_STREAM_ERROR, {
            streamId,
            message: errorMessage,
          });
        }

        return { streamId, userMessage: userMsg, error: errMsg };
      } finally {
        activeStreams.delete(streamId);
      }
    }
  );

  ipcMain.handle(IPC.CHAT_CANCEL, (_event: IpcMainInvokeEvent, streamId: string) => {
    const signal = activeStreams.get(streamId);
    if (signal) {
      signal.aborted = true;
    }
  });

  // ── History ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.HISTORY_GET, (): ChatMessage[] => {
    return db.getAllMessages(database);
  });

  ipcMain.handle(IPC.HISTORY_CLEAR, () => {
    db.clearMessages(database);
  });
}