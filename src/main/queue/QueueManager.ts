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
import { IPC, EDIT_IPC } from "../../shared/types.js";
import { assertInvariant } from "../reliability/invariants.js";
import { tryGetTraceRecorder } from "../reliability/index.js";
import type { QueueItem, ChatMessage, Conversation, ContextRef, RequestContextLedger, ForgeToolCall, ForgeToolResult, ConvRuntimeState } from "../../shared/types.js";
import * as db from "../database/db.js";
import { classifyError } from "../agent-client/client.js";
import type { SimpleMessage, ImageContent } from "../agent-client/client.js";
import { runAgentLoop, AgentLoopError } from "../agent-client/agent-loop.js";
import { readSnapshot } from "../project-files/service.js";
import {
  extractProposalFence,
  stripProposalFence,
  parseProposalJson,
  captureProposalTarget,
  resolveContextRef,
  verifyBaseSnapshot,
  computeProposalStatus,
  MULTI_BLOCK_SENTINEL,
} from "../project-files/edit-service.js";
import {
  parseStructuredEditProposal,
  normalizeToFullContent,
} from "../project-files/edit-ir.js";
import fs from "fs";
import path from "path";

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

/**
 * Thrown by buildContextMessages when a snapshot file is missing (was never
 * written or has been deleted since capture). Signals that the request MUST
 * be aborted — never silently continue with partial context.
 */
export class ContextMissingError extends Error {
  constructor(
    public readonly resourceId: string,
    public readonly relativePath: string,
    message: string
  ) {
    super(message);
    this.name = "ContextMissingError";
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
          if (!content) {
            // Snapshot file is missing — abort the request rather than silently
            // sending the message without its context.
            if (process.env["NODE_ENV"] === "development" || process.env["NODE_ENV"] === "test") {
              // eslint-disable-next-line no-console
              console.error(
                `[context:missing] resource=${ref.id} project=${ref.projectId}` +
                ` path=${ref.relativePath} snapshotPath=${ref.snapshotPath}`
              );
            }
            throw new ContextMissingError(
              ref.id,
              ref.relativePath,
              `Context snapshot missing for "${ref.relativePath}": the captured file snapshot could not be found. It may have been cleaned up. Please re-add the file to context and try again.`
            );
          }

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
          // Determine full-file eligible paths for request-specific edit context.
          // The capability instruction is ALWAYS present in project context messages.
          // Full-file eligibility only affects the request-specific edit context block.
          const fullFileRefs = m.contextRefs!.filter(
            (r) => r.lineStart === undefined && r.lineEnd === undefined
          );
          const hasFullFileRef = fullFileRefs.length > 0;

          // Request-specific edit context block — communicates what is eligible
          // in THIS exact request. Separate from the always-on capability instruction.
          const editContextBlock = hasFullFileRef
            ? `\n<forge_edit_context>\nComplete editable Project file context is available in this request.\nYou may propose modifications only for the complete files actually present in this request.\nEligible full-file paths:\n${fullFileRefs.map((r) => r.relativePath).join("\n")}\n</forge_edit_context>`
            : `\n<forge_edit_context>\nNo complete editable Project file is currently available in this request.\nIf the user requests a file modification, explain that the full file must be added to Project context before you can safely propose the modification. Do not fabricate a proposal from partial or unseen content.\n</forge_edit_context>`;

          parts.push({
            type: "text",
            text: `<project_context>\n${contextParts.join("\n")}\n</project_context>${editContextBlock}`,
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

// ── Ownership validation ──────────────────────────────────────────────────

/**
 * Validate that a context ref's projectId matches the conversation's projectId.
 * Returns an error message string if validation fails, or null if valid.
 *
 * Rules:
 * - A ref with a projectId must match the conversation's projectId exactly.
 * - Global Chat conversations (projectId undefined/null) must never have project refs.
 * - Refs with empty projectId (legacy) are silently allowed through.
 */
function validateRefOwnership(
  refProjectId: string,
  convProjectId: string | undefined
): string | null {
  // Legacy refs with no projectId — skip check
  if (!refProjectId) return null;

  // Global Chat conversation has a project ref — mismatch
  if (!convProjectId) {
    return `Context integrity error: a project file context ref (project "${refProjectId}") was attached to a Global Chat conversation. Context refs can only be used in project conversations.`;
  }

  // Mismatched project IDs
  if (refProjectId !== convProjectId) {
    return `Context integrity error: a context ref from project "${refProjectId}" was attached to conversation in project "${convProjectId}". Context refs must belong to the same project as the conversation.`;
  }

  return null;
}

// ── Canonical snapshot cleanup ───────────────────────────────────────────
//
// ONE implementation. All call sites use these functions — never raw fs.unlinkSync
// on a snapshotPath without going through the reference check.

/**
 * Canonical reference-safe snapshot cleanup.
 *
 * Given a set of ContextRefs to consider for deletion and a set of message IDs
 * to exclude from the "still alive" scan (because those messages are being
 * removed transactionally), deletes only snapshot files with zero remaining
 * canonical DB references.
 *
 * This handles the branch case correctly:
 *   - Conversation A references snapshot S
 *   - Branch B also references snapshot S (same snapshotPath, same ref.id)
 *   - Delete A → excludeMsgIds = A's message IDs
 *   - B's message still references S → S is NOT deleted
 *   - Delete B → no more references → S IS deleted
 *
 * Best-effort: never throws.
 */
export function deleteOrphanedSnapshots(
  refs: import("../../shared/types.js").ContextRef[] | string,
  excludeMsgIds?: Set<string> | string
): void {
  // Overload: deleteOrphanedSnapshots(convId) — full snapshot dir sweep
  if (typeof refs === "string") {
    sweepOrphanedSnapshots();
    return;
  }
  // Normalise: accept either a single string or a Set
  const excludeSet: Set<string> =
    typeof excludeMsgIds === "string" ? new Set([excludeMsgIds]) :
    excludeMsgIds instanceof Set ? excludeMsgIds :
    new Set<string>();

  // Collect all snapshot ref IDs still alive in the DB (excluding removed messages)
  const allMessages = db.getAllMessages(true);
  const stillReferenced = new Set<string>();
  for (const msg of allMessages) {
    if (excludeSet.has(msg.id)) continue;
    if (msg.contextRefs) {
      for (const r of msg.contextRefs) {
        stillReferenced.add(r.id);
      }
    }
  }
  // V0.4: also protect snapshots referenced by agentReadRefs in persisted ledgers
  for (const id of db.getAllAgentReadRefSnapshotIds(true)) {
    stillReferenced.add(id);
  }

  for (const ref of refs) {
    if (stillReferenced.has(ref.id)) continue; // still in use
    if (!ref.snapshotPath) continue;
    // Security: only delete files inside the Forge-owned snapshots directory
    const dataDir = db.getDataDir();
    const resolved = path.resolve(ref.snapshotPath);
    const expectedDir = path.resolve(path.join(dataDir, "snapshots"));
    if (!resolved.startsWith(expectedDir + path.sep) && resolved !== expectedDir) continue;
    try {
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
        if (process.env["NODE_ENV"] === "development") {
          // eslint-disable-next-line no-console
          console.log(`[context:cleanup] deleted snapshot ${ref.id} path=${resolved}`);
        }
      }
    } catch {
      // Best effort
    }
  }
}

/**
 * Startup orphan sweep.
 *
 * Enumerates all files in the Forge-owned snapshots directory and removes any
 * that are not referenced by any canonical DB message. This catches leaks from:
 *   - failed enqueue after successful snapshot capture
 *   - bugs or crashes between capture and persistence
 *
 * ONLY operates on files inside the canonical snapshots directory.
 * Never touches project source directories.
 * If a file's ownership is uncertain (e.g. not a .txt), it is kept.
 */
export function sweepOrphanedSnapshots(): void {
  const dataDir = db.getDataDir();
  const snapshotsDir = path.resolve(path.join(dataDir, "snapshots"));
  if (!fs.existsSync(snapshotsDir)) return;

  // Build set of all canonically referenced snapshot IDs
  const allMessages = db.getAllMessages(true);
  const referencedIds = new Set<string>();
  for (const msg of allMessages) {
    if (msg.contextRefs) {
      for (const r of msg.contextRefs) {
        referencedIds.add(r.id); // r.id === UUID === filename stem
      }
    }
  }

  // Also reference snapshot paths from queue items (pending, not yet in sent messages)
  const allConversations = db.listConversations(true, true);
  for (const conv of allConversations) {
    const queue = db.getConvQueue(true, conv.id);
    for (const item of queue.items) {
      if (item.contextRefs) {
        for (const r of item.contextRefs) {
          referencedIds.add(r.id);
        }
      }
    }
  }

  // V0.4: protect snapshots referenced by agentReadRefs in persisted ledgers
  for (const id of db.getAllAgentReadRefSnapshotIds(true)) {
    referencedIds.add(id);
  }

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(snapshotsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirEntries) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.endsWith(".txt")) continue; // only Forge snapshot files
    const stem = dirent.name.replace(/\.txt$/, "");
    if (referencedIds.has(stem)) continue; // still referenced
    const fullPath = path.join(snapshotsDir, dirent.name);
    try {
      fs.unlinkSync(fullPath);
      if (process.env["NODE_ENV"] === "development") {
        // eslint-disable-next-line no-console
        console.log(`[context:sweep] removed orphan snapshot ${fullPath}`);
      }
    } catch {
      // Best effort
    }
  }
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

// ── Active run registry ────────────────────────────────────────────────────
// Stores live runtime state per conversation for renderer hydration.
// Populated at run start, updated as tool calls arrive, deleted at run end.
// The renderer queries this via RUNTIME_STATE_GET when mounting mid-run.

type LiveToolEntry = ConvRuntimeState["toolActivity"][number];

interface ActiveRunEntry {
  streamId: string;
  requestId: string;
  conversationId: string;
  agentProfileId: string;
  agentNameSnapshot: string;
  modelSnapshot: string;
  startedAt: number;
  toolActivity: LiveToolEntry[];
  exploredCount: number;
  revision: number;
}

/** conversationId → live run entry */
const activeRunRegistry = new Map<string, ActiveRunEntry>();

export function getRuntimeState(convId: string): ConvRuntimeState | null {
  const entry = activeRunRegistry.get(convId);
  if (!entry) return null;
  return {
    conversationId: entry.conversationId,
    streamId: entry.streamId,
    requestId: entry.requestId,
    agentProfileId: entry.agentProfileId,
    agentNameSnapshot: entry.agentNameSnapshot,
    modelSnapshot: entry.modelSnapshot,
    startedAt: entry.startedAt,
    toolActivity: structuredClone(entry.toolActivity),
    exploredCount: entry.exploredCount,
    revision: entry.revision,
  };
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
    const processPromise = this.processItem(item, profile, apiKey).finally(() => {
      processing.delete(convId);
    });
    _activeProcessingPromises.add(processPromise);
    void processPromise.finally(() => {
      _activeProcessingPromises.delete(processPromise);
    });
    await processPromise;

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

    // ── Pre-flight: project ownership validation ──────────────────────────
    // Verify all contextRefs belong to the conversation's project.
    // Global Chat conversations must never dispatch with project refs.
    const conv = db.getConversation(true, conversationId);
    if (item.contextRefs && item.contextRefs.length > 0) {
      for (const ref of item.contextRefs) {
        const ownershipError = validateRefOwnership(ref.projectId, conv?.projectId);
        if (ownershipError) {
          const errMsg: ChatMessage = {
            id: randomUUID(),
            conversationId,
            role: "error",
            content: ownershipError,
            createdAt: Date.now(),
            isError: true,
            agentProfileId: profile.id,
          };
          db.insertMessage(true, errMsg);
          db.updateQueueItem(true, conversationId, item.id, {
            status: "failed",
            completedAt: Date.now(),
            lastError: ownershipError,
          });
          db.setQueuePaused(true, conversationId, true);
          const ownerStreamId = randomUUID();
          this.send(IPC.CHAT_STREAM_ERROR, {
            streamId: ownerStreamId,
            message: errMsg,
            queueItemId: item.id,
          });
          this.pushQueueState(conversationId);
          return;
        }
      }
    }

    // Build fresh context — may throw ContextIntegrityError or ContextMissingError
    // if any snapshot fails its SHA-256 check or is missing. Handle BEFORE opening a stream.
    const history = db.getMessagesByConversation(true, conversationId);
    let contextMessages: ReturnType<typeof buildContextMessages>;
    try {
      contextMessages = buildContextMessages(history);
    } catch (err: unknown) {
      if (err instanceof ContextIntegrityError || err instanceof ContextMissingError) {
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

    // Register live run entry so the renderer can hydrate on remount
    const runEntry: ActiveRunEntry = {
      streamId,
      requestId: "", // filled in after requestId is created below
      conversationId,
      agentProfileId: profile.id,
      agentNameSnapshot: profile.name,
      modelSnapshot: profile.model,
      startedAt: startTime,
      toolActivity: [],
      exploredCount: 0,
      revision: 1,
    };
    activeRunRegistry.set(conversationId, runEntry);
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

    // Forge Safe File Editing capability instruction.
    // Always injected for project-scoped conversations so the model always knows
    // the proposal-based editing flow exists — regardless of whether the current
    // request has file context attached.
    // conv is resolved earlier (pre-flight ownership check) but may be null for
    // brand-new conversations not yet committed; use item projectId as fallback.
    const convForSystem = db.getConversation(true, conversationId);
    const isProjectConversation = !!(convForSystem?.projectId);
    const forgeSystemPrompt = isProjectConversation
      ? `<forge_capability>
You are running inside Uzmoon Forge.

You do NOT have direct filesystem write access. This is intentional.

You can still modify Project files by PROPOSING changes.

Forge owns:
- diff generation
- review
- explicit user approval
- filesystem write
- verification
- undo

Do NOT tell the user to manually edit a file merely because direct filesystem write tools are unavailable.

When the user asks to modify, refactor, fix, optimize, or otherwise change an EXISTING Project file:
- you may only propose a modification if the COMPLETE file content is available in the CURRENT request
- search snippets, partial line ranges, filenames, old conversation contents, or guessed content are insufficient
- use the exact Project-relative path supplied by Forge
- never claim the file has already been changed
- do not propose delete, rename, move, or file creation in this version
- do not output shell commands as if they were applied actions

When complete file content is available in the current request, respond with a brief explanation and exactly ONE structured block:

\`\`\`forge_edit_proposal
{
  "summary": "One-line description of the change",
  "files": [
    {
      "path": "<exact Project-relative path>",
      "content": "<complete desired final file content>"
    }
  ]
}
\`\`\`

Proposal rules:
- "content" must contain the COMPLETE desired final file — not a diff, not a partial snippet
- do not include hashes, checksums, absolute paths, or shell commands
- include multiple files only if the COMPLETE content of every proposed file is available in the CURRENT request
- emit at most ONE forge_edit_proposal block per response

If the requested file's complete content is NOT available in the CURRENT request, explain that full file context is required before Forge can safely prepare the change. Do not fabricate unseen content.

If the user is asking a question or requesting an explanation rather than a modification, answer normally and do not emit forge_edit_proposal.
</forge_capability>

<forge_project_tools>
You are working in an Uzmoon Forge Project with autonomous read-only access to eligible Project files.

Available tools:
- list_directory: List files/directories in the project. Default: project root.
- search_files: Search by filename or path fragment. Returns relative paths only.
- search_code: Search file contents for a literal string. Returns snippets — clues, not complete content.
- read_file: Read the complete content of a file. Creates an immutable snapshot eligible for Safe File Editing.
- read_file_range: Read a specific line range. NOTE: range reads CANNOT serve as Safe File Editing bases.

Rules:
- Start from any manually provided context if present.
- Use tools autonomously when project knowledge is needed to answer the user.
- search_code results are clues — call read_file for complete understanding before proposing changes.
- Before proposing to modify a file, obtain complete content via read_file.
- Do not repeat identical reads of unchanged files in the same request.
- Do not exhaustively read the entire project — be targeted.
- Always use exact relative paths returned by tool results.
- Never request sensitive files (e.g. .env, private keys).
- Terminal, shell, and command execution are unavailable — do not claim commands were executed.
- If a tool call fails, explain the limitation to the user rather than guessing.
</forge_project_tools>

<forge_agent_protocol>
You are executing one Uzmoon Forge Agent run for the user's Project request.

In EVERY response you MUST return exactly one of:

1. A forge_tool action when you need project information:
\`\`\`forge_tool
{"name": "tool_name", "arguments": {}}
\`\`\`

2. A forge_final response when you have enough information to answer:
\`\`\`forge_final
{"content": "Your complete answer here."}
\`\`\`

You may include a forge_edit_proposal block in the SAME response as forge_final when proposing file changes.

Rules:
- NEVER return naked explanatory prose as your only output.
- NEVER say "let me check" or "I will inspect" without using a forge_tool action.
- NEVER end a response with planning narration.
- Use forge_final only when the original user request has actually been answered completely.
- For simple conversational questions or requests that do not require project file access (greetings, explanations, questions about yourself), you MUST respond with forge_final immediately on the first turn — no tool calls are needed or appropriate.
- Continue autonomously until you can provide a complete answer, a valid proposal, or encounter a real blocker.
- Do not expose forge_tool, forge_final, forge_edit_proposal syntax in user-facing content.
</forge_agent_protocol>`
      : undefined;

    // Create RequestContextLedger for this request
    const requestId = randomUUID();
    // Backfill requestId into the registry entry now that we have it
    runEntry.requestId = requestId;

    // Trace wiring — start trace for this request
    const _tracer = tryGetTraceRecorder();
    if (_tracer) {
      _tracer.startTrace({
        requestId,
        conversationId,
        ...(convForSystem?.projectId ? { projectId: convForSystem.projectId } : {}),
      });
      _tracer.emit(requestId, "RUN_CREATED", { model: profile.model });
    }

    const ledger: RequestContextLedger = {
      requestId,
      conversationId,
      projectId: convForSystem?.projectId ?? "",
      agentProfileId: profile.id,
      manualRefIds: (item.contextRefs ?? []).map((r) => r.id),
      agentReadRefs: [],
      toolActivity: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    try {
      const loopResult = await runAgentLoop({
        cfg,
        apiKey,
        messages: contextMessages,
        system: forgeSystemPrompt,
        projectId: convForSystem?.projectId ?? "",
        projectRoot: (() => {
          const proj = convForSystem?.projectId ? db.getProject(true, convForSystem.projectId) : null;
          return proj?.workingDirectory ?? "";
        })(),
        requestId,
        conversationId,
        isProjectMode: isProjectConversation,
        signal,
        onChunk: (chunk) => {
          this.send(IPC.CHAT_STREAM_CHUNK, { streamId, chunk });
        },
        onIntermediateText: (text: string) => {
          // Transient activity label from an intermediate (non-terminal) provider turn.
          // Sent to the renderer for display-only — never persisted as a Chat message.
          this.send(IPC.CHAT_STREAM_ACTIVITY_TEXT, { streamId, text });
        },
        onToolStart: (call: ForgeToolCall) => {
          // Update live registry for renderer hydration
          const entry = activeRunRegistry.get(conversationId);
          if (entry) {
            entry.toolActivity.push({
              callId: call.callId,
              name: call.name,
              args: call.arguments as Record<string, unknown>,
              startedAt: Date.now(),
            });
            entry.revision++;
          }
          this.send(IPC.CHAT_STREAM_TOOL_START, { streamId, requestId, call });
        },
        onToolEnd: (call: ForgeToolCall, result: ForgeToolResult, durationMs: number) => {
          // Update live registry
          const entry = activeRunRegistry.get(conversationId);
          if (entry) {
            const toolEntry = entry.toolActivity.find((t) => t.callId === call.callId);
            if (toolEntry) {
              toolEntry.completedAt = Date.now();
              const resultSummary = typeof result.data === "string"
                ? result.data.slice(0, 200)
                : result.ok ? "ok" : (result.errorMessage ?? "error").slice(0, 200);
              toolEntry.result = resultSummary;
              toolEntry.durationMs = durationMs;
            }
            // Track full-file reads for exploredCount
            if (call.name === "read_file") entry.exploredCount++;
            entry.revision++;
          }
          // Relay IPC event to renderer for live tool-row updates.
          // ledger.toolActivity is populated from loopResult.toolActivity after the run;
          // building a duplicate entry here and pushing it is dead code — removed.
          this.send(IPC.CHAT_STREAM_TOOL_END, { streamId, requestId, call, result, durationMs });
        },
      });

      fullText = loopResult.finalText;
      const loopProposalFenceRaw = loopResult.proposalFenceRaw;

      // Populate ledger with agent read refs
      ledger.agentReadRefs = loopResult.agentReadRefs;
      ledger.toolActivity = loopResult.toolActivity;
      ledger.updatedAt = Date.now();

      // Persist ledger if any tool activity occurred
      if (loopResult.agentReadRefs.length > 0 || loopResult.toolActivity.length > 0) {
        try { db.saveLedger(true, ledger); } catch { /* best effort */ }
      }

      // INV: SNAPSHOT_IMMUTABLE — all agent read refs must have valid non-empty IDs
      assertInvariant(
        "SNAPSHOT_IMMUTABLE",
        ledger.agentReadRefs.every(r => typeof r.id === "string" && r.id.length > 0 && typeof r.snapshotPath === "string" && r.snapshotPath.length > 0),
        { agentReadRefCount: ledger.agentReadRefs.length, requestId, conversationId },
        { requestId, conversationId, hint: "ledger agentReadRefs integrity" }
      );

      // INV: RESOURCE_OWNERSHIP_CLEAN — agent read snapshots must be inside known dataDir
      {
        const _snapshotsDir = path.resolve(path.join(db.getDataDir(), "snapshots"));
        assertInvariant(
          "RESOURCE_OWNERSHIP_CLEAN",
          ledger.agentReadRefs.every(r => r.snapshotPath.startsWith(_snapshotsDir)),
          { invalidPaths: ledger.agentReadRefs.filter(r => !r.snapshotPath.startsWith(_snapshotsDir)).map(r => r.id), requestId },
          { requestId, conversationId, hint: "agent read ref path ownership" }
        );
      }

      activeStreams.delete(streamId);
      convToStream.delete(conversationId);
      activeRunRegistry.delete(conversationId);

      const durationMs = Date.now() - startTime;
      const now = Date.now();

      // ── Proposal detection ─────────────────────────────────────────────────
      // The agent loop extracts forge_edit_proposal from the forge_final turn.
      // loopProposalFenceRaw contains the full fence block if one was present.
      // We also run extractProposalFence as a fallback for global-chat mode where
      // there is no forge_final envelope and the model embeds the proposal in prose.
      let assistantMsg: ChatMessage;
      const conv = db.getConversation(true, conversationId);
      const convProjectId = conv?.projectId;

      // ── Structured Edit IR pre-processing ─────────────────────────────────
      // If the response contains a forge_structured_edit_proposal fence, normalize
      // all ops to full_content using base snapshots. The normalized content is
      // then fed into the existing forge_edit_proposal pipeline unchanged.
      let effectiveFenceSource = loopProposalFenceRaw ?? fullText;
      if (convProjectId) {
        const structuredResult = parseStructuredEditProposal(fullText);
        if (structuredResult !== null) {
          if (!structuredResult.ok) {
            // Malformed structured proposal — assert invariant, suppress proposal pipeline
            assertInvariant(
              "INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES",
              true, // assertion: we have NOT applied anything yet
              { error: structuredResult.error, requestId, conversationId },
              { requestId, conversationId, hint: "malformed structured edit proposal" }
            );
            effectiveFenceSource = "";
          } else {
            // Build combined refs (manual + agent reads)
            const agentRefsAsContextRefs: ContextRef[] = (ledger.agentReadRefs ?? [])
              .filter(ar => ar.fullFile)
              .map((ar): ContextRef => ({
                id: ar.id,
                projectId: ar.projectId,
                relativePath: ar.relativePath,
                snapshotPath: ar.snapshotPath,
                contentHash: ar.contentHash,
                capturedAt: ar.capturedAt,
                size: ar.size,
                language: ar.language,
              }));
            const combinedRefs: ContextRef[] = [...(item.contextRefs ?? []), ...agentRefsAsContextRefs];

            // Normalize each op: exact_text_replace → full_content via base snapshot
            const normalizedFiles: Array<{ path: string; content: string }> = [];
            let normalizationFailed = false;

            for (const op of structuredResult.proposal.operations) {
              if (op.operation === "full_content") {
                normalizedFiles.push({ path: op.path, content: op.content });
              } else if (op.operation === "exact_text_replace") {
                // Resolve base snapshot for this op's path
                const resolution = resolveContextRef(combinedRefs, convProjectId, op.path);
                if (resolution.status !== "ok") {
                  normalizationFailed = true;
                  break;
                }
                const baseContent = readSnapshot(resolution.ref.snapshotPath);
                if (baseContent === null) {
                  normalizationFailed = true;
                  break;
                }
                const normResult = normalizeToFullContent(op, baseContent);
                if (!normResult.ok) {
                  // Ambiguous replacement — assert invariant, abort all ops
                  assertInvariant(
                    "EDIT_AMBIGUITY_BLOCKED",
                    true, // nothing has been written yet
                    { error: normResult.error, path: op.path, requestId, conversationId },
                    { requestId, conversationId, hint: "structured edit ambiguity blocked" }
                  );
                  normalizationFailed = true;
                  break;
                }
                normalizedFiles.push({ path: normResult.op.path, content: normResult.op.content });
              }
            }

            if (normalizationFailed) {
              effectiveFenceSource = "";
            } else {
              // All ops normalized — build forge_edit_proposal-compatible fence
              const normalizedProposal = {
                summary: structuredResult.proposal.summary,
                ...(structuredResult.proposal.explanation !== undefined && { explanation: structuredResult.proposal.explanation }),
                files: normalizedFiles,
              };
              effectiveFenceSource = "```forge_edit_proposal\n" + JSON.stringify(normalizedProposal) + "\n```";
            }
          }
        }
      }

      const rawProposalFenceJson = effectiveFenceSource
        ? extractProposalFence(effectiveFenceSource)
        : null;

      // Multi-block: ambiguous structured response — keep prose, show error affordance
      if (rawProposalFenceJson === MULTI_BLOCK_SENTINEL) {
        const visibleContent = stripProposalFence(fullText);
        const errNote = visibleContent
          ? visibleContent + "\n\n> **Could not prepare proposed changes** — multiple proposal blocks were returned. Please try again."
          : "> **Could not prepare proposed changes** — multiple proposal blocks were returned. Please try again.";
        assistantMsg = {
          id: randomUUID(),
          conversationId,
          role: "assistant",
          content: errNote,
          createdAt: now,
          model: profile.model,
          durationMs,
          agentProfileId: profile.id,
          agentNameSnapshot: profile.name,
          modelSnapshot: profile.model,
          requestId,
        };
        db.insertMessage(true, assistantMsg);
      } else {

      const parsedProposal = rawProposalFenceJson ? parseProposalJson(rawProposalFenceJson) : null;

      // Malformed fence: fence present but JSON is invalid/incomplete
      const hasMalformedProposal = rawProposalFenceJson !== null && parsedProposal === null;

      if (parsedProposal && convProjectId) {
        // --- Proposal path ---
        const msgId = randomUUID();
        const proposalId = randomUUID();
        const displayContent = stripProposalFence(fullText);

        assistantMsg = {
          id: msgId,
          conversationId,
          role: "assistant",
          content: displayContent,
          createdAt: now,
          model: profile.model,
          durationMs,
          agentProfileId: profile.id,
          agentNameSnapshot: profile.name,
          modelSnapshot: profile.model,
          requestId,
          // Extension field — proposal back-reference
          ...(({ proposalId } as unknown) as Record<string, unknown>),
        };
        db.insertMessage(true, assistantMsg);

        // Build FileEdits
        const { FileEdit: _FEType, ..._ } = {} as { FileEdit: import("../../shared/types.js").FileEdit };
        void _FEType; void _;
        const fileEdits: import("../../shared/types.js").FileEdit[] = [];
        let proposalSaveFailed = false;
        for (const rawFile of parsedProposal.files) {
          const feId = randomUUID();
          const targetResult = captureProposalTarget(proposalId, feId, rawFile.content);
          if (!targetResult.ok) { proposalSaveFailed = true; break; }

          // V0.4: also search agentReadRefs from this request's ledger.
          // Only fullFile=true refs are valid edit bases (range reads cannot be used).
          const agentRefsAsContextRefs: ContextRef[] = (ledger.agentReadRefs ?? [])
            .filter((ar) => ar.fullFile)
            .map((ar): ContextRef => ({
              id: ar.id,
              projectId: ar.projectId,
              relativePath: ar.relativePath,
              snapshotPath: ar.snapshotPath,
              contentHash: ar.contentHash,
              capturedAt: ar.capturedAt,
              size: ar.size,
              language: ar.language,
            }));
          const combinedRefs: ContextRef[] = [...(item.contextRefs ?? []), ...agentRefsAsContextRefs];
          const resolution = resolveContextRef(combinedRefs, convProjectId, rawFile.path);
          let feStatus: import("../../shared/types.js").FileEditStatus;
          let failureReason: string | undefined;
          let baseSnapshotId: string | undefined;
          let baseContentHash: string | undefined;

          if (resolution.status === "needs_context") {
            feStatus = "needs_context";
            failureReason = `No full-file context for "${rawFile.path}". Add the file to context and retry.`;
          } else if (resolution.status === "ambiguous_context") {
            feStatus = "ambiguous_context";
            failureReason = `Multiple snapshots found for "${rawFile.path}". Remove duplicates and retry.`;
          } else {
            const verification = verifyBaseSnapshot(resolution.ref);
            if (!verification.ok) {
              feStatus = verification.status === "needs_context" ? "needs_context" : "failed";
              failureReason = verification.reason;
            } else {
              feStatus = "ready";
              baseSnapshotId = resolution.ref.id;
              baseContentHash = resolution.ref.contentHash;
            }
          }

          const fe: import("../../shared/types.js").FileEdit = {
            id: feId,
            proposalId,
            relativePath: rawFile.path,
            targetResourcePath: targetResult.resourcePath,
            targetContentHash: targetResult.contentHash,
            status: feStatus,
            ...(failureReason !== undefined && { failureReason }),
            ...(baseSnapshotId !== undefined && { baseSnapshotId }),
            ...(baseContentHash !== undefined && { baseContentHash }),
            createdAt: now,
            updatedAt: now,
          };
          fileEdits.push(fe);
        }

        if (!proposalSaveFailed && fileEdits.length > 0) {
          const overallStatus = computeProposalStatus(fileEdits);
          const proposal: import("../../shared/types.js").EditProposal = {
            id: proposalId,
            conversationId,
            messageId: msgId,
            projectId: convProjectId,
            status: overallStatus,
            summary: parsedProposal.summary,
            ...(parsedProposal.explanation !== undefined && { explanation: parsedProposal.explanation }),
            rawProposalJson: rawProposalFenceJson!,
            fileEdits,
            createdAt: now,
            updatedAt: now,
          };
          try {
            db.saveProposal(true, proposal);
            // Push proposal to renderer
            this.send(EDIT_IPC.PROPOSAL_UPDATE, proposal);
          } catch {
            // Proposal save failed — delete the assistant message we already inserted
            db.deleteMessage(true, conversationId, msgId);
            // Fall back to plain message
            const fallbackMsg: ChatMessage = {
              id: randomUUID(),
              conversationId,
              role: "assistant",
              content: fullText,
              createdAt: now,
              model: profile.model,
              durationMs,
              agentProfileId: profile.id,
              agentNameSnapshot: profile.name,
              modelSnapshot: profile.model,
              requestId,
            };
            db.insertMessage(true, fallbackMsg);
            assistantMsg = fallbackMsg;
          }
        } else {
          // Couldn't build file edits — fall back to plain message, delete partial msg
          db.deleteMessage(true, conversationId, msgId);
          const fallbackMsg: ChatMessage = {
            id: randomUUID(),
            conversationId,
            role: "assistant",
            content: fullText,
            createdAt: now,
            model: profile.model,
            durationMs,
            agentProfileId: profile.id,
            agentNameSnapshot: profile.name,
            modelSnapshot: profile.model,
            requestId,
          };
          db.insertMessage(true, fallbackMsg);
          assistantMsg = fallbackMsg;
        }
      } else {
        // --- Plain assistant message (or malformed proposal) ---
        let plainContent = fullText;
        if (hasMalformedProposal) {
          // Fence was present but JSON was invalid — strip the raw fence
          // and append a restrained error note. Do NOT tell the user to edit manually.
          const stripped = stripProposalFence(fullText);
          const errorNote = "> **Could not prepare proposed changes.** The response was incomplete or malformed. Please try again.";
          plainContent = stripped ? stripped + "\n\n" + errorNote : errorNote;
        }
        assistantMsg = {
          id: randomUUID(),
          conversationId,
          role: "assistant",
          content: plainContent,
          createdAt: now,
          model: profile.model,
          durationMs,
          agentProfileId: profile.id,
          agentNameSnapshot: profile.name,
          modelSnapshot: profile.model,
          requestId,
        };
        db.insertMessage(true, assistantMsg);
      }

      } // close outer multi-block else

      // INV: NO_PROTOCOL_LEAK — persisted message must not contain raw forge protocol fences
      assertInvariant(
        "NO_PROTOCOL_LEAK",
        !assistantMsg.content.includes("forge_tool") &&
        !assistantMsg.content.includes("forge_final") &&
        !assistantMsg.content.includes("forge_agent_protocol"),
        { contentSnippet: assistantMsg.content.slice(0, 120), requestId, conversationId },
        { requestId, conversationId, hint: "persisted assistant message protocol leak check" }
      );

      // INV: 1_USER_1_ASSISTANT — request-scoped: exactly one user message and one final
      // assistant message per request. Bulk-queued user messages from other requests may
      // coexist in the conversation — positional adjacency is NOT required.
      {
        const allMsgs = db.getMessagesByConversation(true, conversationId);
        // 1. User message for this request must exist exactly once
        const userMsgsForRequest = allMsgs.filter((m) => m.id === item.messageId && m.role === "user");
        assertInvariant(
          "1_USER_1_ASSISTANT",
          userMsgsForRequest.length === 1,
          { check: "user_message_exists", count: userMsgsForRequest.length, messageId: item.messageId, requestId, conversationId },
          { requestId, conversationId, hint: "request user message exists exactly once" }
        );
        // 2. No duplicate assistant message for this requestId
        const assistantMsgsForRequest = allMsgs.filter((m) => m.requestId === requestId && m.role === "assistant");
        assertInvariant(
          "1_USER_1_ASSISTANT",
          assistantMsgsForRequest.length === 1,
          { check: "no_duplicate_final", count: assistantMsgsForRequest.length, requestId, conversationId },
          { requestId, conversationId, hint: "no duplicate final assistant message for request" }
        );
      }

      db.updateConversation(true, conversationId, { updatedAt: now });
      db.touchAgentProfileLastUsed(true, profile.id);
      db.updateAgentProfileStatus(true, profile.id, "connected");

      // Trace wiring — record final text and close the trace
      if (_tracer) {
        _tracer.emit(requestId, "FINAL_NORMALIZED", { kind: "final", finalText: fullText.slice(0, 500) });
        _tracer.endTrace(requestId, "completed");
      }

      db.updateQueueItem(true, conversationId, item.id, {
        status: "completed",
        completedAt: now,
      });
      db.pruneQueueHistory(true, conversationId);

      // V0.4: attach agentReadRefs as extension field on the sent message
      // so the renderer can display the "Explored N files" section.
      const msgWithRefs = ledger.agentReadRefs.length > 0
        ? ({
            ...assistantMsg,
            agentReadRefs: ledger.agentReadRefs,
          } as unknown as ChatMessage)
        : assistantMsg;

      this.send(IPC.CHAT_STREAM_END, {
        streamId,
        message: msgWithRefs,
        conversation: db.getConversation(true, conversationId),
        queueItemId: item.id,
      });

      this.pushQueueState(conversationId);
    } catch (err: unknown) {
      activeStreams.delete(streamId);
      convToStream.delete(conversationId);
      activeRunRegistry.delete(conversationId);

      // ── CANCELLED ──────────────────────────────────────────────────────────
      // AgentLoopError("CANCELLED") or legacy Error("cancelled") — clean stop.
      // Do NOT persist any intermediate narration as a Chat message.
      // If fullText has actual content (from a partial final), persist it; otherwise
      // send a cancelled signal with no message.
      const isCancelled =
        (err instanceof AgentLoopError && err.code === "CANCELLED") ||
        (err instanceof Error && err.message === "cancelled");

      if (isCancelled) {
        // Per spec §39: do not fabricate a final answer; do not persist narration.
        // Only persist if we actually had a confirmed final answer started.
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

        // Trace wiring — close cancelled trace
        if (_tracer) _tracer.endTrace(requestId, "cancelled");

        db.updateQueueItem(true, conversationId, item.id, {
          status: "cancelled",
          completedAt: Date.now(),
        });
        db.setQueuePaused(true, conversationId, true);
        this.pushQueueState(conversationId);
        return;
      }

      // ── AgentLoopError — typed runtime failures ────────────────────────────
      // Map each failure code to a coherent user-visible error message.
      // No intermediate narration is persisted — only one error ChatMessage.
      // INV: ONE_RUN_ONE_VISIBLE_FAILURE — exactly one error message per failed run.
      if (err instanceof AgentLoopError) {
        let errorContent: string;
        switch (err.code) {
          case "PROTOCOL_RECOVERY_EXHAUSTED":
            errorContent = "Could not complete this Agent run. The model did not provide a valid response after several attempts. Please try again.";
            break;
          case "BUDGET_FINALIZATION_FAILED":
            errorContent = "Could not complete this Agent run. The tool step budget was exhausted before a final answer could be produced. Please try again.";
            break;
          case "PROVIDER_ERROR":
            errorContent = "Connection error. Please check your Agent configuration and try again.";
            break;
          case "INVALID_STATE_TRANSITION":
            errorContent = "An internal runtime error occurred. Please try again.";
            break;
          default:
            errorContent = "Could not complete this Agent run. Please try again.";
        }

        // Assert: only one error message being created for this failed run.
        const existingErrors = db.getMessagesByConversation(true, conversationId)
          .filter(m => m.isError === true && m.agentProfileId === profile.id);
        assertInvariant(
          "ONE_RUN_ONE_VISIBLE_FAILURE",
          existingErrors.length === 0 || existingErrors.every(m => m.content !== errorContent),
          { existingErrorCount: existingErrors.length, requestId: requestId, conversationId },
          { requestId, conversationId, hint: "AgentLoopError path" },
        );

        const agentLoopErrorMsg: ChatMessage = {
          id: randomUUID(),
          conversationId,
          role: "error",
          content: errorContent,
          createdAt: Date.now(),
          isError: true,
          agentProfileId: profile.id,
        };
        db.insertMessage(true, agentLoopErrorMsg);
        // Trace wiring — close failed trace with code
        if (_tracer) _tracer.endTrace(requestId, "failed", err instanceof AgentLoopError ? err.code : undefined);
        this.send(IPC.CHAT_STREAM_ERROR, { streamId, message: agentLoopErrorMsg, queueItemId: item.id });
        db.updateQueueItem(true, conversationId, item.id, {
          status: "failed",
          completedAt: Date.now(),
          lastError: errorContent,
        });
        db.setQueuePaused(true, conversationId, true);
        this.pushQueueState(conversationId);
        return;
      }

      // ── Generic / unexpected errors ────────────────────────────────────────
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

      // INV: PROVIDER_DISCONNECT_HANDLED — error message must have non-empty content
      assertInvariant(
        "PROVIDER_DISCONNECT_HANDLED",
        typeof errorMsg.content === "string" && errorMsg.content.trim().length > 0,
        { errorContent: errorMsg.content.slice(0, 80), requestId, conversationId },
        { requestId, conversationId, hint: "generic error path — non-empty error message" }
      );

      // Trace wiring — close failed trace (generic error)
      if (_tracer) _tracer.endTrace(requestId, "failed", "PROVIDER_ERROR");
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

  /** Pause a queue — prevents next item from starting; in-flight item continues */
  pause(convId: string): void {
    db.setQueuePaused(true, convId, true);
    this.pushQueueState(convId);
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
    // When content changes, the existing contextRefs are stale — clear them and
    // clean up their snapshot files (content changed, refs are now meaningless).
    const patch: Partial<QueueItem> = { content, contextRefs: [] };
    if (attachmentIds !== undefined) patch.attachmentIds = attachmentIds;
    // targetAgentProfileId is preserved — never changed by edit
    // Clean up orphaned snapshots from the old contextRefs before overwriting
    if (item.contextRefs && item.contextRefs.length > 0) {
      deleteOrphanedSnapshots(item.contextRefs, item.messageId);
    }
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
    // Clean up orphaned snapshots before removing the message
    if (item.contextRefs && item.contextRefs.length > 0) {
      deleteOrphanedSnapshots(item.contextRefs, item.messageId);
    }
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
        // Clean up orphaned snapshots before removing each item
        if (item.contextRefs && item.contextRefs.length > 0) {
          deleteOrphanedSnapshots(item.contextRefs, item.messageId);
        }
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

  getConvRuntimeState(convId: string): ConvRuntimeState | null {
    return getRuntimeState(convId);
  }
}

function autoTitle(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "New conversation";
  const words = trimmed.split(/\s+/).slice(0, 6).join(" ");
  return words.length < trimmed.length ? words : trimmed;
}

export const queueManager = new QueueManager();

/** FOR TESTS ONLY — resets all module-level state for isolation between test cases */
/** Set of active processNext promises — used for deterministic test teardown */
const _activeProcessingPromises = new Set<Promise<void>>();

/**
 * Wait for all in-flight processNext calls to settle (resolve or reject).
 * Call this before _resetQueueManagerForTest() to avoid async bleed between tests.
 */
export async function drainForTest(): Promise<void> {
  // Abort all active streams so running processItem calls exit at the next abort-check
  for (const sig of activeStreams.values()) sig.aborted = true;
  // Wait for all in-flight promises to settle
  const snapshot = Array.from(_activeProcessingPromises);
  if (snapshot.length > 0) {
    await Promise.allSettled(snapshot);
  }
}

export function _resetQueueManagerForTest(): void {
  // Abort all in-flight signals (idempotent — drainForTest may have already done this)
  for (const sig of activeStreams.values()) sig.aborted = true;
  activeStreams.clear();
  convToStream.clear();
  activeRunRegistry.clear();
  processing.clear();
  _activeProcessingPromises.clear();
}