/**
 * QueueManager — per-conversation message queue sequencer.
 *
 * Rules:
 * - One active generation per conversation at most.
 * - Context is rebuilt fresh from DB when each item begins processing.
 * - targetAgentProfileId is captured AT ENQUEUE TIME and never changed.
 * - Profile + secret are resolved from DB AT PROCESS TIME (not from enqueue args).
 * - On stop/failure, queue is paused — user must explicitly resume.
 * - On restart, any "processing" items were already recovered to "paused" by db.load().
 */
import { randomUUID, createHash } from "crypto";
import { WebContents } from "electron";
import { IPC } from "../../shared/types.js";
import type { QueueItem, ChatMessage, Conversation, ContextRef } from "../../shared/types.js";
import * as db from "../database/db.js";
import { makeRequest, classifyError } from "../agent-client/client.js";
import type { SimpleMessage, ImageContent } from "../agent-client/client.js";
import { readSnapshot } from "../project-files/service.js";
import fs from "fs";

/**
 * Thrown by buildContextMessages when a snapshot fails its SHA-256 integrity
 * check. Signals that the request MUST be aborted — never silently continue
 * with missing context.
 */
export class ContextIntegrityError extends Error {
  constructor(
    public readonly resourceId: string,
    public readonly relativePath: string,
    message: string
  ) {
    super(message);
    this.name = "ContextIntegrityError";
  }
}

// ── Context builder ────────────────────────────────────────────────────────

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function buildContextMessages(msgs: ChatMessage[]): SimpleMessage[] {
  const msgById = new Map<string, ChatMessage>();
  for (const m of msgs) msgById.set(m.id, m);

  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): SimpleMessage => {
      // Inject project context snapshots for user messages that have contextRefs
      if (m.role === "user" && m.contextRefs && m.contextRefs.length > 0) {
        const parts: Array<{ type: "text"; text: string } | ImageContent> = [];
        // Build context block
        const contextParts: string[] = [];
        for (const ref of m.contextRefs) {
          const content = readSnapshot(ref.snapshotPath);
          if (!content) continue;

          // Integrity: verify snapshot content matches stored hash.
          // On mismatch, throw immediately — the request must be aborted, not
          // silently sent without its context.
          if (ref.contentHash) {
            const actualHash = createHash("sha256")
              .update(Buffer.from(content, "utf8"))
              .digest("hex");
            if (actualHash !== ref.contentHash) {
              if (process.env["NODE_ENV"] === "development" || process.env["NODE_ENV"] === "test") {
                // eslint-disable-next-line no-console
                console.error(
                  `[context:integrity-FAIL] resource=${ref.id} project=${ref.projectId}` +
                  ` path=${ref.relativePath} stored=${ref.contentHash.slice(0, 8)} actual=${actualHash.slice(0, 8)}`
                );
              }
              throw new ContextIntegrityError(
                ref.id,
                ref.relativePath,
                `Context integrity check failed for "${ref.relativePath}": snapshot has been modified or corrupted since it was captured. Remove the context and try again.`
              );
            }
          }

          // Dev mode: log successful context serialization
          if (process.env["NODE_ENV"] === "development") {
            // eslint-disable-next-line no-console
            console.log(
              `[context:serialize] resource=${ref.id} project=${ref.projectId}` +
              ` path=${ref.relativePath} sha256=${(ref.contentHash ?? "").slice(0, 8)} bytes=${ref.size}`
            );
          }

          const lineRange = ref.lineStart !== undefined
            ? ` lines="${ref.lineStart}-${ref.lineEnd ?? "end"}"`
            : "";
          contextParts.push(
            `<project_file path="${ref.relativePath}" language="${ref.language}"${lineRange}>\n${content}\n</project_file>`
          );
        }
        if (contextParts.length > 0) {
          parts.push({
            type: "text",
            text: `<project_context>\n${contextParts.join("\n")}\n</project_context>`,
          });
        }
        // Now handle the rest of the message normally (attachments, reply, content)
        let effectiveContent = m.content;
        if (m.replyToMessageId) {
          const parent = msgById.get(m.replyToMessageId);
          if (parent) {
            const roleLabel = parent.role === "user" ? "User" : "Assistant";
            const snippet = parent.content.slice(0, 400) + (parent.content.length > 400 ? "..." : "");
            effectiveContent = `[Replying to ${roleLabel}: "${snippet}"\n]\n${m.content}`;
          }
        }
        if (m.attachments && m.attachments.length > 0) {
          if (effectiveContent.trim()) parts.push({ type: "text", text: effectiveContent });
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
                  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + `\n... [truncated, ${raw.length} bytes total]`;
                } catch { text = `[binary file: ${att.filename}, ${raw.length} bytes]`; }
                parts.push({ type: "text", text: `<file name="${att.filename}" type="${att.mimeType}">\n${text}\n</file>` });
              }
            } catch { /* file missing */ }
          }
        } else {
          if (effectiveContent.trim()) parts.push({ type: "text", text: effectiveContent });
        }
        if (parts.length === 0) return { role: "user", content: m.content };
        if (parts.length === 1 && parts[0]!.type === "text") {
          return { role: "user", content: (parts[0] as { type: "text"; text: string }).text };
        }
        return { role: "user", content: parts };
      }
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

// ── Secret resolver (injected by handlers.ts) ──────────────────────────────

/** Injectable secret getter — set by registerHandlers so QueueManager
 *  doesn't need to import SecretStore directly. */
type SecretGetter = (profileId: string) => string | null;
let _secretGetter: SecretGetter = () => null;
export function setSecretGetter(fn: SecretGetter): void {
  _secretGetter = fn;
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

// ── Dispatch lock ──────────────────────────────────────────────────────────

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

  private pushQueueState(convId: string): void {
    const state = db.getConvQueue(true, convId);
    this.send(IPC.QUEUE_STATE, { conversationId: convId, ...state });
  }

  /**
   * Enqueue a new message request.
   * targetAgentProfileId is captured HERE and never changes.
   */
  async enqueue(opts: {
    conversationId: string;
    content: string;
    attachmentIds: string[];
    replyToMessageId?: string;
    targetAgentProfileId: string;
    /** If set, the new conversation will be scoped to this project */
    projectId?: string;
    /** Captured context refs (snapshots) — immutable after enqueue */
    contextRefs?: ContextRef[];
  }): Promise<{
    queueItem: QueueItem;
    userMessage: ChatMessage;
    conversation: Conversation;
  }> {
    const { conversationId, content, attachmentIds, replyToMessageId, targetAgentProfileId, projectId, contextRefs } = opts;

    // Ensure conversation exists
    let conv = db.getConversation(true, conversationId);
    if (!conv) {
      const now = Date.now();
      const title = content.trim() ? autoTitle(content) : "New conversation";
      conv = {
        id: conversationId,
        title,
        createdAt: now,
        updatedAt: now,
        defaultAgentProfileId: targetAgentProfileId,
        // Scope to project if provided; undefined means Global Chat
        ...(projectId !== undefined && { projectId }),
      };
      db.createConversation(true, conv);
    } else if (!conv.defaultAgentProfileId) {
      // Set conversation default if not yet set
      db.updateConversation(true, conversationId, { defaultAgentProfileId: targetAgentProfileId });
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
      ...(contextRefs && contextRefs.length > 0 && { contextRefs }),
    };
    for (const att of attachments) {
      att.messageId = userMsg.id;
      db.saveAttachmentMeta(true, att);
    }
    db.insertMessage(true, userMsg);
    db.updateConversation(true, conversationId, { updatedAt: Date.now() });

    // Create queue item — targetAgentProfileId locked here
    const queueItem: QueueItem = {
      id: randomUUID(),
      conversationId,
      messageId: userMsg.id,
      content,
      attachmentIds,
      status: "queued",
      createdAt: Date.now(),
      attemptCount: 0,
      targetAgentProfileId,
      ...(replyToMessageId && { replyToMessageId }),
      ...(contextRefs && contextRefs.length > 0 && { contextRefs }),
    };
    db.enqueueItem(true, queueItem);

    const updatedConv = db.getConversation(true, conversationId)!;
    this.pushQueueState(conversationId);

    // Try to process immediately (resolves profile from DB)
    void this.processNext(conversationId);

    return { queueItem, userMessage: userMsg, conversation: updatedConv };
  }

  /** Process the next queued item for a conversation if free */
  async processNext(convId: string): Promise<void> {
    if (processing.has(convId)) return;
    if (db.hasProcessingItem(true, convId)) return;

    const item = db.nextQueuedItem(true, convId);
    if (!item) return;

    // Resolve agent profile from DB at process time
    const profile = db.getAgentProfile(true, item.targetAgentProfileId);
    if (!profile) {
      // Profile removed — mark item as failed
      db.updateQueueItem(true, convId, item.id, {
        status: "failed",
        completedAt: Date.now(),
        lastError: "Target agent profile is no longer available.",
      });
      db.setQueuePaused(true, convId, true);
      this.pushQueueState(convId);
      return;
    }

    const apiKey = _secretGetter(item.targetAgentProfileId);
    if (!apiKey) {
      db.updateQueueItem(true, convId, item.id, {
        status: "failed",
        completedAt: Date.now(),
        lastError: "No API key for target agent profile.",
      });
      db.setQueuePaused(true, convId, true);
      this.pushQueueState(convId);
      return;
    }

    processing.add(convId);
    try {
      await this.processItem(item, profile, apiKey);
    } finally {
      processing.delete(convId);
    }

    // After completion, try next (profile resolved fresh for next item)
    const next = db.nextQueuedItem(true, convId);
    if (next) {
      void this.processNext(convId);
    }
  }

  private async processItem(
    item: QueueItem,
    profile: import("../../shared/types.js").AgentProfile,
    apiKey: string
  ): Promise<void> {
    const { conversationId } = item;

    db.updateQueueItem(true, conversationId, item.id, {
      status: "processing",
      startedAt: Date.now(),
      attemptCount: item.attemptCount + 1,
    });
    this.pushQueueState(conversationId);

    // Build fresh context — may throw ContextIntegrityError if any snapshot
    // fails its SHA-256 check. Handle that BEFORE opening a stream.
    const history = db.getMessagesByConversation(true, conversationId);
    let contextMessages: ReturnType<typeof buildContextMessages>;
    try {
      contextMessages = buildContextMessages(history);
    } catch (err: unknown) {
      if (err instanceof ContextIntegrityError) {
        const errorContent = err.message;
        const errorMsg: ChatMessage = {
          id: randomUUID(),
          conversationId,
          role: "error",
          content: errorContent,
          createdAt: Date.now(),
          isError: true,
          agentProfileId: profile.id,
        };
        db.insertMessage(true, errorMsg);
        db.updateQueueItem(true, conversationId, item.id, {
          status: "failed",
          completedAt: Date.now(),
          lastError: errorContent,
        });
        db.setQueuePaused(true, conversationId, true);
        const integrityStreamId = randomUUID();
        this.send(IPC.CHAT_STREAM_ERROR, {
          streamId: integrityStreamId,
          message: errorMsg,
          queueItemId: item.id,
        });
        this.pushQueueState(conversationId);
        return;
      }
      throw err;
    }

    const streamId = randomUUID();
    const signal = { aborted: false, convId: conversationId };
    activeStreams.set(streamId, signal);
    convToStream.set(conversationId, streamId);

    const startTime = Date.now();
    let fullText = "";

    // Immutable request config — profile snapshot in memory only
    const cfg = {
      id: profile.id,
      name: profile.name,
      endpoint: profile.endpoint,
      protocol: profile.protocol,
      model: profile.model,
      ...(profile.apiKeyHeader !== undefined && { apiKeyHeader: profile.apiKeyHeader }),
      ...(profile.timeoutMs !== undefined && { timeoutMs: profile.timeoutMs }),
    };

    this.send(IPC.CHAT_STREAM_START, {
      streamId,
      userMessage: db.getMessagesByConversation(true, conversationId)
        .find((m) => m.id === item.messageId),
      conversation: db.getConversation(true, conversationId),
      queueItemId: item.id,
      agentProfileId: profile.id,
      agentNameSnapshot: profile.name,
      modelSnapshot: profile.model,
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
        model: profile.model,
        durationMs,
        agentProfileId: profile.id,
        agentNameSnapshot: profile.name,
        modelSnapshot: profile.model,
      };
      db.insertMessage(true, assistantMsg);
      db.updateConversation(true, conversationId, { updatedAt: Date.now() });
      db.touchAgentProfileLastUsed(true, profile.id);
      db.updateAgentProfileStatus(true, profile.id, "connected");

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
        if (fullText.trim()) {
          const partialMsg: ChatMessage = {
            id: randomUUID(),
            conversationId,
            role: "assistant",
            content: fullText,
            createdAt: Date.now(),
            model: profile.model,
            durationMs: Date.now() - startTime,
            agentProfileId: profile.id,
            agentNameSnapshot: profile.name,
            modelSnapshot: profile.model,
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

        db.updateQueueItem(true, conversationId, item.id, {
          status: "cancelled",
          completedAt: Date.now(),
        });
        db.setQueuePaused(true, conversationId, true);
        this.pushQueueState(conversationId);
        return;
      }

      // Real error
      const result = classifyError(err);
      let errorContent = result.message;
      if (err instanceof Error && err.message === "image_unsupported") {
        errorContent = "This model or endpoint does not support image input.";
      }

      // Update profile status
      db.updateAgentProfileStatus(true, profile.id, result.status);

      const errorMsg: ChatMessage = {
        id: randomUUID(),
        conversationId,
        role: "error",
        content: errorContent,
        createdAt: Date.now(),
        isError: true,
        agentProfileId: profile.id,
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

  /** Resume a paused queue — profile resolved fresh for each item */
  async resume(convId: string): Promise<void> {
    db.setQueuePaused(true, convId, false);
    this.pushQueueState(convId);
    void this.processNext(convId);
  }

  /** Retry failed item */
  async retry(convId: string, itemId: string): Promise<void> {
    const q = db.getConvQueue(true, convId);
    const item = q.items.find((i) => i.id === itemId);
    if (!item) return;
    const { lastError: _le, startedAt: _sa, completedAt: _ca, ...rest } = item;
    void _le; void _sa; void _ca;
    db.updateQueueItem(true, convId, itemId, { ...rest, status: "queued" });
    db.setQueuePaused(true, convId, false);
    this.pushQueueState(convId);
    void this.processNext(convId);
  }

  /** Skip failed item */
  async skip(convId: string, itemId: string): Promise<void> {
    db.updateQueueItem(true, convId, itemId, {
      status: "cancelled",
      completedAt: Date.now(),
    });
    db.setQueuePaused(true, convId, false);
    this.pushQueueState(convId);
    void this.processNext(convId);
  }

  editItem(convId: string, itemId: string, content: string, attachmentIds?: string[]): boolean {
    const q = db.getConvQueue(true, convId);
    const item = q.items.find((i) => i.id === itemId);
    if (!item || item.status === "processing") return false;
    const patch: Partial<QueueItem> = { content };
    if (attachmentIds !== undefined) patch.attachmentIds = attachmentIds;
    // targetAgentProfileId is preserved — never changed by edit
    db.updateQueueItem(true, convId, itemId, patch);
    this.updateMessageContent(convId, item.messageId, content);
    this.pushQueueState(convId);
    return true;
  }

  private updateMessageContent(convId: string, msgId: string, content: string): void {
    const msgs = db.getMessagesByConversation(true, convId);
    const msg = msgs.find((m) => m.id === msgId);
    if (!msg) return;
    db.deleteMessage(true, convId, msgId);
    const { attachments: _atts, ...msgWithoutAtts } = msg;
    void _atts;
    db.insertMessage(true, { ...msgWithoutAtts, content });
  }

  removeItem(convId: string, itemId: string): boolean {
    const q = db.getConvQueue(true, convId);
    const item = q.items.find((i) => i.id === itemId);
    if (!item || item.status === "processing") return false;
    db.deleteMessage(true, convId, item.messageId);
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

  reorder(convId: string, orderedIds: string[]): void {
    db.reorderQueueItems(true, convId, orderedIds);
    this.pushQueueState(convId);
  }

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

export const queueManager = new QueueManager();