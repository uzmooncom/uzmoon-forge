import { ipcMain, IpcMainInvokeEvent, WebContents, clipboard, dialog, shell } from "electron";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { IPC, PROJECT_FILE_IPC, EDIT_IPC, AGENT_TOOL_IPC } from "../../shared/types.js";
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
import { queueManager, cancelStream, getActiveStreamId, setSecretGetter, deleteOrphanedSnapshots, sweepOrphanedSnapshots } from "../queue/QueueManager.js";
void sweepOrphanedSnapshots; // imported for startup use — called from main.ts

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

  // Inject secret getter into QueueManager so it can resolve apiKey by profileId
  setSecretGetter((profileId: string) => secrets.get(profileId));

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

  /** Trigger index build (non-blocking from renderer perspective). */
  ipcMain.handle(
    PROJECT_FILE_IPC.PROJECT_INDEX_BUILD,
    (_e: IpcMainInvokeEvent, projectId: string) => {
      const project = db.getProject(database, projectId);
      if (!project) return;
      // Build is synchronous but fast enough for initial call
      projectFiles.buildIndex(projectId, project.workingDirectory);
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

      // Base content (the snapshot captured at request time — the truth for the diff)
      // baseSnapshotId is the ContextRef.id; we need the snapshotPath from that ref.
      // The snapshotPath is stored on the ContextRef which lives on the ChatMessage.
      // Retrieve it by scanning the conversation's message contextRefs.
      let baseContent: string | null = null;
      if (fe.baseSnapshotId) {
        // Find the snapshot path from the originating message's contextRefs
        const messages = db.getMessagesByConversation(database, proposal.conversationId);
        outer: for (const msg of messages) {
          for (const ref of (msg.contextRefs ?? [])) {
            if (ref.id === fe.baseSnapshotId) {
              baseContent = projectFiles.readSnapshot(ref.snapshotPath);
              break outer;
            }
          }
        }
      }

      if (baseContent === null) {
        return {
          ok: false,
          error: `Base snapshot not available for "${fe.relativePath}". The file must be added to context before this proposal can be reviewed.`,
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
}