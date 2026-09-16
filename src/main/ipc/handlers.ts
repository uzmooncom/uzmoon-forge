import { ipcMain, IpcMainInvokeEvent, WebContents, clipboard, dialog, shell } from "electron";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { IPC, PROJECT_FILE_IPC } from "../../shared/types.js";
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
import * as projectFiles from "../project-files/service.js";
import type { SecretStore } from "../secret-store/secrets.js";
import * as db from "../database/db.js";
import { testConnection } from "../agent-client/client.js";
import { queueManager, cancelStream, getActiveStreamId, setSecretGetter } from "../queue/QueueManager.js";

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

      for (const staged of stagedRefs) {
        const stagedProject = db.getProject(database, staged.projectId);
        if (!stagedProject) continue;
        const result = projectFiles.captureSnapshot(
          stagedProject.workingDirectory,
          staged.relativePath,
          staged.lineStart,
          staged.lineEnd
        );
        if (result.ok) {
          const ref = { ...result.ref, projectId: staged.projectId };
          capturedContextRefs.push(ref);
          if (process.env["NODE_ENV"] === "development") {
            // eslint-disable-next-line no-console
            console.log(
              `[context:capture] resource=${ref.id} project=${staged.projectId}` +
              ` path=${staged.relativePath} sha256=${ref.contentHash.slice(0, 8)} bytes=${ref.size}`
            );
          }
        } else if (process.env["NODE_ENV"] === "development") {
          // eslint-disable-next-line no-console
          console.warn(
            `[context:capture-FAIL] project=${staged.projectId} path=${staged.relativePath} error=${result.error}`
          );
        }
      }

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
      const result = projectFiles.captureSnapshot(
        project.workingDirectory, relativePath, lineStart, lineEnd
      );
      if (result.ok) {
        return { ...result, ref: { ...result.ref, projectId } };
      }
      return result;
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
}