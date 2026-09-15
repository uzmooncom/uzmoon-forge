import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { IPC } from "../../shared/types.js";
import type {
  AgentConfig,
  ChatMessage,
  AppState,
  Conversation,
  Attachment,
  AttachmentInput,
  SendMessageRequest,
} from "../../shared/types.js";
import type { SecretStore } from "../secret-store/secrets.js";
import * as db from "../database/db.js";
import { makeRequest, classifyError } from "../agent-client/client.js";
import type { SimpleMessage, ImageContent } from "../agent-client/client.js";
import { testConnection } from "../agent-client/client.js";

interface Services {
  secrets: SecretStore;
  database: true;
}

// Active streaming abort signals
const activeStreams = new Map<string, { aborted: boolean }>();

// Allowed MIME types
const ALLOWED_MIME = new Set([
  // Images
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Text / code
  "text/plain", "text/html", "text/css", "text/javascript", "text/csv",
  "text/markdown", "text/x-markdown",
  "application/json",
  "application/xml", "text/xml",
  "application/x-yaml", "text/yaml",
  // Archives
  "application/zip",
  "application/x-tar",
  "application/gzip",
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
    "application/zip": "zip",
    "application/x-tar": "tar",
    "application/gzip": "gz",
  };
  return map[mimeType] ?? "bin";
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/** Generate a deterministic title from the first user message */
function autoTitle(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "New conversation";
  // Take up to 6 words
  const words = trimmed.split(/\s+/).slice(0, 6).join(" ");
  return words.length < trimmed.length ? words : trimmed;
}

/** Build SimpleMessage array from stored messages (normalize for protocol) */
function buildContextMessages(msgs: ChatMessage[]): SimpleMessage[] {
  // Build lookup for reply-to threading
  const msgById = new Map<string, ChatMessage>();
  for (const m of msgs) msgById.set(m.id, m);

  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): SimpleMessage => {
      // Compute effective content — prepend reply quote for threaded messages
      let effectiveContent = m.content;
      if (m.role === "user" && m.replyToMessageId) {
        const parent = msgById.get(m.replyToMessageId);
        if (parent) {
          const roleLabel = parent.role === "user" ? "User" : "Assistant";
          const snippet = parent.content.slice(0, 400) + (parent.content.length > 400 ? "..." : "");
          effectiveContent = `[Replying to ${roleLabel}: "${snippet}"\n]\n${m.content}`;
        }
      }

      if (m.attachments && m.attachments.length > 0 && m.role === "user") {
        const parts: Array<{ type: "text"; text: string } | ImageContent> = [];
        if (effectiveContent.trim()) {
          parts.push({ type: "text", text: effectiveContent });
        }
        for (const att of m.attachments) {
          try {
            if (isImageMime(att.mimeType)) {
              // Images: send as base64 vision content
              const data = fs.readFileSync(att.localPath).toString("base64");
              parts.push({ type: "image", mimeType: att.mimeType, data });
            } else {
              // Non-image: read as text and inject as a labeled text block
              const raw = fs.readFileSync(att.localPath);
              const MAX_CHARS = 100_000;
              let text: string;
              try {
                text = raw.toString("utf8");
                if (text.length > MAX_CHARS) {
                  text = text.slice(0, MAX_CHARS) + `\n... [truncated, ${raw.length} bytes total]`;
                }
              } catch {
                text = `[binary file: ${att.filename}, ${raw.length} bytes]`;
              }
              parts.push({ type: "text", text: `<file name="${att.filename}" type="${att.mimeType}">\n${text}\n</file>` });
            }
          } catch {
            // file missing — skip
          }
        }
        // Collapse single text part to string form
        if (parts.length === 1 && parts[0]!.type === "text") {
          return { role: "user", content: (parts[0] as { type: "text"; text: string }).text };
        }
        return { role: "user", content: parts };
      }
      return { role: m.role as "user" | "assistant", content: effectiveContent };
    });
}

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

  // ── Conversations ─────────────────────────────────────────────────────────

  ipcMain.handle(IPC.CONV_LIST, (_event: IpcMainInvokeEvent, includeArchived?: boolean): Conversation[] => {
    return db.listConversations(database, includeArchived ?? false);
  });

  ipcMain.handle(
    IPC.CONV_GET,
    (_event: IpcMainInvokeEvent, id: string): Conversation | null => {
      return db.getConversation(database, id);
    }
  );

  ipcMain.handle(
    IPC.CONV_CREATE,
    (_event: IpcMainInvokeEvent, conv: Conversation): void => {
      db.createConversation(database, conv);
    }
  );

  ipcMain.handle(
    IPC.CONV_UPDATE,
    (
      _event: IpcMainInvokeEvent,
      id: string,
      patch: Partial<Pick<Conversation, "title" | "updatedAt" | "pinnedAt" | "archivedAt">>
    ): void => {
      db.updateConversation(database, id, patch);
    }
  );

  ipcMain.handle(
    IPC.CONV_SEARCH,
    (_event: IpcMainInvokeEvent, query: string): Conversation[] => {
      return db.searchConversations(database, query);
    }
  );

  ipcMain.handle(
    IPC.CONV_EXPORT,
    (_event: IpcMainInvokeEvent, id: string): string => {
      return db.exportConversationMarkdown(database, id);
    }
  );

  ipcMain.handle(
    IPC.MSG_SEARCH,
    (_event: IpcMainInvokeEvent, query: string): Array<{ message: ChatMessage; conversation: Conversation }> => {
      return db.searchMessages(database, query);
    }
  );

  ipcMain.handle(
    IPC.CONV_DELETE,
    (_event: IpcMainInvokeEvent, id: string): void => {
      const filePaths = db.deleteConversation(database, id);
      // Delete attachment files from disk
      for (const fp of filePaths) {
        try {
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch {
          // best effort
        }
      }
      // Remove attachment directory if empty
      const dataDir = db.getDataDir();
      const attDir = path.join(dataDir, "attachments", id);
      try {
        if (fs.existsSync(attDir)) fs.rmdirSync(attDir);
      } catch {
        // not empty — ignore
      }
    }
  );

  ipcMain.handle(
    IPC.CONV_MESSAGES,
    (_event: IpcMainInvokeEvent, convId: string): ChatMessage[] => {
      return db.getMessagesByConversation(database, convId);
    }
  );

  // ── Attachments ───────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.ATTACH_SAVE,
    (
      _event: IpcMainInvokeEvent,
      convId: string,
      input: AttachmentInput
    ): { ok: true; attachment: Attachment } | { ok: false; error: string } => {
      // Validate
      if (!ALLOWED_MIME.has(input.mimeType)) {
        return { ok: false, error: "Unsupported file type." };
      }
      if (input.size > MAX_ATTACHMENT_SIZE) {
        return { ok: false, error: "File too large (max 10 MB)." };
      }

      // Write to disk
      const dataDir = db.getDataDir();
      const attDir = path.join(dataDir, "attachments", convId);
      if (!fs.existsSync(attDir)) fs.mkdirSync(attDir, { recursive: true });

      const id = randomUUID();
      const ext = extForMime(input.mimeType);
      const localPath = path.join(attDir, `${id}.${ext}`);

      try {
        fs.writeFileSync(localPath, Buffer.from(input.data, "base64"));
      } catch (e) {
        return { ok: false, error: "Failed to save attachment." };
      }

      const att: Attachment = {
        id,
        messageId: "", // will be set when message is inserted
        conversationId: convId,
        mimeType: input.mimeType,
        filename: input.filename,
        localPath,
        size: input.size,
        ...(input.width !== undefined && { width: input.width }),
        ...(input.height !== undefined && { height: input.height }),
      };

      // Persist to DB so CHAT_SEND can look up by ID
      db.saveAttachmentMeta(database, att);

      return { ok: true, attachment: att };
    }
  );

  ipcMain.handle(
    IPC.ATTACH_READ,
    (
      _event: IpcMainInvokeEvent,
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

  ipcMain.handle(
    IPC.ATTACH_DELETE,
    (_event: IpcMainInvokeEvent, id: string): void => {
      const localPath = db.deleteAttachment(database, id);
      if (localPath) {
        try {
          if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        } catch {
          // best effort
        }
      }
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

      const { conversationId, content, attachmentIds = [], replyToMessageId } = req;

      // Validate attachment count
      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MSG) {
        return { error: `Too many attachments (max ${MAX_ATTACHMENTS_PER_MSG}).` };
      }

      // Resolve attachment metadata (pre-saved to disk)
      const attachments: Attachment[] = [];
      for (const attId of attachmentIds) {
        const att = db.getAttachment(database, attId);
        if (att) attachments.push(att);
      }

      // Lazy conversation creation
      let conv = db.getConversation(database, conversationId);
      if (!conv) {
        const now = Date.now();
        const title = content.trim()
          ? autoTitle(content)
          : attachments.length > 0
          ? "Image conversation"
          : "New conversation";
        conv = { id: conversationId, title, createdAt: now, updatedAt: now };
        db.createConversation(database, conv);
      }

      // Persist user message
      const userMsg: ChatMessage = {
        id: randomUUID(),
        conversationId,
        role: "user",
        content,
        createdAt: Date.now(),
        ...(attachments.length > 0 && { attachments }),
        ...(replyToMessageId && { replyToMessageId }),
      };
      // Update attachment metadata with the message ID
      for (const att of attachments) {
        att.messageId = userMsg.id;
        db.saveAttachmentMeta(database, att);
      }
      db.insertMessage(database, userMsg);

      // Update conversation updatedAt
      db.updateConversation(database, conversationId, { updatedAt: Date.now() });

      // Build context from conversation history
      const history = db.getMessagesByConversation(database, conversationId);
      const contextMessages: SimpleMessage[] = buildContextMessages(history);

      // Set up abort signal
      const streamId = randomUUID();
      const signal = { aborted: false };
      activeStreams.set(streamId, signal);

      const sender: WebContents = event.sender;
      const startTime = Date.now();
      let fullText = "";

      // Emit start event immediately so renderer shows dots before API responds
      if (!sender.isDestroyed()) {
        sender.send(IPC.CHAT_STREAM_START, { streamId, userMessage: userMsg, conversation: conv });
      }

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
          conversationId,
          role: "assistant",
          content: fullText,
          createdAt: Date.now(),
          model: cfg.model,
          durationMs,
        };
        db.insertMessage(database, assistantMsg);
        db.updateConversation(database, conversationId, { updatedAt: Date.now() });

        if (!sender.isDestroyed()) {
          sender.send(IPC.CHAT_STREAM_END, {
            streamId,
            message: assistantMsg,
            conversation: db.getConversation(database, conversationId),
          });
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

        const result = classifyError(err);
        let errorContent = result.message;

        if (err instanceof Error && err.message === "image_unsupported") {
          errorContent = "This model or endpoint does not appear to support image input.";
        }

        const errorMessage: ChatMessage = {
          id: randomUUID(),
          conversationId,
          role: "error",
          content: errorContent,
          createdAt: Date.now(),
          isError: true,
        };
        db.insertMessage(database, errorMessage);

        if (!sender.isDestroyed()) {
          sender.send(IPC.CHAT_STREAM_ERROR, {
            streamId,
            message: errorMessage,
          });
        }

        return { streamId, userMessage: userMsg, error: result.message };
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

}