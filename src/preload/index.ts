import { contextBridge, ipcRenderer } from "electron";
import { IPC, PROJECT_FILE_IPC, EDIT_IPC, AGENT_TOOL_IPC } from "../shared/types.js";
import type {
  AgentConfig,
  AgentProfile,
  AppState,
  ChatMessage,
  Conversation,
  Attachment,
  AttachmentInput,
  ConnectionTestResult,
  SendMessageRequest,
  SendMessageWithContextRequest,
  QueueItem,
  ConvQueueState,
  Project,
  DirectoryStatus,
  ProjectFileEntry,
  DirListResult,
  DirListError,
  FileReadResult,
  FileReadError,
  SnapshotResult,
  SnapshotError,
  FolderContextPreview,
  EditProposal,
  AppliedEdit,
  PreflightResult,
  RequestContextLedger,
  ToolActivityEntry,
  ForgeToolCall,
  ForgeToolResult,
} from "../shared/types.js";

type UnsubFn = () => void;

const forgeApi = {
  // ── App State ──────────────────────────────────────────────────────────
  getAppState: (): Promise<AppState> =>
    ipcRenderer.invoke(IPC.APP_STATE_GET),

  setAppState: (state: AppState): Promise<void> =>
    ipcRenderer.invoke(IPC.APP_STATE_SET, state),

  // ── Agent Profiles (multi-profile) ──────────────────────────────────────
  listProfiles: (): Promise<AgentProfile[]> =>
    ipcRenderer.invoke(IPC.PROFILE_LIST),

  getProfile: (id: string): Promise<AgentProfile | null> =>
    ipcRenderer.invoke(IPC.PROFILE_GET, id),

  saveProfile: (profile: AgentProfile): Promise<AgentProfile> =>
    ipcRenderer.invoke(IPC.PROFILE_SAVE, profile),

  deleteProfile: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PROFILE_DELETE, id),

  setDefaultProfile: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PROFILE_SET_DEFAULT, id),

  // ── Agent Config (legacy shim) ─────────────────────────────────────────
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

  // ── Projects ─────────────────────────────────────────────────────────────
  listProjects: (): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.PROJECT_LIST),

  getProject: (id: string): Promise<Project | null> =>
    ipcRenderer.invoke(IPC.PROJECT_GET, id),

  createProject: (data: {
    name: string;
    workingDirectory: string;
    defaultAgentProfileId?: string;
    description?: string;
  }): Promise<{ ok: true; project: Project } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.PROJECT_CREATE, data),

  updateProject: (
    id: string,
    patch: Partial<Omit<Project, "id" | "createdAt">>
  ): Promise<Project | null> =>
    ipcRenderer.invoke(IPC.PROJECT_UPDATE, id, patch),

  removeProject: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PROJECT_REMOVE, id),

  validateProjectDir: (id: string): Promise<DirectoryStatus> =>
    ipcRenderer.invoke(IPC.PROJECT_VALIDATE_DIR, id),

  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.PROJECT_PICK_DIR),

  revealProjectDir: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PROJECT_REVEAL_DIR, id),

  // ── Conversations ────────────────────────────────────────────────────────
  /**
   * scopeProjectId:
   *   undefined = all conversations (no scope filter)
   *   null      = global conversations only (no projectId)
   *   string    = conversations belonging to that project
   */
  listConversations: (includeArchived?: boolean, scopeProjectId?: string | null): Promise<Conversation[]> =>
    ipcRenderer.invoke(IPC.CONV_LIST, includeArchived ?? false, scopeProjectId),

  getConversation: (id: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC.CONV_GET, id),

  createConversation: (conv: Conversation): Promise<void> =>
    ipcRenderer.invoke(IPC.CONV_CREATE, conv),

  updateConversation: (
    id: string,
    patch: Partial<Pick<Conversation, "title" | "updatedAt" | "pinnedAt" | "archivedAt" | "defaultAgentProfileId">>
  ): Promise<void> => ipcRenderer.invoke(IPC.CONV_UPDATE, id, patch),

  deleteConversation: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CONV_DELETE, id),

  searchConversations: (query: string, scopeProjectId?: string | null): Promise<Conversation[]> =>
    ipcRenderer.invoke(IPC.CONV_SEARCH, query, scopeProjectId),

  exportConversation: (id: string): Promise<string> =>
    ipcRenderer.invoke(IPC.CONV_EXPORT, id),

  branchConversation: (sourceConvId: string, upToMessageId: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC.CONV_BRANCH, sourceConvId, upToMessageId),

  searchMessages: (query: string, scopeProjectId?: string | null): Promise<Array<{ message: ChatMessage; conversation: Conversation }>> =>
    ipcRenderer.invoke(IPC.MSG_SEARCH, query, scopeProjectId),

  getConversationMessages: (convId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IPC.CONV_MESSAGES, convId),

  // ── Attachments ──────────────────────────────────────────────────────────
  saveAttachment: (
    convId: string,
    input: AttachmentInput
  ): Promise<{ ok: true; attachment: Attachment } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.ATTACH_SAVE, convId, input),

  readAttachment: (
    id: string
  ): Promise<{ ok: true; data: string; mimeType: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.ATTACH_READ, id),

  deleteAttachment: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ATTACH_DELETE, id),

  // ── Project file system (V0.2) ──────────────────────────────────────────
  projectFiles: {
    /** List a single directory level inside the project. relativePath="" → root. */
    listDirectory: (
      projectId: string,
      relativePath: string
    ): Promise<DirListResult | DirListError> =>
      ipcRenderer.invoke(PROJECT_FILE_IPC.PROJECT_DIR_LIST, projectId, relativePath),

    /** Read file content (text only, eligibility-checked). */
    readFile: (
      projectId: string,
      relativePath: string,
      lineStart?: number,
      lineEnd?: number
    ): Promise<FileReadResult | FileReadError> =>
      ipcRenderer.invoke(PROJECT_FILE_IPC.PROJECT_FILE_READ, projectId, relativePath, lineStart, lineEnd),

    /** Capture a snapshot of a file/range for context injection. */
    captureSnapshot: (
      projectId: string,
      relativePath: string,
      lineStart?: number,
      lineEnd?: number
    ): Promise<SnapshotResult | SnapshotError> =>
      ipcRenderer.invoke(PROJECT_FILE_IPC.PROJECT_FILE_SNAPSHOT, projectId, relativePath, lineStart, lineEnd),

    /** Search project files by name/path. */
    searchFiles: (
      projectId: string,
      query: string,
      limit?: number
    ): Promise<ProjectFileEntry[]> =>
      ipcRenderer.invoke(PROJECT_FILE_IPC.PROJECT_FILE_SEARCH, projectId, query, limit),

    /** Get index build status. */
    getIndexStatus: (
      projectId: string
    ): Promise<{ state: "idle" | "indexing" | "ready" | "error"; fileCount?: number; lastIndexedAt?: number; error?: string }> =>
      ipcRenderer.invoke(PROJECT_FILE_IPC.PROJECT_INDEX_STATUS, projectId),

    /** Trigger index build (fire and forget). */
    buildIndex: (projectId: string): Promise<void> =>
      ipcRenderer.invoke(PROJECT_FILE_IPC.PROJECT_INDEX_BUILD, projectId),

    /** Read a previously captured snapshot (for history display). */
    readSnapshot: (snapshotPath: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(PROJECT_FILE_IPC.PROJECT_SNAPSHOT_READ, snapshotPath),

    /** Preview what files would be included if a folder is added as context. */
    folderContextPreview: (
      projectId: string,
      relativePath: string
    ): Promise<FolderContextPreview | { ok: false; error: string }> =>
      ipcRenderer.invoke(PROJECT_FILE_IPC.PROJECT_FOLDER_CONTEXT_PREVIEW, projectId, relativePath),
  },

  // ── Chat (enqueue) ──────────────────────────────────────────────────────
  sendMessage: (
    req: (SendMessageRequest | SendMessageWithContextRequest) & { targetAgentProfileId?: string }
  ): Promise<{
    queueItemId?: string;
    userMessage?: ChatMessage;
    conversation?: Conversation;
    error?: string;
  }> => ipcRenderer.invoke(IPC.CHAT_SEND, req),

  /** Cancel the active stream for a conversation (stops processing, pauses queue) */
  cancelStream: (convId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_CANCEL, convId),

  // ── Queue management ─────────────────────────────────────────────────────
  getQueue: (convId: string): Promise<{ items: QueueItem[]; paused: boolean }> =>
    ipcRenderer.invoke(IPC.QUEUE_GET, convId),

  editQueueItem: (convId: string, itemId: string, content: string, attachmentIds?: string[]): Promise<boolean> =>
    ipcRenderer.invoke(IPC.QUEUE_EDIT, convId, itemId, content, attachmentIds),

  removeQueueItem: (convId: string, itemId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.QUEUE_REMOVE, convId, itemId),

  reorderQueue: (convId: string, orderedIds: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.QUEUE_REORDER, convId, orderedIds),

  resumeQueue: (convId: string, action?: "retry" | "skip", itemId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.QUEUE_RESUME, convId, action, itemId),

  clearQueue: (convId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.QUEUE_CLEAR, convId),

  // ── Stream events ────────────────────────────────────────────────────────
  onStreamStart: (
    cb: (data: {
      streamId: string;
      userMessage?: ChatMessage;
      conversation?: Conversation;
      queueItemId?: string;
      agentProfileId?: string;
      agentNameSnapshot?: string;
      modelSnapshot?: string;
    }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string;
        userMessage?: ChatMessage;
        conversation?: Conversation;
        queueItemId?: string;
        agentProfileId?: string;
        agentNameSnapshot?: string;
        modelSnapshot?: string;
      }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_START, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_START, listener);
  },

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
      conversation?: Conversation;
      queueItemId?: string;
    }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string;
        message?: ChatMessage;
        cancelled?: boolean;
        conversation?: Conversation;
        queueItemId?: string;
      }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_END, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_END, listener);
  },

  onStreamError: (
    cb: (data: { streamId: string; message: ChatMessage; queueItemId?: string }) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; message: ChatMessage; queueItemId?: string }
    ) => cb(data);
    ipcRenderer.on(IPC.CHAT_STREAM_ERROR, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_ERROR, listener);
  },

  /** Queue state push from main (paused, items changed) */
  onQueueState: (
    cb: (state: ConvQueueState) => void
  ): UnsubFn => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: ConvQueueState
    ) => cb(state);
    ipcRenderer.on(IPC.QUEUE_STATE, listener);
    return () => ipcRenderer.removeListener(IPC.QUEUE_STATE, listener);
  },

  // ── Safe File Editing (V0.3) ──────────────────────────────────────────────
  fileEditing: {
    getProposal: (proposalId: string): Promise<EditProposal | null> =>
      ipcRenderer.invoke(EDIT_IPC.PROPOSAL_GET, proposalId),

    listProposals: (conversationId: string): Promise<EditProposal[]> =>
      ipcRenderer.invoke(EDIT_IPC.PROPOSAL_LIST, conversationId),

    rejectProposal: (proposalId: string, fileEditIds?: string[]): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(EDIT_IPC.PROPOSAL_REJECT, proposalId, fileEditIds),

    readProposalTarget: (
      proposalId: string,
      fileEditId: string
    ): Promise<
      | { ok: true; proposedContent: string; baseContent: string }
      | { ok: false; error: string }
    > => ipcRenderer.invoke(EDIT_IPC.PROPOSAL_READ_TARGET, proposalId, fileEditId),

    preflightCheck: (proposalId: string, selectedFileEditIds: string[]): Promise<PreflightResult[]> =>
      ipcRenderer.invoke(EDIT_IPC.PREFLIGHT_CHECK, proposalId, selectedFileEditIds),

    applySelected: (
      proposalId: string,
      selectedFileEditIds: string[]
    ): Promise<{ ok: boolean; appliedEditIds?: string[]; preflightFailures?: PreflightResult[]; error?: string }> =>
      ipcRenderer.invoke(EDIT_IPC.APPLY_SELECTED, proposalId, selectedFileEditIds),

    undoApply: (appliedEditId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(EDIT_IPC.UNDO_APPLY, appliedEditId),

    listEditHistory: (projectId: string): Promise<AppliedEdit[]> =>
      ipcRenderer.invoke(EDIT_IPC.EDIT_HISTORY_LIST, projectId),

    onProposalUpdate: (cb: (proposal: EditProposal) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, proposal: EditProposal) => cb(proposal);
      ipcRenderer.on(EDIT_IPC.PROPOSAL_UPDATE, listener);
      return () => ipcRenderer.removeListener(EDIT_IPC.PROPOSAL_UPDATE, listener);
    },
  },

  // ── Clipboard ──────────────────────────────────────────────────────────────
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke("clipboard:write", text),

  // ── Legacy ────────────────────────────────────────────────────────────────
  getHistory: (): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IPC.CONV_MESSAGES, ""),

  clearHistory: (): Promise<void> =>
    ipcRenderer.invoke(IPC.CONV_UPDATE, "", {}),

  // ── Agent Tool Activity (V0.4) ────────────────────────────────────────────
  agentTools: {
    getLedger: (requestId: string): Promise<RequestContextLedger | null> =>
      ipcRenderer.invoke(AGENT_TOOL_IPC.LEDGER_GET, requestId),

    getToolActivity: (conversationId: string): Promise<ToolActivityEntry[]> =>
      ipcRenderer.invoke(AGENT_TOOL_IPC.TOOL_ACTIVITY_GET, conversationId),

    onToolStart: (cb: (payload: { streamId: string; requestId: string; call: ForgeToolCall }) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { streamId: string; requestId: string; call: ForgeToolCall }) => cb(payload);
      ipcRenderer.on(IPC.CHAT_STREAM_TOOL_START, listener);
      return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_TOOL_START, listener);
    },

    onToolEnd: (cb: (payload: { streamId: string; requestId: string; call: ForgeToolCall; result: ForgeToolResult; durationMs: number }) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { streamId: string; requestId: string; call: ForgeToolCall; result: ForgeToolResult; durationMs: number }) => cb(payload);
      ipcRenderer.on(IPC.CHAT_STREAM_TOOL_END, listener);
      return () => ipcRenderer.removeListener(IPC.CHAT_STREAM_TOOL_END, listener);
    },
  },
};

contextBridge.exposeInMainWorld("forgeApi", forgeApi);

export type ForgeApi = typeof forgeApi;