import { ipcMain, IpcMainInvokeEvent, WebContents, clipboard } from "electron";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { IPC } from "../../shared/types.js";
import type {
  AgentConfig,
  AppState,
  Conversation,
  Attachment,
  AttachmentInput,
  SendMessageRequest,
} from "../../shared/types.js";
import type { SecretStore } from "../secret-store/secrets.js";
import * as db from "../database/db.js";
import { testConnection } from "../agent-client/client.js";
import { queueManager, cancelStream, getActiveStreamId } from "../queue/QueueManager.js";

interface Services {
  secrets: SecretStore;
  database: true;
}

// ── Attachment constants ──────────────────────────────────────────────────

const ALLOWED_MIME = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/html", "text/css", "text/javascript", "text/csv",
  "text/markdown", "text/x-markdown",
  "application/json",
  "application/xml", "text/xml",
  "application/x-yaml", "text/yaml",
  "application/zip", "application/x-tar", "application/gzip",
]);

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_ATTACHMENTS_PER_MSG = 10;

function extForMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
    "image/webp": "webp", "image/gif": "gif",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/plain": "txt", "text/html": "html", "text/css": "css",
    "text/javascript": "js", "text/csv": "csv",
    "text/markdown": "md", "text/x-markdown": "md",
    "application/json": "json",
    "application/xml": "xml", "text/xml": "xml",
    "application/x-yaml": "yaml", "text/yaml": "yaml",
    "application/zip": "zip", "application/x-tar": "tar", "application/gzip": "gz",
  };
  return map[mimeType] ?? "bin";
}

export function registerHandlers(services: Services, mainSender: WebContents): void {
  const { secrets, database } = services;

  // Wire queue manager sender so it can push events to renderer
  queueManager.setSender(mainSender);

  // Helper to get current agent config + apiKey
  function resolveAgent(): { cfg: AgentConfig; apiKey: string } | { error: string } {
    const state = db.getAppState(database);
    if (!state.agentConfigId) return { error: "No agent configured." };
    const cfg = db.getAgentConfig(database, state.agentConfigId);
    if (!cfg) return { error: "Agent configuration not found." };
    const apiKey = secrets.get(cfg.id);
    if (!apiKey) return { error: "No API key found. Please reconfigure the agent." };
    return { cfg, apiKey };
  }

  // ── App State ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.APP_STATE_GET, () => db.getAppState(database));

  ipcMain.handle(IPC.APP_STATE_SET, (_e: IpcMainInvokeEvent, state: AppState) => {
    db.setAppState(database, state);
  });

  // ── Agent Config ───────────────────────────────────────────────────────

  ipcMain.handle(IPC.CONFIG_SAVE, (_e: IpcMainInvokeEvent, cfg: AgentConfig) => {
    db.saveAgentConfig(database, cfg);
  });

  ipcMain.handle(IPC.CONFIG_GET, (_e: IpcMainInvokeEvent, id: string): AgentConfig | null => {
    return db.getAgentConfig(database, id);
  });

  ipcMain.handle(IPC.CONFIG_DELETE, (_e: IpcMainInvokeEvent, id: string) => {
    db.deleteAgentConfig(database, id);
  });

  // ── Secrets ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SECRET_SET, (_e: IpcMainInvokeEvent, key: string, value: string) => {
    secrets.set(key, value);
  });

  ipcMain.handle(IPC.SECRET_HAS, (_e: IpcMainInvokeEvent, key: string): boolean => {
    return secrets.has(key);
  });

  ipcMain.handle(IPC.SECRET_DELETE, (_e: IpcMainInvokeEvent, key: string) => {
    secrets.delete(key);
  });

  // ── Connection Test ────────────────────────────────────────────────────

  ipcMain.handle(IPC.TEST_CONNECTION, async (_e: IpcMainInvokeEvent, cfg: AgentConfig) => {
    const apiKey = secrets.get(cfg.id);
    if (!apiKey) return { status: "auth_failed", message: "No API key stored for this agent." };
    return testConnection(cfg, apiKey);
  });

  // ── Conversations ──────────────────────────────────────────────────────

  ipcMain.handle(IPC.CONV_LIST, (_e: IpcMainInvokeEvent, includeArchived?: boolean): Conversation[] => {
    return db.listConversations(database, includeArchived ?? false);
  });

  ipcMain.handle(IPC.CONV_GET, (_e: IpcMainInvokeEvent, id: string): Conversation | null => {
    return db.getConversation(database, id);
  });

  ipcMain.handle(IPC.CONV_CREATE, (_e: IpcMainInvokeEvent, conv: Conversation): void => {
    db.createConversation(database, conv);
  });

  ipcMain.handle(
    IPC.CONV_UPDATE,
    (
      _e: IpcMainInvokeEvent,
      id: string,
      patch: Partial<Pick<Conversation, "title" | "updatedAt" | "pinnedAt" | "archivedAt">>
    ): void => {
      db.updateConversation(database, id, patch);
    }
  );

  ipcMain.handle(IPC.CONV_SEARCH, (_e: IpcMainInvokeEvent, query: string): Conversation[] => {
    return db.searchConversations(database, query);
  });

  ipcMain.handle(IPC.CONV_EXPORT, (_e: IpcMainInvokeEvent, id: string): string => {
    return db.exportConversationMarkdown(database, id);
  });

  ipcMain.handle(IPC.MSG_SEARCH, (_e: IpcMainInvokeEvent, query: string) => {
    return db.searchMessages(database, query);
  });

  ipcMain.handle(IPC.CONV_DELETE, (_e: IpcMainInvokeEvent, id: string): void => {
    // Cancel any active stream for this conversation
    const sid = getActiveStreamId(id);
    if (sid) cancelStream(sid);
    const filePaths = db.deleteConversation(database, id);
    for (const fp of filePaths) {
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* best effort */ }
    }
    const dataDir = db.getDataDir();
    const attDir = path.join(dataDir, "attachments", id);
    try { if (fs.existsSync(attDir)) fs.rmdirSync(attDir); } catch { /* not empty */ }
  });

  ipcMain.handle(IPC.CONV_MESSAGES, (_e: IpcMainInvokeEvent, convId: string) => {
    return db.getMessagesByConversation(database, convId);
  });

  ipcMain.handle(
    IPC.CONV_BRANCH,
    (_e: IpcMainInvokeEvent, sourceConvId: string, upToMessageId: string): Conversation | null => {
      const newConvId = randomUUID();
      return db.branchConversation(database, sourceConvId, upToMessageId, newConvId);
    }
  );

  // ── Attachments ────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.ATTACH_SAVE,
    (
      _e: IpcMainInvokeEvent,
      convId: string,
      input: AttachmentInput
    ): { ok: true; attachment: Attachment } | { ok: false; error: string } => {
      if (!ALLOWED_MIME.has(input.mimeType)) return { ok: false, error: "Unsupported file type." };
      if (input.size > MAX_ATTACHMENT_SIZE) return { ok: false, error: "File too large (max 20 MB)." };

      const dataDir = db.getDataDir();
      const attDir = path.join(dataDir, "attachments", convId);
      if (!fs.existsSync(attDir)) fs.mkdirSync(attDir, { recursive: true });

      const id = randomUUID();
      const ext = extForMime(input.mimeType);
      const localPath = path.join(attDir, `${id}.${ext}`);

      try {
        fs.writeFileSync(localPath, Buffer.from(input.data, "base64"));
      } catch {
        return { ok: false, error: "Failed to save attachment." };
      }

      const att: Attachment = {
        id,
        messageId: "",
        conversationId: convId,
        mimeType: input.mimeType,
        filename: input.filename,
        localPath,
        size: input.size,
        ...(input.width !== undefined && { width: input.width }),
        ...(input.height !== undefined && { height: input.height }),
      };
      db.saveAttachmentMeta(database, att);
      return { ok: true, attachment: att };
    }
  );

  ipcMain.handle(
    IPC.ATTACH_READ,
    (
      _e: IpcMainInvokeEvent,
      id: string
    ): { ok: true; data: string; mimeType: string } | { ok: false; error: string } => {
      const att = db.getAttachment(database, id);
      if (!att) return { ok: false, error: "Attachment not found." };
      try {
        const data = fs.readFileSync(att.localPath).toString("base64");
        return { ok: true, data, mimeType: att.mimeType };
      } catch {
        return { ok: false, error: "Failed to read attachment." };
      }
    }
  );

  ipcMain.handle(IPC.ATTACH_DELETE, (_e: IpcMainInvokeEvent, id: string): void => {
    const localPath = db.deleteAttachment(database, id);
    if (localPath) {
      try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch { /* best effort */ }
    }
  });

  // ── Chat (enqueue) ─────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.CHAT_SEND,
    async (_e: IpcMainInvokeEvent, req: SendMessageRequest) => {
      const agent = resolveAgent();
      if ("error" in agent) return { error: agent.error };

      const { conversationId, content, attachmentIds = [], replyToMessageId } = req;

      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MSG) {
        return { error: `Too many attachments (max ${MAX_ATTACHMENTS_PER_MSG}).` };
      }

      try {
        const result = await queueManager.enqueue({
          conversationId,
          content,
          attachmentIds,
          ...(replyToMessageId && { replyToMessageId }),
          cfg: agent.cfg,
          apiKey: agent.apiKey,
        });
        return {
          queueItemId: result.queueItem.id,
          userMessage: result.userMessage,
          conversation: result.conversation,
        };
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : "Failed to enqueue message." };
      }
    }
  );

  // Cancel current active stream for a conversation
  ipcMain.handle(IPC.CHAT_CANCEL, (_e: IpcMainInvokeEvent, convId: string) => {
    const sid = getActiveStreamId(convId);
    if (sid) cancelStream(sid);
  });

  // ── Queue management IPC ───────────────────────────────────────────────

  ipcMain.handle(IPC.QUEUE_GET, (_e: IpcMainInvokeEvent, convId: string) => {
    return queueManager.getQueue(convId);
  });

  ipcMain.handle(
    IPC.QUEUE_EDIT,
    (_e: IpcMainInvokeEvent, convId: string, itemId: string, content: string, attachmentIds?: string[]) => {
      return queueManager.editItem(convId, itemId, content, attachmentIds);
    }
  );

  ipcMain.handle(
    IPC.QUEUE_REMOVE,
    (_e: IpcMainInvokeEvent, convId: string, itemId: string) => {
      return queueManager.removeItem(convId, itemId);
    }
  );

  ipcMain.handle(
    IPC.QUEUE_REORDER,
    (_e: IpcMainInvokeEvent, convId: string, orderedIds: string[]) => {
      queueManager.reorder(convId, orderedIds);
    }
  );

  ipcMain.handle(
    IPC.QUEUE_RESUME,
    async (_e: IpcMainInvokeEvent, convId: string, action?: "retry" | "skip", itemId?: string): Promise<{ error: string } | void> => {
      const agent = resolveAgent();
      if ("error" in agent) return { error: agent.error };
      if (action === "retry" && itemId) {
        await queueManager.retry(convId, itemId, agent.cfg, agent.apiKey);
      } else if (action === "skip" && itemId) {
        await queueManager.skip(convId, itemId, agent.cfg, agent.apiKey);
      } else {
        await queueManager.resume(convId, agent.cfg, agent.apiKey);
      }
    }
  );

  ipcMain.handle(IPC.QUEUE_CLEAR, (_e: IpcMainInvokeEvent, convId: string) => {
    queueManager.clearQueue(convId);
  });

  // ── Clipboard ──────────────────────────────────────────────────────────

  ipcMain.handle("clipboard:write", (_e: IpcMainInvokeEvent, text: string) => {
    clipboard.writeText(text);
  });
}