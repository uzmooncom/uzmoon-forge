/**
 * QueueManager — per-conversation message queue sequencer.
 *
 * Rules:
 * - One active generation per conversation at most.
 * - Context is rebuilt fresh from DB when each item begins processing.
 * - On stop/failure, queue is paused — user must explicitly resume.
 * - On restart, any "processing" items were already recovered to "paused" by db.load().
 */
import { randomUUID } from "crypto";
import { WebContents } from "electron";
import { IPC } from "../../shared/types.js";
import type { QueueItem, ChatMessage, Conversation, AgentConfig } from "../../shared/types.js";
import * as db from "../database/db.js";
import { makeRequest, classifyError } from "../agent-client/client.js";
import type { SimpleMessage, ImageContent } from "../agent-client/client.js";
import fs from "fs";

// ── Context builder (shared with handlers) ────────────────────────────────

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function buildContextMessages(msgs: ChatMessage[]): SimpleMessage[] {
  const msgById = new Map<string, ChatMessage>();
  for (const m of msgs) msgById.set(m.id, m);

  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): SimpleMessage => {
      let effectiveContent = m.content;
      if (m.role === "user" && m.replyToMessageId) {
        const parent = msgById.get(m.replyToMessageId);
        if (parent) {
          const roleLabel = parent.role === "user" ? "User" : "Assistant";
          const snippet =
            parent.content.slice(0, 400) + (parent.content.length > 400 ? "..." : "");
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
              const data = fs.readFileSync(att.localPath).toString("base64");
              parts.push({ type: "image", mimeType: att.mimeType, data });
            } else {
              const raw = fs.readFileSync(att.localPath);
              const MAX_CHARS = 100_000;
              let text: string;
              try {
                text = raw.toString("utf8");
                if (text.length > MAX_CHARS) {
                  text =
                    text.slice(0, MAX_CHARS) +
                    `\n... [truncated, ${raw.length} bytes total]`;
                }
              } catch {
                text = `[binary file: ${att.filename}, ${raw.length} bytes]`;
              }
              parts.push({
                type: "text",
                text: `<file name="${att.filename}" type="${att.mimeType}">\n${text}\n</file>`,
              });
            }
          } catch {
            // file missing — skip
          }
        }
        if (parts.length === 1 && parts[0]!.type === "text") {
          return {
            role: "user",
            content: (parts[0] as { type: "text"; text: string }).text,
          };
        }
        return { role: "user", content: parts };
      }
      return { role: m.role as "user" | "assistant", content: effectiveContent };
    });
}

// ── Active stream signals ──────────────────────────────────────────────────

/** streamId → abort signal, keyed by conversationId */
const activeStreams = new Map<string, { aborted: boolean; convId: string }>();
/** conversationId → streamId */
const convToStream = new Map<string, string>();

export function getActiveStreamId(convId: string): string | undefined {
  return convToStream.get(convId);
}

export function cancelStream(streamId: string): void {
  const sig = activeStreams.get(streamId);
  if (sig) sig.aborted = true;
}

// ── Dispatch lock (prevents double-processing same conv) ──────────────────

const processing = new Set<string>();

// ── Main queue processor ───────────────────────────────────────────────────

export class QueueManager {
  private sender: WebContents | null = null;

  setSender(wc: WebContents): void {
    this.sender = wc;
  }

  private send<T>(channel: string, data: T): void {
    if (this.sender && !this.sender.isDestroyed()) {
      this.sender.send(channel, data);
    }
  }

  /** Push queue state update to renderer */
  private pushQueueState(convId: string): void {
    const state = db.getConvQueue(true, convId);
    this.send(IPC.QUEUE_STATE, { conversationId: convId, ...state });
  }

  /**
   * Enqueue a new message request. Saves the user message to DB first,
   * then adds a QueueItem, then tries to process immediately if free.
   */
  async enqueue(opts: {
    conversationId: string;
    content: string;
    attachmentIds: string[];
    replyToMessageId?: string;
    cfg: AgentConfig;
    apiKey: string;
  }): Promise<{
    queueItem: QueueItem;
    userMessage: ChatMessage;
    conversation: Conversation;
  }> {
    const { conversationId, content, attachmentIds, replyToMessageId, cfg, apiKey } = opts;

    // Ensure conversation exists
    let conv = db.getConversation(true, conversationId);
    if (!conv) {
      const now = Date.now();
      const title = content.trim() ? autoTitle(content) : "New conversation";
      conv = { id: conversationId, title, createdAt: now, updatedAt: now };
      db.createConversation(true, conv);
    }

    // Resolve attachments
    const attachments = attachmentIds
      .map((id) => db.getAttachment(true, id))
      .filter((a): a is NonNullable<typeof a> => a !== null);

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
    for (const att of attachments) {
      att.messageId = userMsg.id;
      db.saveAttachmentMeta(true, att);
    }
    db.insertMessage(true, userMsg);
    db.updateConversation(true, conversationId, { updatedAt: Date.now() });

    // Create queue item
    const queueItem: QueueItem = {
      id: randomUUID(),
      conversationId,
      messageId: userMsg.id,
      content,
      attachmentIds,
      status: "queued",
      createdAt: Date.now(),
      attemptCount: 0,
      ...(replyToMessageId && { replyToMessageId }),
    };
    db.enqueueItem(true, queueItem);

    const updatedConv = db.getConversation(true, conversationId)!;
    this.pushQueueState(conversationId);

    // Try to process immediately
    void this.processNext(conversationId, cfg, apiKey);

    return { queueItem, userMessage: userMsg, conversation: updatedConv };
  }

  /** Process the next queued item for a conversation if free */
  async processNext(
    convId: string,
    cfg: AgentConfig,
    apiKey: string
  ): Promise<void> {
    if (processing.has(convId)) return;
    if (db.hasProcessingItem(true, convId)) return;

    const item = db.nextQueuedItem(true, convId);
    if (!item) return;

    processing.add(convId);

    try {
      await this.processItem(item, cfg, apiKey);
    } finally {
      processing.delete(convId);
    }

    // After completion, try next
    const next = db.nextQueuedItem(true, convId);
    if (next) {
      void this.processNext(convId, cfg, apiKey);
    }
  }

  private async processItem(
    item: QueueItem,
    cfg: AgentConfig,
    apiKey: string
  ): Promise<void> {
    const { conversationId } = item;

    // Mark processing
    db.updateQueueItem(true, conversationId, item.id, {
      status: "processing",
      startedAt: Date.now(),
      attemptCount: item.attemptCount + 1,
    });
    this.pushQueueState(conversationId);

    // Build fresh context from current persisted messages
    const history = db.getMessagesByConversation(true, conversationId);
    const contextMessages = buildContextMessages(history);

    const streamId = randomUUID();
    const signal = { aborted: false, convId: conversationId };
    activeStreams.set(streamId, signal);
    convToStream.set(conversationId, streamId);

    const startTime = Date.now();
    let fullText = "";

    // Emit stream start so renderer shows typing indicator
    this.send(IPC.CHAT_STREAM_START, {
      streamId,
      userMessage: db.getMessagesByConversation(true, conversationId)
        .find((m) => m.id === item.messageId),
      conversation: db.getConversation(true, conversationId),
      queueItemId: item.id,
    });

    try {
      fullText = await makeRequest({
        cfg,
        apiKey,
        messages: contextMessages,
        stream: true,
        signal,
        onChunk: (chunk) => {
          this.send(IPC.CHAT_STREAM_CHUNK, { streamId, chunk });
        },
      });

      activeStreams.delete(streamId);
      convToStream.delete(conversationId);

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
      db.insertMessage(true, assistantMsg);
      db.updateConversation(true, conversationId, { updatedAt: Date.now() });

      db.updateQueueItem(true, conversationId, item.id, {
        status: "completed",
        completedAt: Date.now(),
      });
      db.pruneQueueHistory(true, conversationId);

      this.send(IPC.CHAT_STREAM_END, {
        streamId,
        message: assistantMsg,
        conversation: db.getConversation(true, conversationId),
        queueItemId: item.id,
      });

      this.pushQueueState(conversationId);
    } catch (err: unknown) {
      activeStreams.delete(streamId);
      convToStream.delete(conversationId);

      if (err instanceof Error && err.message === "cancelled") {
        // Partial content — keep if meaningful
        if (fullText.trim()) {
          const partialMsg: ChatMessage = {
            id: randomUUID(),
            conversationId,
            role: "assistant",
            content: fullText,
            createdAt: Date.now(),
            model: cfg.model,
            durationMs: Date.now() - startTime,
          };
          db.insertMessage(true, partialMsg);
          db.updateConversation(true, conversationId, { updatedAt: Date.now() });
          this.send(IPC.CHAT_STREAM_END, {
            streamId,
            message: partialMsg,
            cancelled: true,
            conversation: db.getConversation(true, conversationId),
            queueItemId: item.id,
          });
        } else {
          this.send(IPC.CHAT_STREAM_END, {
            streamId,
            cancelled: true,
            conversation: db.getConversation(true, conversationId),
            queueItemId: item.id,
          });
        }

        // Stop + pause queue
        db.updateQueueItem(true, conversationId, item.id, {
          status: "cancelled",
          completedAt: Date.now(),
        });
        db.setQueuePaused(true, conversationId, true);
        this.pushQueueState(conversationId);
        return;
      }

      // Real error — pause queue
      const result = classifyError(err);
      let errorContent = result.message;
      if (err instanceof Error && err.message === "image_unsupported") {
        errorContent = "This model or endpoint does not support image input.";
      }

      const errorMsg: ChatMessage = {
        id: randomUUID(),
        conversationId,
        role: "error",
        content: errorContent,
        createdAt: Date.now(),
        isError: true,
      };
      db.insertMessage(true, errorMsg);

      this.send(IPC.CHAT_STREAM_ERROR, { streamId, message: errorMsg, queueItemId: item.id });

      db.updateQueueItem(true, conversationId, item.id, {
        status: "failed",
        completedAt: Date.now(),
        lastError: errorContent,
      });
      db.setQueuePaused(true, conversationId, true);
      this.pushQueueState(conversationId);
    }
  }

  /** Resume a paused queue (after user stops/failure) */
  async resume(convId: string, cfg: AgentConfig, apiKey: string): Promise<void> {
    db.setQueuePaused(true, convId, false);
    this.pushQueueState(convId);
    void this.processNext(convId, cfg, apiKey);
  }

  /** Retry failed item (reset status to queued) */
  async retry(convId: string, itemId: string, cfg: AgentConfig, apiKey: string): Promise<void> {
    const { lastError: _le, startedAt: _sa, completedAt: _ca, ...rest } = db.getConvQueue(true, convId).items.find((i) => i.id === itemId) ?? {} as QueueItem;
    void _le; void _sa; void _ca;
    db.updateQueueItem(true, convId, itemId, { ...rest, status: "queued" });
    db.setQueuePaused(true, convId, false);
    this.pushQueueState(convId);
    void this.processNext(convId, cfg, apiKey);
  }

  /** Skip failed item — mark cancelled and resume */
  async skip(convId: string, itemId: string, cfg: AgentConfig, apiKey: string): Promise<void> {
    db.updateQueueItem(true, convId, itemId, {
      status: "cancelled",
      completedAt: Date.now(),
    });
    db.setQueuePaused(true, convId, false);
    this.pushQueueState(convId);
    void this.processNext(convId, cfg, apiKey);
  }

  /** Edit a queued (not processing) item's content */
  editItem(convId: string, itemId: string, content: string, attachmentIds?: string[]): boolean {
    const q = db.getConvQueue(true, convId);
    const item = q.items.find((i) => i.id === itemId);
    if (!item || item.status === "processing") return false;
    const patch: Partial<QueueItem> = { content };
    if (attachmentIds !== undefined) patch.attachmentIds = attachmentIds;
    db.updateQueueItem(true, convId, itemId, patch);
    // Also update the persisted user message content
    this.updateMessageContent(convId, item.messageId, content);
    this.pushQueueState(convId);
    return true;
  }

  private updateMessageContent(convId: string, msgId: string, content: string): void {
    const msgs = db.getMessagesByConversation(true, convId);
    const msg = msgs.find((m) => m.id === msgId);
    if (!msg) return;
    // Re-insert with updated content (delete + re-add)
    db.deleteMessage(true, convId, msgId);
    const { attachments: _atts, ...msgWithoutAtts } = msg;
    void _atts;
    db.insertMessage(true, { ...msgWithoutAtts, content });
  }

  /** Remove a queued item before processing */
  removeItem(convId: string, itemId: string): boolean {
    const q = db.getConvQueue(true, convId);
    const item = q.items.find((i) => i.id === itemId);
    if (!item || item.status === "processing") return false;
    // Delete the persisted user message too
    db.deleteMessage(true, convId, item.messageId);
    // Clean orphaned attachments
    for (const attId of item.attachmentIds) {
      const localPath = db.deleteAttachment(true, attId);
      if (localPath) {
        try { fs.unlinkSync(localPath); } catch { /* best effort */ }
      }
    }
    db.removeQueueItem(true, convId, itemId);
    this.pushQueueState(convId);
    return true;
  }

  /** Reorder queued items (only non-processing items can be reordered) */
  reorder(convId: string, orderedIds: string[]): void {
    db.reorderQueueItems(true, convId, orderedIds);
    this.pushQueueState(convId);
  }

  /** Clear all queued items (not processing) from a conversation */
  clearQueue(convId: string): void {
    const q = db.getConvQueue(true, convId);
    for (const item of q.items) {
      if (item.status !== "processing") {
        db.deleteMessage(true, convId, item.messageId);
        for (const attId of item.attachmentIds) {
          const localPath = db.deleteAttachment(true, attId);
          if (localPath) {
            try { fs.unlinkSync(localPath); } catch { /* best effort */ }
          }
        }
        db.removeQueueItem(true, convId, item.id);
      }
    }
    this.pushQueueState(convId);
  }

  getQueue(convId: string): { items: QueueItem[]; paused: boolean } {
    return db.getConvQueue(true, convId);
  }
}

function autoTitle(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "New conversation";
  const words = trimmed.split(/\s+/).slice(0, 6).join(" ");
  return words.length < trimmed.length ? words : trimmed;
}

// Singleton
export const queueManager = new QueueManager();