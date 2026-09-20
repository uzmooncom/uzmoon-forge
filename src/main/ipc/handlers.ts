import { ipcMain, IpcMainInvokeEvent, WebContents, clipboard, dialog, shell, app } from "electron";
import { randomUUID, createHash } from "crypto";
import path from "path";
import fs from "fs";
import { IPC, PROJECT_FILE_IPC, EDIT_IPC, AGENT_TOOL_IPC, RELIABILITY_IPC, SETTINGS_IPC, COMMAND_IPC, BROWSER_IPC, DEV_PROCESS_IPC, TELEMETRY_IPC, DEV_PANEL_IPC, PERMISSION_IPC, TASK_IPC } from "../../shared/types.js";
import type {
  AgentConfig,
  AgentProfile,
  AppState,
  Conversation,
  Attachment,
  AttachmentInput,
  SendMessageRequest,
  SendMessageWithContextRequest,
  ConnectionStatus,
  Project,
  DirectoryStatus,
} from "../../shared/types.js";
import * as editService from "../project-files/edit-service.js";
import * as projectFiles from "../project-files/service.js";
import type { SecretStore } from "../secret-store/secrets.js";
import * as db from "../database/db.js";
import { testConnection } from "../agent-client/client.js";
import { queueManager, cancelStream, returnControl, getActiveStreamId, setSecretGetter, deleteOrphanedSnapshots, sweepOrphanedSnapshots, getActiveRunEntries, getQueueSummary, setCancelApprovalsCallback, runTaskStep } from "../queue/QueueManager.js";
import { tryGetIncidentRecorder, assertInvariant } from "../reliability/index.js";
import { forgeLogger } from "../telemetry/logger.js";
import { buildDevSnapshot, getRunTimeline, buildDiagnosticBundle, initDevState } from "../telemetry/dev-state.js";
import * as commandManager from "../commands/command-manager.js";
import * as browserManager from "../browser/browser-manager.js";
import * as browserWindowController from "../browser/browser-window-controller.js";
import { isFakeProviderEnabled, releaseCheckpoint, waitForCheckpointBlocked } from "../agent-client/fake-provider.js";
import * as permissionEngine from "../permissions/index.js";
import * as taskManager from "../tasks/task-manager.js";
import { registerTaskInvariants } from "../tasks/task-invariants.js";
import * as devProcessManager from "../commands/dev-process-manager.js";
import { buildGitHubIssuePayload } from "../reliability/sanitizer.js";
void sweepOrphanedSnapshots; // imported for startup use — called from main.ts

interface Services {
  secrets: SecretStore;
  database: true;
}

// ── Per-project file watchers ─────────────────────────────────────────────────
// One watcher per project root. Debounced 1.5 s to coalesce rapid save events.
// On any change: evict in-memory index and trigger async rebuild so the next
// search_code or search_files call sees up-to-date paths.

const projectWatchers = new Map<string, fs.FSWatcher>();
const watcherDebounces = new Map<string, ReturnType<typeof setTimeout>>();

/** Start (or restart) a watcher for the given project. Idempotent. */
function ensureProjectWatcher(
  projectId: string,
  projectRoot: string
): void {
  if (projectWatchers.has(projectId)) return; // already watching

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(
      projectRoot,
      { recursive: true, persistent: false },
      () => {
        // Debounce: wait 1.5s of quiet before rebuilding
        const existing = watcherDebounces.get(projectId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          watcherDebounces.delete(projectId);
          projectFiles.evictIndex(projectId);
          projectFiles.buildIndex(projectId, projectRoot);
        }, 1500);
        watcherDebounces.set(projectId, timer);
      }
    );
  } catch {
    // fs.watch not supported on this platform/path — non-fatal
    return;
  }

  watcher.on("error", () => {
    // Watcher errored (e.g. project dir deleted) — clean up
    stopProjectWatcher(projectId);
  });

  projectWatchers.set(projectId, watcher);
}

/** Stop and clean up a project watcher. */
function stopProjectWatcher(projectId: string): void {
  const timer = watcherDebounces.get(projectId);
  if (timer) { clearTimeout(timer); watcherDebounces.delete(projectId); }
  const watcher = projectWatchers.get(projectId);
  if (watcher) { try { watcher.close(); } catch { /* best-effort */ } projectWatchers.delete(projectId); }
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


/**
 * Canonical immutable resource resolver.
 *
 * Given a `resourceId` (FileEdit.baseSnapshotId) and the proposal's projectId,
 * searches ALL possible owners in priority order:
 *   1. Manual ContextRefs — stored on ChatMessages in any conversation
 *   2. AgentReadRefs — stored in RequestContextLedgers (autonomous reads)
 *
 * Returns { snapshotPath, contentHash } or null.
 *
 * This is the ONLY place where "where is the base snapshot?" is answered.
 * Both proposal creation (QueueManager) and proposal review (PROPOSAL_READ_TARGET)
 * ultimately rely on this resolver so they cannot diverge.
 */
function resolveImmutableFileResource(
  resourceId: string,
  projectId: string,
  database: true
): { snapshotPath: string; contentHash: string } | null {
  if (!resourceId) return null;

  // 1. Search manual ContextRefs across all messages in any conversation
  const allConversations = db.listConversations(database);
  for (const conv of allConversations) {
    const msgs = db.getMessagesByConversation(database, conv.id);
    for (const msg of msgs) {
      for (const ref of (msg.contextRefs ?? [])) {
        if (ref.id === resourceId && ref.projectId === projectId) {
          return { snapshotPath: ref.snapshotPath, contentHash: ref.contentHash };
        }
      }
    }
  }

  // 2. Search AgentReadRefs across all RequestContextLedgers
  //    This is the path taken for autonomously-read files — agentReadRefs live in
  //    ledgers, NOT in message.contextRefs.
  const allLedgers = db.getAllLedgers(database);
  for (const ledger of allLedgers) {
    for (const ref of ledger.agentReadRefs) {
      if (ref.id === resourceId && ref.projectId === projectId) {
        return { snapshotPath: ref.snapshotPath, contentHash: ref.contentHash };
      }
    }
  }

  return null;
}

export function registerHandlers(services: Services, mainSender: WebContents): void {
  const { secrets, database } = services;

  // Wire queue manager sender so it can push events to renderer
  queueManager.setSender(mainSender);

  // Inject secret getter into QueueManager so it can resolve apiKey by profileId
  setSecretGetter((profileId: string) => secrets.get(profileId));

  // Inject openBrowserWindow into browserManager so bootstrapAgentControl can open
  // the browser window before creating tabs — avoids tabs with no WebContentsView
  browserManager.setEnsureWindowOpenFn(() => browserWindowController.openBrowserWindow());

  // Inject IPC sender into permission engine so it can push APPROVAL_REQUEST events
  // to the renderer when a capability check returns ASK.
  permissionEngine.setPermissionIpcSender((channel: string, payload: unknown) => {
    mainSender.send(channel, payload);
  });

  // Inject approval cancellation callback into QueueManager.
  // When a run is stopped, QueueManager calls this to deny any pending browser approvals.
  // This is a DI hook to avoid QueueManager → browser-manager circular import.
  setCancelApprovalsCallback((requestId: string) => {
    browserManager.cancelApprovalsForRequest(requestId);
    // Also cancel any pending permission approvals for this request
    permissionEngine.cancelPendingApprovals({ requestId });
  });

  // ── Resolve default agent profile ──────────────────────────────────────

  function resolveDefaultProfileId(): string | null {
    const state = db.getAppState(database);
    return state.defaultAgentProfileId ?? null;
  }

  // ── App State ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.APP_STATE_GET, () => db.getAppState(database));

  ipcMain.handle(IPC.APP_STATE_SET, (_e: IpcMainInvokeEvent, state: AppState) => {
    db.setAppState(database, state);
  });

  // ── Agent Profiles (multi-profile) ─────────────────────────────────────

  ipcMain.handle(IPC.PROFILE_LIST, (): AgentProfile[] => {
    return db.listAgentProfiles(database);
  });

  ipcMain.handle(IPC.PROFILE_GET, (_e: IpcMainInvokeEvent, id: string): AgentProfile | null => {
    return db.getAgentProfile(database, id);
  });

  ipcMain.handle(IPC.PROFILE_SAVE, (_e: IpcMainInvokeEvent, profile: AgentProfile): AgentProfile => {
    db.saveAgentProfile(database, profile);
    return db.getAgentProfile(database, profile.id)!;
  });

  ipcMain.handle(
    IPC.PROFILE_DELETE,
    (_e: IpcMainInvokeEvent, id: string): void => {
      secrets.delete(id);
      db.archiveAgentProfile(database, id);
    }
  );

  ipcMain.handle(
    IPC.PROFILE_SET_DEFAULT,
    (_e: IpcMainInvokeEvent, id: string): void => {
      db.setDefaultAgentProfile(database, id);
    }
  );

  ipcMain.handle(
    IPC.PROFILE_UPDATE_STATUS,
    (_e: IpcMainInvokeEvent, id: string, status: ConnectionStatus): void => {
      db.updateAgentProfileStatus(database, id, status);
    }
  );

  // ── Agent Config (legacy shim — kept for ConnectAgentScreen v1) ────────

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
    const result = await testConnection(cfg, apiKey);
    // Persist status back to profile if it exists
    db.updateAgentProfileStatus(database, cfg.id, result.status);
    return result;
  });

  // ── Conversations ──────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.CONV_LIST,
    (
      _e: IpcMainInvokeEvent,
      includeArchived?: boolean,
      scopeProjectId?: string | null
    ): Conversation[] => {
      return db.listConversations(database, includeArchived ?? false, scopeProjectId);
    }
  );

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
      patch: Partial<Pick<Conversation, "title" | "updatedAt" | "pinnedAt" | "archivedAt" | "defaultAgentProfileId">>
    ): void => {
      db.updateConversation(database, id, patch);
    }
  );

  ipcMain.handle(
    IPC.CONV_SEARCH,
    (_e: IpcMainInvokeEvent, query: string, scopeProjectId?: string | null): Conversation[] => {
      return db.searchConversations(database, query, scopeProjectId);
    }
  );

  ipcMain.handle(IPC.CONV_EXPORT, (_e: IpcMainInvokeEvent, id: string): string => {
    return db.exportConversationMarkdown(database, id);
  });

  ipcMain.handle(
    IPC.MSG_SEARCH,
    (_e: IpcMainInvokeEvent, query: string, scopeProjectId?: string | null) => {
      return db.searchMessages(database, query, scopeProjectId);
    }
  );

  ipcMain.handle(IPC.CONV_DELETE, (_e: IpcMainInvokeEvent, id: string): void => {
    const sid = getActiveStreamId(id);
    if (sid) cancelStream(sid);

    // Collect all contextRefs + their message IDs BEFORE deletion, so we can
    // do a reference-safe orphan sweep afterward (branches may share snapshots).
    const msgsBefore = db.getMessagesByConversation(database, id);
    const convSnapshotRefs: import("../../shared/types.js").ContextRef[] = [];
    const convMsgIds = new Set<string>();
    for (const msg of msgsBefore) {
      convMsgIds.add(msg.id);
      if (msg.contextRefs) {
        for (const r of msg.contextRefs) convSnapshotRefs.push(r);
      }
    }

    const { attachmentPaths } = db.deleteConversation(database, id);
    for (const fp of attachmentPaths) {
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* best effort */ }
    }
    const dataDir = db.getDataDir();
    const attDir = path.join(dataDir, "attachments", id);
    try { if (fs.existsSync(attDir)) fs.rmdirSync(attDir); } catch { /* not empty */ }

    // Reference-safe snapshot cleanup: only delete snapshots with zero remaining
    // references after this conversation's messages are gone. Branch conversations
    // sharing the same snapshotPath are protected because their messages still
    // reference the snapshot ID in the DB.
    if (convSnapshotRefs.length > 0) {
      deleteOrphanedSnapshots(convSnapshotRefs, convMsgIds);
    }
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
    async (
      _e: IpcMainInvokeEvent,
      req: SendMessageRequest & { targetAgentProfileId?: string }
    ) => {
      const { conversationId, content, attachmentIds = [], replyToMessageId, targetAgentProfileId, projectId: reqProjectId } = req;

      // Resolve which profile to use:
      // 1. Explicit targetAgentProfileId from renderer (per-message override)
      // 2. Conversation's defaultAgentProfileId
      // 3. Global default
      let profileId = targetAgentProfileId;
      // Look up existing conv (may be null for a brand-new draft conversation)
      const existingConv = db.getConversation(database, conversationId);
      if (!profileId) {
        profileId = existingConv?.defaultAgentProfileId ?? resolveDefaultProfileId() ?? undefined;
      }
      if (!profileId) return { error: "No agent profile available. Please create one first." };

      // Quick validation — profile existence (apiKey resolved at process time in QueueManager)
      const profile = db.getAgentProfile(database, profileId);
      if (!profile) return { error: "Selected agent profile not found." };

      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MSG) {
        return { error: `Too many attachments (max ${MAX_ATTACHMENTS_PER_MSG}).` };
      }

      // Carry projectId: existing conv's value takes priority (immutable after creation);
      // for brand-new conversations fall back to the projectId from the request.
      const enqueueProjectId = existingConv?.projectId ?? reqProjectId;

      // Capture context ref snapshots at enqueue time (immutable)
      const extReq = req as SendMessageWithContextRequest;
      const stagedRefs = extReq.stagedContextRefs ?? [];
      const capturedContextRefs: import("../../shared/types.js").ContextRef[] = [];

      const captureFailedPaths: string[] = [];
      for (const staged of stagedRefs) {
        const stagedProject = db.getProject(database, staged.projectId);
        if (!stagedProject) continue;
        const result = projectFiles.captureSnapshot(
          staged.projectId,
          stagedProject.workingDirectory,
          staged.relativePath,
          staged.lineStart,
          staged.lineEnd
        );
        if (result.ok) {
          // projectId is now embedded at creation — no post-hoc patch needed
          capturedContextRefs.push(result.ref);
          if (process.env["NODE_ENV"] === "development") {
            // eslint-disable-next-line no-console
            console.log(
              `[context:capture] resource=${result.ref.id} project=${staged.projectId}` +
              ` path=${staged.relativePath} sha256=${result.ref.contentHash.slice(0, 8)} bytes=${result.ref.size}`
            );
          }
        } else {
          captureFailedPaths.push(staged.relativePath);
          if (process.env["NODE_ENV"] === "development") {
            // eslint-disable-next-line no-console
            console.warn(
              `[context:capture-FAIL] project=${staged.projectId} path=${staged.relativePath} error=${result.error}`
            );
          }
        }
      }
      void captureFailedPaths; // available for future caller feedback

      try {
        const result = await queueManager.enqueue({
          conversationId,
          content,
          attachmentIds,
          ...(replyToMessageId && { replyToMessageId }),
          targetAgentProfileId: profileId,
          ...(enqueueProjectId !== undefined && { projectId: enqueueProjectId }),
          ...(capturedContextRefs.length > 0 && { contextRefs: capturedContextRefs }),
        });
        return {
          queueItemId: result.queueItem.id,
          userMessage: result.userMessage,
          conversation: result.conversation,
        };
      } catch (err: unknown) {
        // Rollback: if enqueue failed, the captured snapshots were never stored in the
        // DB — they are now orphaned. Delete them immediately rather than waiting for
        // the startup orphan sweep.
        for (const ref of capturedContextRefs) {
          try {
            if (fs.existsSync(ref.snapshotPath)) fs.unlinkSync(ref.snapshotPath);
          } catch { /* best effort */ }
        }
        return { error: err instanceof Error ? err.message : "Failed to enqueue message." };
      }
    }
  );

  ipcMain.handle(IPC.CHAT_CANCEL, (_e: IpcMainInvokeEvent, convId: string) => {
    const sid = getActiveStreamId(convId);
    if (sid) cancelStream(sid);
  });

  // ── Queue management ───────────────────────────────────────────────────

  ipcMain.handle(IPC.QUEUE_GET, (_e: IpcMainInvokeEvent, convId: string) => {
    return queueManager.getQueue(convId);
  });

  // Returns live AgentRun runtime state for a conversation.
  // Renderer calls this on mount/conv-switch to hydrate mid-run UI.
  ipcMain.handle(IPC.RUNTIME_STATE_GET, (_e: IpcMainInvokeEvent, convId: string) => {
    return queueManager.getConvRuntimeState(convId);
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
    async (
      _e: IpcMainInvokeEvent,
      convId: string,
      action?: "retry" | "skip",
      itemId?: string
    ): Promise<{ error: string } | void> => {
      // No longer need to resolve agent here — QueueManager resolves per item
      if (action === "retry" && itemId) {
        await queueManager.retry(convId, itemId);
      } else if (action === "skip" && itemId) {
        await queueManager.skip(convId, itemId);
      } else {
        await queueManager.resume(convId);
      }
    }
  );

  ipcMain.handle(IPC.QUEUE_CLEAR, (_e: IpcMainInvokeEvent, convId: string) => {
    queueManager.clearQueue(convId);
  });

  // ── Projects ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.PROJECT_LIST, (): Project[] => {
    return db.listProjects(database);
  });

  ipcMain.handle(IPC.PROJECT_GET, (_e: IpcMainInvokeEvent, id: string): Project | null => {
    return db.getProject(database, id);
  });

  ipcMain.handle(
    IPC.PROJECT_CREATE,
    (
      _e: IpcMainInvokeEvent,
      data: { name: string; workingDirectory: string; defaultAgentProfileId?: string; description?: string }
    ): { ok: true; project: Project } | { ok: false; error: string } => {
      const normalized = path.normalize(data.workingDirectory);
      // Prevent duplicate directory
      const existing = db.getProjectByDirectory(database, normalized);
      if (existing) {
        return { ok: false, error: `A project with this folder already exists: "${existing.name}"` };
      }
      // Directory must exist
      if (!fs.existsSync(normalized)) {
        return { ok: false, error: "The selected folder does not exist." };
      }
      const now = Date.now();
      const project: Project = {
        id: randomUUID(),
        name: data.name.trim() || path.basename(normalized),
        workingDirectory: normalized,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        ...(data.defaultAgentProfileId !== undefined && { defaultAgentProfileId: data.defaultAgentProfileId }),
        ...(data.description !== undefined && data.description.trim() !== "" && { description: data.description.trim() }),
      };
      db.createProject(database, project);
      return { ok: true, project };
    }
  );

  ipcMain.handle(
    IPC.PROJECT_UPDATE,
    (
      _e: IpcMainInvokeEvent,
      id: string,
      patch: Partial<Omit<Project, "id" | "createdAt">>
    ): Project | null => {
      // If workingDirectory is being changed, normalize and check duplicates
      if (patch.workingDirectory !== undefined) {
        const normalized = path.normalize(patch.workingDirectory);
        const existing = db.getProjectByDirectory(database, normalized);
        if (existing && existing.id !== id) {
          return null; // caller should handle
        }
        patch = { ...patch, workingDirectory: normalized };
      }
      return db.updateProject(database, id, patch);
    }
  );

  ipcMain.handle(
    IPC.PROJECT_REMOVE,
    (_e: IpcMainInvokeEvent, id: string): void => {
      // Soft-archive — NEVER touches the filesystem folder
      db.archiveProject(database, id);
    }
  );

  /**
   * Validate whether a directory path is accessible.
   * Returns "ok" | "missing" | "unknown".
   * The renderer can ONLY ask about paths it already knows (from projects it owns),
   * not enumerate arbitrary filesystem locations.
   */
  ipcMain.handle(
    IPC.PROJECT_VALIDATE_DIR,
    (_e: IpcMainInvokeEvent, id: string): DirectoryStatus => {
      const project = db.getProject(database, id);
      if (!project) return "unknown";
      try {
        const stat = fs.statSync(project.workingDirectory);
        return stat.isDirectory() ? "ok" : "missing";
      } catch {
        return "missing";
      }
    }
  );

  /**
   * Open a native folder picker dialog.
   * Returns the selected path or null (cancelled).
   * The renderer never gets arbitrary filesystem access — it only receives
   * the single path the user consciously chose via the native dialog.
   */
  ipcMain.handle(
    IPC.PROJECT_PICK_DIR,
    async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Select Project Folder",
        buttonLabel: "Select Folder",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return path.normalize(result.filePaths[0]!);
    }
  );

  /**
   * Reveal the project folder in Finder/Explorer.
   * Uses the stored path — renderer sends only the project id.
   */
  ipcMain.handle(
    IPC.PROJECT_REVEAL_DIR,
    (_e: IpcMainInvokeEvent, id: string): void => {
      const project = db.getProject(database, id);
      if (!project) return;
      void shell.openPath(project.workingDirectory);
    }
  );

  // ── Project file system (V0.2) ───────────────────────────────────────────

  /** List one directory level inside the project. relativePath="" → root. */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_DIR_LIST,
    (
      _e: IpcMainInvokeEvent,
      projectId: string,
      relativePath: string
    ) => {
      const project = db.getProject(database, projectId);
      if (!project) return { ok: false, error: "Project not found" };
      return projectFiles.listDirectory(projectId, project.workingDirectory, relativePath ?? "");
    }
  );

  /** Read a file's text content. lineStart/lineEnd are 1-based. */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_FILE_READ,
    (
      _e: IpcMainInvokeEvent,
      projectId: string,
      relativePath: string,
      lineStart?: number,
      lineEnd?: number
    ) => {
      const project = db.getProject(database, projectId);
      if (!project) return { ok: false, error: "Project not found" };
      return projectFiles.readFile(project.workingDirectory, relativePath, lineStart, lineEnd, false);
    }
  );

  /** Capture a context snapshot (returns ContextRef). */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_FILE_SNAPSHOT,
    (
      _e: IpcMainInvokeEvent,
      projectId: string,
      relativePath: string,
      lineStart?: number,
      lineEnd?: number
    ) => {
      const project = db.getProject(database, projectId);
      if (!project) return { ok: false, error: "Project not found" };
      // projectId is now embedded by captureSnapshot itself — no post-hoc patch
      return projectFiles.captureSnapshot(
        projectId, project.workingDirectory, relativePath, lineStart, lineEnd
      );
    }
  );

  /** Search project files by name/path query. */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_FILE_SEARCH,
    (
      _e: IpcMainInvokeEvent,
      projectId: string,
      query: string,
      limit?: number
    ) => {
      const project = db.getProject(database, projectId);
      if (!project) return [];
      return projectFiles.searchFiles(projectId, project.workingDirectory, query, limit ?? 50);
    }
  );

  /** Get index build status. */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_INDEX_STATUS,
    (_e: IpcMainInvokeEvent, projectId: string) => {
      return projectFiles.getIndexStatus(projectId);
    }
  );

  /** Trigger async index build + start file watcher for incremental updates. */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_INDEX_BUILD,
    (_e: IpcMainInvokeEvent, projectId: string) => {
      const project = db.getProject(database, projectId);
      if (!project) return;
      // Async non-blocking build (setImmediate-chunked in service.ts)
      projectFiles.buildIndex(projectId, project.workingDirectory);
      // Start watcher so file creates/modifies/deletes trigger incremental rebuild
      ensureProjectWatcher(projectId, project.workingDirectory);
    }
  );

  /** Read snapshot content by path (for display in history). */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_SNAPSHOT_READ,
    (_e: IpcMainInvokeEvent, snapshotPath: string) => {
      // Security: snapshotPath must be inside dataDir/snapshots/
      const dataDir = db.getDataDir();
      const snapshotsDir = path.resolve(path.join(dataDir, "snapshots"));
      const resolved = path.resolve(snapshotPath);
      if (!resolved.startsWith(snapshotsDir + path.sep)) {
        return { ok: false, error: "Invalid snapshot path" };
      }
      const content = projectFiles.readSnapshot(resolved);
      if (content === null) return { ok: false, error: "Snapshot not found" };
      return { ok: true, content };
    }
  );

  /** Preview which files would be included from a folder. */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_FOLDER_CONTEXT_PREVIEW,
    (
      _e: IpcMainInvokeEvent,
      projectId: string,
      relativePath: string
    ) => {
      const project = db.getProject(database, projectId);
      if (!project) return { ok: false, error: "Project not found" };
      return projectFiles.folderContextPreview(project.workingDirectory, relativePath);
    }
  );

  // ── Clipboard ──────────────────────────────────────────────────────────

  ipcMain.handle("clipboard:write", (_e: IpcMainInvokeEvent, text: string) => {
    clipboard.writeText(text);
  });

  // ── Safe File Editing (V0.3) ───────────────────────────────────────────────

  /** Apply lock: prevents concurrent writes to the same file */
  const applyLock = new Map<string, true>();

  ipcMain.handle(
    EDIT_IPC.PROPOSAL_GET,
    (_e: IpcMainInvokeEvent, proposalId: string): import("../../shared/types.js").EditProposal | null => {
      return db.getProposal(database, proposalId);
    }
  );

  ipcMain.handle(
    EDIT_IPC.PROPOSAL_LIST,
    (_e: IpcMainInvokeEvent, conversationId: string): import("../../shared/types.js").EditProposal[] => {
      return db.listProposalsForConversation(database, conversationId);
    }
  );

  ipcMain.handle(
    EDIT_IPC.PROPOSAL_REJECT,
    (
      _e: IpcMainInvokeEvent,
      proposalId: string,
      fileEditIds?: string[]
    ): { ok: boolean; error?: string } => {
      const proposal = db.getProposal(database, proposalId);
      if (!proposal) return { ok: false, error: "Proposal not found" };

      if (!fileEditIds || fileEditIds.length === 0) {
        const updated = db.updateProposal(database, proposalId, { status: "rejected", updatedAt: Date.now() });
        if (!updated) return { ok: false, error: "Failed to update proposal" };
        mainSender.send(EDIT_IPC.PROPOSAL_UPDATE, updated);
        return { ok: true };
      }

      const updatedFileEdits = proposal.fileEdits.map((fe) => {
        if (fileEditIds.includes(fe.id)) {
          return { ...fe, status: "rejected" as const, updatedAt: Date.now() };
        }
        return fe;
      });
      const newStatus = editService.computeProposalStatus(updatedFileEdits);
      const updated = db.updateProposal(database, proposalId, {
        fileEdits: updatedFileEdits,
        status: newStatus,
        updatedAt: Date.now(),
      });
      if (!updated) return { ok: false, error: "Failed to update proposal" };
      mainSender.send(EDIT_IPC.PROPOSAL_UPDATE, updated);
      return { ok: true };
    }
  );

  ipcMain.handle(
    EDIT_IPC.PROPOSAL_READ_TARGET,
    (
      _e: IpcMainInvokeEvent,
      proposalId: string,
      fileEditId: string
    ):
      | { ok: true; proposedContent: string; baseContent: string }
      | { ok: false; error: string } => {
      const proposal = db.getProposal(database, proposalId);
      if (!proposal) return { ok: false, error: "Proposal not found" };
      const fe = proposal.fileEdits.find((f) => f.id === fileEditId);
      if (!fe) return { ok: false, error: "File edit not found" };

      // Proposed content (what the model wants to write)
      const proposedContent = editService.readProposalTarget(fe.targetResourcePath);
      if (proposedContent === null)
        return { ok: false, error: "Proposal target resource not found" };

      // Base content — resolve via the canonical immutable resource resolver.
      // This searches BOTH manual ContextRefs (msg.contextRefs) AND autonomous
      // AgentReadRefs (ledger.agentReadRefs), so autonomous edits work without
      // requiring the user to manually add the file to context.
      let baseContent: string | null = null;
      if (fe.baseSnapshotId) {
        const resolved = resolveImmutableFileResource(fe.baseSnapshotId, proposal.projectId, database);
        if (resolved !== null) {
          // Integrity check: verify snapshot hash before returning content
          let raw: string | null = null;
          try { raw = fs.readFileSync(resolved.snapshotPath, "utf8"); } catch { raw = null; }
          if (raw !== null) {
            const actualHash = createHash("sha256").update(raw).digest("hex");
            if (actualHash === resolved.contentHash) {
              baseContent = raw;
            }
            // Hash mismatch: leave baseContent null → returns "Base snapshot integrity failed"
          }
        }
      }

      if (baseContent === null) {
        return {
          ok: false,
          error: `Base snapshot not available for "${fe.relativePath}". ` +
            `The base snapshot may have been deleted or corrupted. ` +
            `Re-read the file in a new message to regenerate the proposal.`,
        };
      }

      return { ok: true, proposedContent, baseContent };
    }
  );

  ipcMain.handle(
    EDIT_IPC.PREFLIGHT_CHECK,
    (
      _e: IpcMainInvokeEvent,
      proposalId: string,
      selectedFileEditIds: string[]
    ): import("../../shared/types.js").PreflightResult[] => {
      const proposal = db.getProposal(database, proposalId);
      if (!proposal) return [];
      const project = db.getProject(database, proposal.projectId);
      if (!project) return [];
      return editService.preflightFileEdits(project.workingDirectory, proposal, selectedFileEditIds);
    }
  );

  ipcMain.handle(
    EDIT_IPC.APPLY_SELECTED,
    async (
      _e: IpcMainInvokeEvent,
      proposalId: string,
      selectedFileEditIds: string[]
    ): Promise<{ ok: boolean; appliedEditIds?: string[]; preflightFailures?: import("../../shared/types.js").PreflightResult[]; error?: string }> => {
      const proposal = db.getProposal(database, proposalId);
      if (!proposal) return { ok: false, error: "Proposal not found" };
      const project = db.getProject(database, proposal.projectId);
      if (!project) return { ok: false, error: "Project not found" };

      if (!selectedFileEditIds || selectedFileEditIds.length === 0) {
        return { ok: false, error: "No file edits selected" };
      }

      // ── Permission Center: project.modify check ────────────────────────────
      {
        const permCtx = {
          capabilityId: "project.modify",
          projectId: proposal.projectId,
        };
        const perm = permissionEngine.resolvePermission(permCtx);
        if (perm.decision === "DENY") {
          return { ok: false, error: `project.modify denied by Permission Center (${perm.source}: ${perm.reason})` };
        }
        if (perm.decision === "ASK") {
          try {
            const approval = await permissionEngine.requestPermissionApproval(
              permCtx,
              `Apply ${selectedFileEditIds.length} file edit(s) to project`
            );
            if (approval.decision !== "ALLOW") {
              return { ok: false, error: "project.modify denied by user" };
            }
          } catch {
            return { ok: false, error: "project.modify approval cancelled" };
          }
        }
      }

      // Acquire apply locks for all target files
      const lockKeys: string[] = [];
      for (const feId of selectedFileEditIds) {
        const fe = proposal.fileEdits.find((f) => f.id === feId);
        if (fe) lockKeys.push(`${proposal.projectId}:${fe.relativePath}`);
      }
      for (const key of lockKeys) {
        if (applyLock.has(key)) {
          return { ok: false, error: `File is already being written: ${key.split(":")[1] ?? key}` };
        }
      }
      for (const key of lockKeys) applyLock.set(key, true);

      try {
        // INV: APPLY_REQUIRES_APPROVAL — proposal must not already be fully applied
        assertInvariant(
          "APPLY_REQUIRES_APPROVAL",
          proposal.status !== "applied",
          { proposalStatus: proposal.status, proposalId, selectedCount: selectedFileEditIds.length },
          { hint: "APPLY_SELECTED top-of-handler" }
        );

        // Phase 1: Preflight ALL files before writing ANY
        const preflightResults = editService.preflightFileEdits(
          project.workingDirectory,
          proposal,
          selectedFileEditIds
        );
        const failures = preflightResults.filter((r) => !r.ok);
        if (failures.length > 0) {
          return { ok: false, preflightFailures: failures };
        }

        // INV: STALE_BASE_PROTECTION — all preflight results passed, safe to proceed
        assertInvariant(
          "STALE_BASE_PROTECTION",
          preflightResults.every(r => r.ok),
          { preflightCount: preflightResults.length, proposalId },
          { hint: "APPLY_SELECTED after preflight" }
        );

        // Phase 2: Apply each file edit
        const appliedEditIds: string[] = [];
        const appliedEditsThisRun: import("../../shared/types.js").AppliedEdit[] = [];
        let firstError: string | null = null;
        let rollbackFailures: string[] = [];

        for (const feId of selectedFileEditIds) {
          const fe = proposal.fileEdits.find((f) => f.id === feId);
          if (!fe) continue;

          const proposedContent = editService.readProposalTarget(fe.targetResourcePath);
          if (proposedContent === null) {
            firstError = `Proposal target resource missing for ${fe.relativePath}`;
            break;
          }

          const targetAbsPath = path.join(project.workingDirectory, fe.relativePath);
          const appliedEditId = randomUUID();

          const backupResult = editService.createBackupSnapshot(appliedEditId, targetAbsPath);
          if (!backupResult.ok) {
            firstError = `Backup failed for ${fe.relativePath}: ${backupResult.error}`;
            break;
          }

          const writeResult = editService.writeFileAtomicWithProject(
            project.workingDirectory,
            project.id,
            fe.relativePath,
            proposedContent,
            fe.targetContentHash
          );
          if (!writeResult.ok) {
            // Discard unused backup for this file
            try { if (fs.existsSync(backupResult.backupPath)) fs.unlinkSync(backupResult.backupPath); } catch { /* ignore */ }
            firstError = `Write failed for ${fe.relativePath}: ${writeResult.error}`;
            break;
          }

          const appliedEdit: import("../../shared/types.js").AppliedEdit = {
            id: appliedEditId,
            proposalId,
            fileEditId: feId,
            conversationId: proposal.conversationId,
            projectId: proposal.projectId,
            relativePath: fe.relativePath,
            backupResourcePath: backupResult.backupPath,
            backupContentHash: backupResult.contentHash,
            appliedContentHash: writeResult.actualHash,
            appliedAt: Date.now(),
          };
          db.saveAppliedEdit(database, appliedEdit);
          appliedEditsThisRun.push(appliedEdit);
          appliedEditIds.push(appliedEditId);
        }

        // If any write failed, attempt to rollback already-written files
        if (firstError && appliedEditsThisRun.length > 0) {
          rollbackFailures = [];
          for (const ae of appliedEditsThisRun) {
            const rbResult = editService.restoreFromBackup(
              project.workingDirectory,
              project.id,
              ae.relativePath,
              ae.backupResourcePath,
              ae.backupContentHash,
              ae.appliedContentHash
            );
            if (rbResult.ok) {
              // Mark as rolled back — update undoneAt so it's not shown as undo-able
              db.updateAppliedEdit(database, ae.id, { undoneAt: Date.now() });
            } else {
              rollbackFailures.push(ae.relativePath);
            }
          }
          // INV: ROLLBACK_CORRECTNESS — any rollback failure is a data-safety violation
          assertInvariant(
            "ROLLBACK_CORRECTNESS",
            rollbackFailures.length === 0,
            { rollbackFailures, firstError, proposalId },
            { hint: "APPLY_SELECTED rollback loop" }
          );
          // INV: INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES — if rollback also failed,
          // we have a partial state; record the violation
          if (rollbackFailures.length > 0) {
            assertInvariant(
              "INVALID_PROPOSAL_NEVER_PARTIALLY_APPLIES",
              false, // partial write DID occur and could not be rolled back
              { rollbackFailures, appliedCount: appliedEditsThisRun.length, proposalId },
              { hint: "APPLY_SELECTED partial state after rollback failure" }
            );
          }
        }

        // Update FileEdit statuses in DB
        const updatedFileEdits = proposal.fileEdits.map((fe) => {
          if (firstError) {
            // On failure, mark all selected as failed (rollback attempted)
            if (selectedFileEditIds.includes(fe.id)) {
              const rbFailed = rollbackFailures.includes(fe.relativePath);
              const wasWritten = appliedEditsThisRun.some((ae) => ae.fileEditId === fe.id);
              if (wasWritten && rbFailed) {
                return { ...fe, status: "failed" as const, failureReason: `Write succeeded but rollback failed — file may be in inconsistent state`, updatedAt: Date.now() };
              }
              return { ...fe, status: "failed" as const, failureReason: firstError ?? "Apply failed", updatedAt: Date.now() };
            }
            return fe;
          }
          if (appliedEditsThisRun.some((ae) => ae.fileEditId === fe.id)) {
            return { ...fe, status: "applied" as const, updatedAt: Date.now() };
          }
          return fe;
        });
        const newStatus = editService.computeProposalStatus(updatedFileEdits);
        const updatedProposal = db.updateProposal(database, proposalId, {
          fileEdits: updatedFileEdits,
          status: newStatus,
          updatedAt: Date.now(),
        });
        if (updatedProposal) mainSender.send(EDIT_IPC.PROPOSAL_UPDATE, updatedProposal);

        if (firstError) {
          const rbMsg = rollbackFailures.length > 0
            ? ` (rollback failed for: ${rollbackFailures.join(", ")})`
            : appliedEditsThisRun.length > 0 ? " (already-written files rolled back)" : "";
          return { ok: false, error: firstError + rbMsg };
        }
        return { ok: true, appliedEditIds };
      } finally {
        for (const key of lockKeys) applyLock.delete(key);
      }
    }
  );

  ipcMain.handle(
    EDIT_IPC.UNDO_APPLY,
    async (
      _e: IpcMainInvokeEvent,
      appliedEditId: string
    ): Promise<{ ok: boolean; error?: string }> => {
      const appliedEdit = db.getAppliedEdit(database, appliedEditId);
      if (!appliedEdit) return { ok: false, error: "Applied edit not found" };
      if (appliedEdit.undoneAt) return { ok: false, error: "This edit has already been undone" };

      // INV: APPLY_REQUIRES_APPROVAL — undo only valid on non-undone applied edits
      assertInvariant(
        "APPLY_REQUIRES_APPROVAL",
        appliedEdit.undoneAt == null,
        { appliedEditId, undoneAt: appliedEdit.undoneAt },
        { hint: "UNDO_APPLY top-of-handler" }
      );

      const project = db.getProject(database, appliedEdit.projectId);
      if (!project) return { ok: false, error: "Project not found" };

      const lockKey = `${appliedEdit.projectId}:${appliedEdit.relativePath}`;
      if (applyLock.has(lockKey)) return { ok: false, error: "File is currently being written" };
      applyLock.set(lockKey, true);

      try {
        const result = editService.restoreFromBackup(
          project.workingDirectory,
          project.id,
          appliedEdit.relativePath,
          appliedEdit.backupResourcePath,
          appliedEdit.backupContentHash,
          appliedEdit.appliedContentHash
        );
        if (!result.ok) return { ok: false, error: result.error };

        db.updateAppliedEdit(database, appliedEditId, { undoneAt: Date.now() });

        const proposal = db.getProposal(database, appliedEdit.proposalId);
        if (proposal) {
          const updatedFileEdits = proposal.fileEdits.map((fe) => {
            if (fe.id === appliedEdit.fileEditId) {
              return { ...fe, status: "stale" as const, failureReason: "Edit was undone", updatedAt: Date.now() };
            }
            return fe;
          });
          const newStatus = editService.computeProposalStatus(updatedFileEdits);
          const updatedProposal = db.updateProposal(database, appliedEdit.proposalId, {
            fileEdits: updatedFileEdits,
            status: newStatus,
            updatedAt: Date.now(),
          });
          if (updatedProposal) mainSender.send(EDIT_IPC.PROPOSAL_UPDATE, updatedProposal);
        }
        return { ok: true };
      } finally {
        applyLock.delete(lockKey);
      }
    }
  );

  ipcMain.handle(
    EDIT_IPC.EDIT_HISTORY_LIST,
    (_e: IpcMainInvokeEvent, projectId: string): import("../../shared/types.js").AppliedEdit[] => {
      return db.listAppliedEditsForProject(database, projectId);
    }
  );

  // ── V0.4 Agent Tool IPC ────────────────────────────────────────────────
  ipcMain.handle(
    AGENT_TOOL_IPC.LEDGER_GET,
    (_e: IpcMainInvokeEvent, requestId: string): import("../../shared/types.js").RequestContextLedger | null => {
      return db.getLedger(database, requestId);
    }
  );

  ipcMain.handle(
    AGENT_TOOL_IPC.TOOL_ACTIVITY_GET,
    (_e: IpcMainInvokeEvent, conversationId: string): import("../../shared/types.js").ToolActivityEntry[] => {
      const ledgers = db.getLedgersByConversation(database, conversationId);
      const allActivity: import("../../shared/types.js").ToolActivityEntry[] = [];
      for (const ledger of ledgers) {
        allActivity.push(...ledger.toolActivity);
      }
      // Sort by executedAt ascending
      allActivity.sort((a, b) => a.executedAt - b.executedAt);
      return allActivity;
    }
  );

  // ── V0.9 Reliability IPC ───────────────────────────────────────────────
  ipcMain.handle(
    RELIABILITY_IPC.INCIDENTS_LIST,
    (): import("../../shared/types.js").ForgeIncident[] => {
      return tryGetIncidentRecorder()?.getAll() ?? [];
    }
  );

  ipcMain.handle(
    RELIABILITY_IPC.INCIDENT_GET,
    (_e: IpcMainInvokeEvent, id: string): import("../../shared/types.js").ForgeIncident | undefined => {
      return tryGetIncidentRecorder()?.getById(id);
    }
  );

  ipcMain.handle(
    RELIABILITY_IPC.INCIDENT_SHARE_PAYLOAD,
    (_e: IpcMainInvokeEvent, id: string): Record<string, unknown> | null => {
      const recorder = tryGetIncidentRecorder();
      if (!recorder) return null;
      const inc = recorder.getById(id);
      if (!inc) return null;
      const payload = buildGitHubIssuePayload({
        invariantId: inc.invariantId,
        failureCode: inc.failureCode,
        category: inc.category,
        severity: inc.severity,
        fingerprint: inc.fingerprint,
        forgeVersion: inc.forgeVersion,
        runtimeSchemaVersion: inc.runtimeSchemaVersion,
        observedState: inc.observedState,
        ...(inc.traceId !== undefined && { traceId: inc.traceId }),
        occurrenceCount: inc.occurrenceCount,
      });
      return payload as Record<string, unknown>;
    }
  );

  ipcMain.handle(
    RELIABILITY_IPC.INCIDENTS_CLEAR,
    (): void => {
      tryGetIncidentRecorder()?.clear();
    }
  );

  ipcMain.handle(
    RELIABILITY_IPC.METRICS_GET,
    (): Record<string, unknown> => {
      const recorder = tryGetIncidentRecorder();
      if (!recorder) return { total: 0, critical: 0, high: 0, byCategory: {}, knownIssues: 0, oldestSeen: null };
      return recorder.getMetrics() as unknown as Record<string, unknown>;
    }
  );

  // ── App Settings (V0.9 addendum) ─────────────────────────────────────────

  ipcMain.handle(
    SETTINGS_IPC.GET,
    () => db.getAppSettings(true)
  );

  ipcMain.handle(
    SETTINGS_IPC.SET,
    (_e: IpcMainInvokeEvent, patch: Partial<import("../../shared/types.js").AppSettings>) =>
      db.setAppSettings(true, patch)
  );

  // ── Safe Terminal V1 — Command IPC ────────────────────────────────────────
  //
  // NOTE: COMMAND_IPC.STATE_CHANGE, OUTPUT_CHUNK, COMPLETE are pushed from
  //       command-manager (main→renderer), so they are NOT registered here.

  ipcMain.handle(
    COMMAND_IPC.LIST,
    (
      _e: IpcMainInvokeEvent,
      projectId?: string,
      conversationId?: string
    ) => commandManager.listCommands(projectId, conversationId)
  );

  ipcMain.handle(
    COMMAND_IPC.GET,
    (_e: IpcMainInvokeEvent, commandId: string) =>
      commandManager.getCommand(commandId)
  );

  ipcMain.handle(
    COMMAND_IPC.APPROVE,
    (_e: IpcMainInvokeEvent, commandId: string, mode: "once" | "trust") =>
      commandManager.approveCommand(commandId, mode)
  );

  ipcMain.handle(
    COMMAND_IPC.REJECT,
    (_e: IpcMainInvokeEvent, commandId: string) =>
      commandManager.rejectCommand(commandId)
  );

  ipcMain.handle(
    COMMAND_IPC.CANCEL,
    (_e: IpcMainInvokeEvent, commandId: string) =>
      commandManager.cancelCommand(commandId)
  );

  ipcMain.handle(
    COMMAND_IPC.READ_OUTPUT,
    (_e: IpcMainInvokeEvent, commandId: string, offsetBytes?: number, limitBytes?: number) =>
      commandManager.readCommandOutput(commandId, offsetBytes, limitBytes)
  );

  ipcMain.handle(
    COMMAND_IPC.LIST_TRUST,
    (_e: IpcMainInvokeEvent, projectId: string) =>
      commandManager.listTrustRules(projectId)
  );

  ipcMain.handle(
    COMMAND_IPC.REVOKE_TRUST,
    (_e: IpcMainInvokeEvent, ruleId: string) => {
      commandManager.revokeTrustRule(ruleId);
    }
  );

  ipcMain.handle(
    COMMAND_IPC.RUNTIME_STATE,
    (_e: IpcMainInvokeEvent, projectId: string) =>
      commandManager.listCommands(projectId)
  );

  // RUN_USER: user-initiated command from renderer (project mode only)
  ipcMain.handle(
    COMMAND_IPC.RUN_USER,
    (
      _e: IpcMainInvokeEvent,
      opts: {
        projectId: string;
        projectRoot: string;
        executable: string;
        args: string[];
        cwdRelative: string;
        conversationId?: string;
      }
    ) => {
      const spec: import("../../shared/types.js").CommandSpec = {
        executable: opts.executable,
        args: opts.args,
        cwdRelative: opts.cwdRelative,
      };
      return commandManager.propose({
        projectId: opts.projectId,
        projectRoot: opts.projectRoot,
        spec,
        source: "user",
        ...(opts.conversationId !== undefined && { conversationId: opts.conversationId }),
      });
    }
  );

  // ── Browser Runtime V1 IPC Handlers ───────────────────────────────────────

  // Profile management
  ipcMain.handle(
    BROWSER_IPC.LIST_PROFILES,
    (_e: IpcMainInvokeEvent) => browserManager.listBrowserProfilesPublic()
  );

  ipcMain.handle(
    BROWSER_IPC.CREATE_PROFILE,
    (
      _e: IpcMainInvokeEvent,
      opts: { name: string; persistenceMode: "persistent" | "private"; agentAccessPolicy?: "off" | "ask" | "allowed" }
    ) => browserManager.createBrowserProfile(opts)
  );

  ipcMain.handle(
    BROWSER_IPC.UPDATE_PROFILE,
    (
      _e: IpcMainInvokeEvent,
      id: string,
      patch: { name?: string; agentAccessPolicy?: "off" | "ask" | "allowed"; isDefault?: boolean }
    ) => browserManager.updateBrowserProfilePublic(id, patch)
  );

  ipcMain.handle(
    BROWSER_IPC.DELETE_PROFILE,
    async (_e: IpcMainInvokeEvent, id: string) => {
      await browserManager.deleteBrowserProfilePublic(id);
    }
  );

  // Session management
  ipcMain.handle(
    BROWSER_IPC.LIST_SESSIONS,
    (_e: IpcMainInvokeEvent, profileId?: string) =>
      db.listBrowserSessions(database, profileId)
  );

  ipcMain.handle(
    BROWSER_IPC.CREATE_SESSION,
    async (_e: IpcMainInvokeEvent, profileId: string, opts?: { name?: string }) =>
      browserManager.createBrowserSession(profileId, opts)
  );

  ipcMain.handle(
    BROWSER_IPC.CLOSE_SESSION,
    async (_e: IpcMainInvokeEvent, sessionId: string) => {
      await browserManager.closeBrowserSession(sessionId);
    }
  );

  ipcMain.handle(
    BROWSER_IPC.ACTIVATE_SESSION,
    (_e: IpcMainInvokeEvent, sessionId: string) => {
      browserManager.activateSession(sessionId);
    }
  );

  // Tab management
  ipcMain.handle(
    BROWSER_IPC.LIST_TABS,
    (_e: IpcMainInvokeEvent, sessionId: string) =>
      db.listBrowserTabs(database, sessionId)
  );

  ipcMain.handle(
    BROWSER_IPC.NEW_TAB,
    async (_e: IpcMainInvokeEvent, sessionId: string, url?: string) =>
      browserManager.newBrowserTab(sessionId, url)
  );

  ipcMain.handle(
    BROWSER_IPC.CLOSE_TAB,
    (_e: IpcMainInvokeEvent, tabId: string) => {
      browserManager.closeBrowserTab(tabId);
    }
  );

  ipcMain.handle(
    BROWSER_IPC.ACTIVATE_TAB,
    (_e: IpcMainInvokeEvent, tabId: string) => {
      browserManager.activateTab(tabId);
    }
  );

  // Navigation
  ipcMain.handle(
    BROWSER_IPC.NAVIGATE,
    async (_e: IpcMainInvokeEvent, tabId: string, url: string) => {
      await browserManager.navigateTab(tabId, url);
    }
  );

  ipcMain.handle(
    BROWSER_IPC.NAVIGATE_BACK,
    (_e: IpcMainInvokeEvent, tabId: string) => { browserManager.navigateBack(tabId); }
  );

  ipcMain.handle(
    BROWSER_IPC.NAVIGATE_FORWARD,
    (_e: IpcMainInvokeEvent, tabId: string) => { browserManager.navigateForward(tabId); }
  );

  ipcMain.handle(
    BROWSER_IPC.RELOAD,
    (_e: IpcMainInvokeEvent, tabId: string) => { browserManager.reloadTab(tabId); }
  );

  ipcMain.handle(
    BROWSER_IPC.STOP,
    (_e: IpcMainInvokeEvent, tabId: string) => { browserManager.stopTab(tabId); }
  );

  // View positioning (renderer sends bounds after layout)
  ipcMain.handle(
    BROWSER_IPC.RESIZE_VIEW,
    (_e: IpcMainInvokeEvent, rect: { x: number; y: number; width: number; height: number }) => {
      browserManager.setBrowserViewBounds(rect);
    }
  );

  ipcMain.handle(
    BROWSER_IPC.HIDE_VIEW,
    (_e: IpcMainInvokeEvent) => { browserManager.hideBrowserView(); }
  );

  ipcMain.handle(
    BROWSER_IPC.SHOW_VIEW,
    (_e: IpcMainInvokeEvent, tabId?: string) => { browserManager.showBrowserView(tabId); }
  );

  // Agent access control
  ipcMain.handle(
    BROWSER_IPC.GRANT_AGENT_ACCESS,
    (_e: IpcMainInvokeEvent, control: import("../../shared/types.js").BrowserAgentControl) => {
      browserManager.grantAgentControl(control);
    }
  );

  ipcMain.handle(
    BROWSER_IPC.REVOKE_AGENT_ACCESS,
    (_e: IpcMainInvokeEvent, sessionId: string) => {
      browserManager.revokeAgentControl(sessionId);
    }
  );

  ipcMain.handle(
    BROWSER_IPC.USER_TAKE_CONTROL,
    (_e: IpcMainInvokeEvent, sessionId: string) => {
      browserManager.userTakeControl(sessionId);
    }
  );

  ipcMain.handle(
    BROWSER_IPC.RETURN_TO_AGENT,
    (_e: IpcMainInvokeEvent) => {
      // No-op from renderer side — agent controls are re-established by next agent run
    }
  );

  // Approval resolution
  ipcMain.handle(
    BROWSER_IPC.APPROVE_ACTION,
    (_e: IpcMainInvokeEvent, approvalId: string) => {
      browserManager.resolveApproval(approvalId, true);
    }
  );

  ipcMain.handle(
    BROWSER_IPC.REJECT_ACTION,
    (_e: IpcMainInvokeEvent, approvalId: string) => {
      browserManager.resolveApproval(approvalId, false);
    }
  );

  // Runtime state snapshot (for initial render hydration)
  ipcMain.handle(
    BROWSER_IPC.GET_RUNTIME_STATE,
    (_e: IpcMainInvokeEvent) => browserManager.getBrowserRuntimeState()
  );

  // Open the standalone Forge Browser window (or focus if already open)
  ipcMain.handle(
    BROWSER_IPC.OPEN_WINDOW,
    (_e: IpcMainInvokeEvent) => { browserWindowController.openBrowserWindow(); }
  );

  // Focus the standalone Forge Browser window (no-op if not open)
  ipcMain.handle(
    BROWSER_IPC.FOCUS_WINDOW,
    (_e: IpcMainInvokeEvent) => { browserWindowController.focusBrowserWindow(); }
  );


  // ── Browser V2.1: Read-only status ──────────────────────────────────────
  ipcMain.handle(
    BROWSER_IPC.BROWSER_STATUS,
    (_e: IpcMainInvokeEvent) => browserManager.getBrowserStatus()
  );

  // ── Browser V2.1: Bookmarks ─────────────────────────────────────────────
  ipcMain.handle(
    BROWSER_IPC.BOOKMARK_LIST,
    (_e: IpcMainInvokeEvent, profileId?: string) => browserManager.getBookmarks(profileId)
  );

  ipcMain.handle(
    BROWSER_IPC.BOOKMARK_ADD,
    (_e: IpcMainInvokeEvent, opts: { profileId: string; url: string; title: string; favicon?: string }) =>
      browserManager.addBookmark(opts)
  );

  ipcMain.handle(
    BROWSER_IPC.BOOKMARK_REMOVE,
    (_e: IpcMainInvokeEvent, id: string) => { browserManager.removeBookmark(id); }
  );

  ipcMain.handle(
    BROWSER_IPC.BOOKMARK_UPDATE,
    (_e: IpcMainInvokeEvent, id: string, patch: { title?: string }) =>
      browserManager.editBookmark(id, patch)
  );

  // ── Browser V2.1: History ───────────────────────────────────────────────
  ipcMain.handle(
    BROWSER_IPC.HISTORY_LIST,
    (_e: IpcMainInvokeEvent, profileId?: string, limit?: number) =>
      browserManager.getBrowserHistory(profileId, limit)
  );

  ipcMain.handle(
    BROWSER_IPC.HISTORY_CLEAR,
    (_e: IpcMainInvokeEvent, profileId?: string) => { browserManager.clearBrowserHistory(profileId); }
  );

  ipcMain.handle(
    BROWSER_IPC.RETURN_CONTROL,
    (_e: IpcMainInvokeEvent, conversationId: string, requestId?: string) => {
      // Signal the in-flight onWaitingForHuman promise to resolve.
      // requestId makes this run-scoped so a stale Return Control cannot resume a newer run.
      returnControl(conversationId, requestId);
    }
  );

  // ── Dev Process IPC ─────────────────────────────────────────────────────
  ipcMain.handle(
    DEV_PROCESS_IPC.LIST,
    (_e: IpcMainInvokeEvent, projectId?: string) => devProcessManager.listDevProcesses(projectId)
  );

  ipcMain.handle(
    DEV_PROCESS_IPC.READ_OUTPUT,
    (_e: IpcMainInvokeEvent, processId: string) => devProcessManager.readDevProcessOutput(processId)
  );

  ipcMain.handle(
    DEV_PROCESS_IPC.STOP,
    (_e: IpcMainInvokeEvent, processId: string) => devProcessManager.stopDevProcess(processId)
  );

  // ── Telemetry / Log IPC (V17) ─────────────────────────────────────────
  ipcMain.handle(
    TELEMETRY_IPC.GET_EVENTS,
    (_e: IpcMainInvokeEvent, opts: {
      minLevel?: string;
      category?: string;
      conversationId?: string;
      requestId?: string;
      agentRunId?: string;
      search?: string;
      limit?: number;
    } = {}) => forgeLogger.query(opts as Parameters<typeof forgeLogger.query>[0])
  );

  ipcMain.handle(
    TELEMETRY_IPC.CLEAR,
    () => { forgeLogger.clear(); }
  );

  // ── Dev Panel IPC (V17) ──────────────────────────────────────────────
  // Initialize dev-state accessors (wired here to avoid circular dep)
  initDevState({
    getActiveRuns: () => getActiveRunEntries(),
    getQueueSummary: () => getQueueSummary(),
    getBrowserSummary: () => browserManager.getBrowserDevSummary(),
    appVersion: app.getVersion(),
  });

  ipcMain.handle(
    DEV_PANEL_IPC.GET_SNAPSHOT,
    () => buildDevSnapshot()
  );

  ipcMain.handle(
    DEV_PANEL_IPC.GET_RUN_TIMELINE,
    (_e: IpcMainInvokeEvent, requestId: string) => getRunTimeline(requestId)
  );

  ipcMain.handle(
    DEV_PANEL_IPC.EXPORT_BUNDLE,
    () => buildDiagnosticBundle()
  );

  // ── Permission Center V1 ──────────────────────────────────────────────

  ipcMain.handle(
    PERMISSION_IPC.GET_STORE,
    () => permissionEngine.loadStore()
  );

  ipcMain.handle(
    PERMISSION_IPC.GET_CAPABILITIES,
    () => permissionEngine.getAllCapabilities()
  );

  ipcMain.handle(
    PERMISSION_IPC.GET_CHECKS,
    (_e: IpcMainInvokeEvent, limit?: number) => permissionEngine.getRecentChecks(limit)
  );

  ipcMain.handle(
    PERMISSION_IPC.GET_SESSION_GRANTS,
    () => permissionEngine.getSessionGrants()
  );

  ipcMain.handle(
    PERMISSION_IPC.SET_GLOBAL,
    (_e: IpcMainInvokeEvent, capabilityId: string, policy: import("../../shared/types.js").CapabilityPolicy) => {
      permissionEngine.setGlobalPolicy(capabilityId, policy);
    }
  );

  ipcMain.handle(
    PERMISSION_IPC.SET_PROJECT,
    (_e: IpcMainInvokeEvent, projectId: string, capabilityId: string, policy: import("../../shared/types.js").CapabilityPolicy) => {
      permissionEngine.setProjectPolicy(projectId, capabilityId, policy);
    }
  );

  ipcMain.handle(
    PERMISSION_IPC.CLEAR_PROJECT,
    (_e: IpcMainInvokeEvent, projectId: string, capabilityId: string) => {
      permissionEngine.clearProjectPolicy(projectId, capabilityId);
    }
  );

  ipcMain.handle(
    PERMISSION_IPC.SET_PRESET,
    (_e: IpcMainInvokeEvent, preset: "SAFE" | "ASK" | "FULL_ACCESS") => {
      permissionEngine.setPreset(preset);
    }
  );

  ipcMain.handle(
    PERMISSION_IPC.CLEAR_PRESET,
    () => permissionEngine.clearPreset()
  );

  ipcMain.handle(
    PERMISSION_IPC.RESET_GLOBAL,
    () => permissionEngine.resetGlobalPolicies()
  );

  ipcMain.handle(
    PERMISSION_IPC.RESET_PROJECT,
    (_e: IpcMainInvokeEvent, projectId: string) => {
      permissionEngine.resetProjectPolicies(projectId);
    }
  );

  ipcMain.handle(
    PERMISSION_IPC.GRANT_SESSION,
    (_e: IpcMainInvokeEvent, capabilityId: string, projectId?: string) => {
      permissionEngine.grantSession(capabilityId, projectId);
    }
  );

  ipcMain.handle(
    PERMISSION_IPC.REVOKE_SESSION,
    (_e: IpcMainInvokeEvent, capabilityId: string, projectId?: string) => {
      permissionEngine.revokeSession(capabilityId, projectId);
    }
  );

  ipcMain.handle(
    PERMISSION_IPC.APPROVAL_RESPOND,
    (_e: IpcMainInvokeEvent, response: import("../../shared/types.js").PermissionApprovalResponse) => {
      permissionEngine.respondToApproval(response);
    }
  );

  // ── Test-only: fake provider checkpoint control ──────────────────────
  // Only active when FORGE_TEST_PROVIDER=fake. Allows E2E tests to block
  // and unblock the fake provider at named checkpoints deterministically.
  if (isFakeProviderEnabled()) {
    ipcMain.handle(
      IPC.TEST_CHECKPOINT_RELEASE,
      (_e: IpcMainInvokeEvent, name: string) => {
        releaseCheckpoint(name);
      }
    );

    ipcMain.handle(
      IPC.TEST_CHECKPOINT_WAIT,
      (_e: IpcMainInvokeEvent, name: string) => waitForCheckpointBlocked(name)
    );
  }

  // ── Task / Plan Runtime V1 ─────────────────────────────────────────────

  // Register invariants
  registerTaskInvariants();

  // Wire task manager with DI
  taskManager.initTaskManager({
    sender: mainSender,
    secretGetter: (profileId: string) => services.secrets.get(profileId),
    getCfgForConv: (convId: string) => {
      const conv = db.getConversation(true, convId);
      if (!conv) return null;
      const profileId = conv.defaultAgentProfileId ?? db.getAppState(true).defaultAgentProfileId;
      if (!profileId) return null;
      const profile = db.getAgentProfile(true, profileId);
      if (!profile) return null;
      const apiKey = services.secrets.get(profileId);
      if (!apiKey) return null;
      const cfg: import("../../shared/types.js").AgentConfig = {
        id: profile.id,
        name: profile.name,
        endpoint: profile.endpoint,
        protocol: profile.protocol,
        model: profile.model,
        ...(profile.apiKeyHeader !== undefined ? { apiKeyHeader: profile.apiKeyHeader } : {}),
        ...(profile.timeoutMs !== undefined ? { timeoutMs: profile.timeoutMs } : {}),
        ...(profile.capabilities !== undefined ? { capabilities: profile.capabilities } : {}),
      };
      return { cfg, apiKey };
    },
    dispatchStep: async (task, step, plan, signal) => {
      return runTaskStep(task, step, plan, signal);
    },
  });

  // Startup reconciliation — mark any interrupted tasks as paused
  taskManager.reconcileInterruptedTasks();

  // Task IPC channels
  ipcMain.handle(
    TASK_IPC.GET_ACTIVE,
    (_e: IpcMainInvokeEvent, convId: string) => {
      return taskManager.getActiveTask(convId);
    }
  );

  ipcMain.handle(
    TASK_IPC.GET_TASK,
    (_e: IpcMainInvokeEvent, taskId: string) => {
      const task = db.getTask(true, taskId);
      if (!task) return null;
      const plan = db.getTaskPlan(true, taskId);
      return plan ? { task, plan } : null;
    }
  );

  ipcMain.handle(
    TASK_IPC.LIST_BY_CONV,
    (_e: IpcMainInvokeEvent, convId: string) => {
      return db.listTasksByConversation(true, convId);
    }
  );

  ipcMain.handle(
    TASK_IPC.PAUSE,
    (_e: IpcMainInvokeEvent, convId: string) => {
      return taskManager.pauseConvTask(convId);
    }
  );

  ipcMain.handle(
    TASK_IPC.RESUME,
    (_e: IpcMainInvokeEvent, taskId: string) => {
      return taskManager.resumeTask(taskId);
    }
  );

  ipcMain.handle(
    TASK_IPC.CANCEL,
    (_e: IpcMainInvokeEvent, taskId: string) => {
      return taskManager.cancelConvTask(taskId);
    }
  );

  ipcMain.handle(
    TASK_IPC.RETRY,
    (_e: IpcMainInvokeEvent, taskId: string) => {
      return taskManager.retryTask(taskId);
    }
  );

  ipcMain.handle(
    TASK_IPC.RETRY_STEP,
    (_e: IpcMainInvokeEvent, taskId: string, stepId: string) => {
      return taskManager.retryStep(taskId, stepId);
    }
  );

  ipcMain.handle(
    TASK_IPC.SKIP_STEP,
    (_e: IpcMainInvokeEvent, taskId: string, stepId: string) => {
      // Mark step as skipped
      const plan = db.getTaskPlan(true, taskId);
      if (!plan) return false;
      const step = plan.steps.find((s) => s.id === stepId);
      if (!step || (step.status !== "pending" && step.status !== "failed" && step.status !== "blocked")) return false;
      const updatedSteps = plan.steps.map((s) =>
        s.id === stepId ? { ...s, status: "skipped" as const, completedAt: Date.now() } : s
      );
      const updatedPlan: import("../../shared/types.js").ForgeTaskPlan = { ...plan, steps: updatedSteps, updatedAt: Date.now() };
      db.saveTaskPlan(true, updatedPlan);
      return true;
    }
  );
}
