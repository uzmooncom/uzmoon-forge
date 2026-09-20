import { contextBridge, ipcRenderer } from "electron";
import { IPC, PROJECT_FILE_IPC, EDIT_IPC, AGENT_TOOL_IPC, RELIABILITY_IPC, SETTINGS_IPC, COMMAND_IPC, BROWSER_IPC, DEV_PROCESS_IPC, TELEMETRY_IPC, DEV_PANEL_IPC, PERMISSION_IPC, TASK_IPC } from "../shared/types.js";
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
  ConvRuntimeState,
  ForgeIncident,
  CommandExecution,
  CommandTrustRule,
  CommandOutputPage,
  BrowserProfile,
  BrowserSession,
  BrowserTab,
  BrowserRuntimeState,
  BrowserAgentControl,
  BrowserPendingApproval,
  BrowserBookmark,
  BrowserHistoryEntry,
  BrowserStatusSnapshot,
  DevProcessRecord,
  CapabilityPolicy,
  CapabilityDef,
  PermissionApprovalRequest,
  PermissionApprovalResponse,
  CapabilityPolicyStore,
  PermissionCheckRecord,
  ForgeTask,
  ForgeTaskPlan,
  ForgeTaskStep,
  TaskRuntimeSnapshot,
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

  // ── Runtime state (authoritative active-run query) ──────────────────────
  /** Returns live AgentRun state for convId, or null if idle. */
  getRuntimeState: (convId: string): Promise<ConvRuntimeState | null> =>
    ipcRenderer.invoke(IPC.RUNTIME_STATE_GET, convId),

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

  // ── App Settings (V0.9 addendum) ──────────────────────────────────────────
  settings: {
    getSettings: (): Promise<import("../shared/types.js").AppSettings> =>
      ipcRenderer.invoke(SETTINGS_IPC.GET),
    setSettings: (patch: Partial<import("../shared/types.js").AppSettings>): Promise<import("../shared/types.js").AppSettings> =>
      ipcRenderer.invoke(SETTINGS_IPC.SET, patch),
  },

  // ── Safe Terminal V1 — Commands ─────────────────────────────────────────
  commands: {
    /** List commands, optionally filtered by project and/or conversation */
    list: (projectId?: string, conversationId?: string): Promise<CommandExecution[]> =>
      ipcRenderer.invoke(COMMAND_IPC.LIST, projectId, conversationId),

    /** Get a single command by ID */
    get: (commandId: string): Promise<CommandExecution | null> =>
      ipcRenderer.invoke(COMMAND_IPC.GET, commandId),

    /** User-initiated command run (project mode only) */
    runUser: (opts: {
      projectId: string;
      projectRoot: string;
      executable: string;
      args: string[];
      cwdRelative: string;
      conversationId?: string;
    }): Promise<CommandExecution> =>
      ipcRenderer.invoke(COMMAND_IPC.RUN_USER, opts),

    /** Approve a command awaiting user decision */
    approve: (commandId: string, mode: "once" | "trust"): Promise<CommandExecution | null> =>
      ipcRenderer.invoke(COMMAND_IPC.APPROVE, commandId, mode),

    /** Reject a command awaiting user decision */
    reject: (commandId: string): Promise<CommandExecution | null> =>
      ipcRenderer.invoke(COMMAND_IPC.REJECT, commandId),

    /** Cancel an active command */
    cancel: (commandId: string): Promise<CommandExecution | null> =>
      ipcRenderer.invoke(COMMAND_IPC.CANCEL, commandId),

    /** Read paged output for a command */
    readOutput: (commandId: string, offsetBytes?: number, limitBytes?: number): Promise<CommandOutputPage> =>
      ipcRenderer.invoke(COMMAND_IPC.READ_OUTPUT, commandId, offsetBytes, limitBytes),

    /** List trust rules for a project */
    listTrust: (projectId: string): Promise<CommandTrustRule[]> =>
      ipcRenderer.invoke(COMMAND_IPC.LIST_TRUST, projectId),

    /** Revoke a trust rule */
    revokeTrust: (ruleId: string): Promise<void> =>
      ipcRenderer.invoke(COMMAND_IPC.REVOKE_TRUST, ruleId),

    /** Subscribe to command state changes (all commands, all projects) */
    onStateChange: (cb: (cmd: CommandExecution) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, cmd: CommandExecution) => cb(cmd);
      ipcRenderer.on(COMMAND_IPC.STATE_CHANGE, listener);
      return () => ipcRenderer.removeListener(COMMAND_IPC.STATE_CHANGE, listener);
    },

    /** Subscribe to incremental output chunks */
    onOutputChunk: (cb: (payload: { commandId: string; kind: "stdout" | "stderr"; text: string }) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { commandId: string; kind: "stdout" | "stderr"; text: string }) => cb(payload);
      ipcRenderer.on(COMMAND_IPC.OUTPUT_CHUNK, listener);
      return () => ipcRenderer.removeListener(COMMAND_IPC.OUTPUT_CHUNK, listener);
    },

    /** Subscribe to command completion (final state) */
    onComplete: (cb: (payload: { commandId: string; record: CommandExecution }) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { commandId: string; record: CommandExecution }) => cb(payload);
      ipcRenderer.on(COMMAND_IPC.COMPLETE, listener);
      return () => ipcRenderer.removeListener(COMMAND_IPC.COMPLETE, listener);
    },
  },

  // ── Browser Runtime V1 ──────────────────────────────────────────────────
  browser: {
    // Profile management
    listProfiles: (): Promise<BrowserProfile[]> =>
      ipcRenderer.invoke(BROWSER_IPC.LIST_PROFILES),

    createProfile: (opts: { name: string; persistenceMode: "persistent" | "private"; agentAccessPolicy?: "off" | "ask" | "allowed" }): Promise<BrowserProfile> =>
      ipcRenderer.invoke(BROWSER_IPC.CREATE_PROFILE, opts),

    updateProfile: (id: string, patch: { name?: string; agentAccessPolicy?: "off" | "ask" | "allowed"; isDefault?: boolean }): Promise<BrowserProfile | null> =>
      ipcRenderer.invoke(BROWSER_IPC.UPDATE_PROFILE, id, patch),

    deleteProfile: (id: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.DELETE_PROFILE, id),

    // Session management
    listSessions: (profileId?: string): Promise<BrowserSession[]> =>
      ipcRenderer.invoke(BROWSER_IPC.LIST_SESSIONS, profileId),

    createSession: (profileId: string, opts?: { name?: string }): Promise<BrowserSession> =>
      ipcRenderer.invoke(BROWSER_IPC.CREATE_SESSION, profileId, opts),

    closeSession: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.CLOSE_SESSION, sessionId),

    activateSession: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.ACTIVATE_SESSION, sessionId),

    // Tab management
    listTabs: (sessionId: string): Promise<BrowserTab[]> =>
      ipcRenderer.invoke(BROWSER_IPC.LIST_TABS, sessionId),

    newTab: (sessionId: string, url?: string): Promise<BrowserTab> =>
      ipcRenderer.invoke(BROWSER_IPC.NEW_TAB, sessionId, url),

    closeTab: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.CLOSE_TAB, tabId),

    activateTab: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.ACTIVATE_TAB, tabId),

    // Navigation
    navigate: (tabId: string, url: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.NAVIGATE, tabId, url),

    back: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.NAVIGATE_BACK, tabId),

    forward: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.NAVIGATE_FORWARD, tabId),

    reload: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.RELOAD, tabId),

    stop: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.STOP, tabId),

    // View positioning
    resizeView: (rect: { x: number; y: number; width: number; height: number }): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.RESIZE_VIEW, rect),

    hideView: (): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.HIDE_VIEW),

    showView: (tabId?: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.SHOW_VIEW, tabId),

    // Agent access control
    grantAgentAccess: (control: BrowserAgentControl): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.GRANT_AGENT_ACCESS, control),

    revokeAgentAccess: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.REVOKE_AGENT_ACCESS, sessionId),

    userTakeControl: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.USER_TAKE_CONTROL, sessionId),

    returnToAgent: (): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.RETURN_TO_AGENT),

    // Approval resolution
    approveAction: (approvalId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.APPROVE_ACTION, approvalId),

    rejectAction: (approvalId: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.REJECT_ACTION, approvalId),

    // Runtime state
    getRuntimeState: (): Promise<BrowserRuntimeState> =>
      ipcRenderer.invoke(BROWSER_IPC.GET_RUNTIME_STATE),

    // Push subscriptions
    onTabUpdated: (cb: (tab: BrowserTab) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, tab: BrowserTab) => cb(tab);
      ipcRenderer.on(BROWSER_IPC.TAB_UPDATED, listener);
      return () => ipcRenderer.removeListener(BROWSER_IPC.TAB_UPDATED, listener);
    },

    onSessionUpdated: (cb: (session: BrowserSession) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, session: BrowserSession) => cb(session);
      ipcRenderer.on(BROWSER_IPC.SESSION_UPDATED, listener);
      return () => ipcRenderer.removeListener(BROWSER_IPC.SESSION_UPDATED, listener);
    },

    onRuntimeStatePush: (cb: (state: BrowserRuntimeState) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, state: BrowserRuntimeState) => cb(state);
      ipcRenderer.on(BROWSER_IPC.RUNTIME_STATE_PUSH, listener);
      return () => ipcRenderer.removeListener(BROWSER_IPC.RUNTIME_STATE_PUSH, listener);
    },

    onApprovalRequested: (cb: (approval: BrowserPendingApproval) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, approval: BrowserPendingApproval) => cb(approval);
      ipcRenderer.on(BROWSER_IPC.APPROVAL_REQUESTED, listener);
      return () => ipcRenderer.removeListener(BROWSER_IPC.APPROVAL_REQUESTED, listener);
    },

    onAgentControlChanged: (cb: (control: BrowserAgentControl | null) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, control: BrowserAgentControl | null) => cb(control);
      ipcRenderer.on(BROWSER_IPC.AGENT_CONTROL_CHANGED, listener);
      return () => ipcRenderer.removeListener(BROWSER_IPC.AGENT_CONTROL_CHANGED, listener);
    },

    onRequestShowBrowser: (cb: (payload: { sessionId?: string; tabId?: string }) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId?: string; tabId?: string }) => cb(payload);
      ipcRenderer.on(BROWSER_IPC.REQUEST_SHOW_BROWSER, listener);
      return () => ipcRenderer.removeListener(BROWSER_IPC.REQUEST_SHOW_BROWSER, listener);
    },

    /** Open the standalone Forge Browser window (or focus it if already open) */
    openBrowserWindow: (): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.OPEN_WINDOW),

    /** Focus the standalone Forge Browser window (no-op if not open) */
    focusBrowserWindow: (): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.FOCUS_WINDOW),

    /** Get browser window status snapshot (no agent control required) */
    getStatus: (): Promise<BrowserStatusSnapshot> =>
      ipcRenderer.invoke(BROWSER_IPC.BROWSER_STATUS),

    // Bookmarks
    listBookmarks: (profileId?: string): Promise<BrowserBookmark[]> =>
      ipcRenderer.invoke(BROWSER_IPC.BOOKMARK_LIST, profileId),

    addBookmark: (opts: { profileId: string; url: string; title: string; favicon?: string }): Promise<BrowserBookmark> =>
      ipcRenderer.invoke(BROWSER_IPC.BOOKMARK_ADD, opts),

    removeBookmark: (id: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.BOOKMARK_REMOVE, id),

    updateBookmark: (id: string, patch: { title?: string }): Promise<BrowserBookmark | null> =>
      ipcRenderer.invoke(BROWSER_IPC.BOOKMARK_UPDATE, id, patch),

    // History
    listHistory: (profileId?: string, limit?: number): Promise<BrowserHistoryEntry[]> =>
      ipcRenderer.invoke(BROWSER_IPC.HISTORY_LIST, profileId, limit),

    clearHistory: (profileId?: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.HISTORY_CLEAR, profileId),

    onWaitingForHuman: (cb: (payload: { conversationId: string; streamId: string; requestId: string }) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { conversationId: string; streamId: string; requestId: string }) => cb(payload);
      ipcRenderer.on(BROWSER_IPC.WAITING_FOR_HUMAN, listener);
      return () => ipcRenderer.removeListener(BROWSER_IPC.WAITING_FOR_HUMAN, listener);
    },

    returnBrowserControl: (conversationId: string, requestId?: string): Promise<void> =>
      ipcRenderer.invoke(BROWSER_IPC.RETURN_CONTROL, conversationId, requestId),
  },

  // ── Reliability (V0.9) ────────────────────────────────────────────────────
  reliability: {
    listIncidents: (): Promise<ForgeIncident[]> =>
      ipcRenderer.invoke(RELIABILITY_IPC.INCIDENTS_LIST),

    getIncident: (id: string): Promise<ForgeIncident | undefined> =>
      ipcRenderer.invoke(RELIABILITY_IPC.INCIDENT_GET, id),

    getSharePayload: (id: string): Promise<Record<string, unknown> | null> =>
      ipcRenderer.invoke(RELIABILITY_IPC.INCIDENT_SHARE_PAYLOAD, id),

    clearIncidents: (): Promise<void> =>
      ipcRenderer.invoke(RELIABILITY_IPC.INCIDENTS_CLEAR),

    getMetrics: (): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke(RELIABILITY_IPC.METRICS_GET),

    onIncidentRecorded: (cb: (incident: ForgeIncident) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, inc: ForgeIncident) => cb(inc);
      ipcRenderer.on(RELIABILITY_IPC.INCIDENT_RECORDED, listener);
      return () => ipcRenderer.removeListener(RELIABILITY_IPC.INCIDENT_RECORDED, listener);
    },
  },

  // ── Dev Process (Browser Runtime V1.1) ────────────────────────────────────
  devProcess: {
    list: (projectId?: string): Promise<DevProcessRecord[]> =>
      ipcRenderer.invoke(DEV_PROCESS_IPC.LIST, projectId),

    readOutput: (processId: string): Promise<{ found: boolean; output: string }> =>
      ipcRenderer.invoke(DEV_PROCESS_IPC.READ_OUTPUT, processId),

    stop: (processId: string): Promise<{ found: boolean }> =>
      ipcRenderer.invoke(DEV_PROCESS_IPC.STOP, processId),

    onStateChanged: (cb: (record: DevProcessRecord) => void): UnsubFn => {
      const listener = (_event: Electron.IpcRendererEvent, record: DevProcessRecord) => cb(record);
      ipcRenderer.on(DEV_PROCESS_IPC.STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(DEV_PROCESS_IPC.STATE_CHANGED, listener);
    },
  },

  // ── Telemetry / Log API (V17) ─────────────────────────────────────────
  telemetry: {
    getEvents: (opts: {
      minLevel?: string;
      category?: string;
      conversationId?: string;
      requestId?: string;
      agentRunId?: string;
      search?: string;
      limit?: number;
    } = {}): Promise<unknown[]> =>
      ipcRenderer.invoke(TELEMETRY_IPC.GET_EVENTS, opts),
    clear: (): Promise<void> =>
      ipcRenderer.invoke(TELEMETRY_IPC.CLEAR),
  },

  // ── Test-only: fake provider checkpoint control ──────────────────────
  // Only registered when FORGE_TEST_PROVIDER=fake (handlers guard themselves).
  // Calling these in non-test mode results in an IPC "no handler" rejection.
  test: {
    releaseCheckpoint: (name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.TEST_CHECKPOINT_RELEASE, name),
    waitForCheckpointBlocked: (name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.TEST_CHECKPOINT_WAIT, name),
  },

  // ── Dev Panel API (V17) ──────────────────────────────────────────────
  devPanel: {
    getSnapshot: (): Promise<unknown> =>
      ipcRenderer.invoke(DEV_PANEL_IPC.GET_SNAPSHOT),
    getRunTimeline: (requestId: string): Promise<unknown> =>
      ipcRenderer.invoke(DEV_PANEL_IPC.GET_RUN_TIMELINE, requestId),
    exportBundle: (): Promise<unknown> =>
      ipcRenderer.invoke(DEV_PANEL_IPC.EXPORT_BUNDLE),
    onSnapshotUpdated: (cb: () => void): UnsubFn => {
      const listener = () => cb();
      ipcRenderer.on(DEV_PANEL_IPC.SNAPSHOT_UPDATED, listener);
      return () => ipcRenderer.removeListener(DEV_PANEL_IPC.SNAPSHOT_UPDATED, listener);
    },
  },

  permissions: {
    getStore: (): Promise<CapabilityPolicyStore> =>
      ipcRenderer.invoke(PERMISSION_IPC.GET_STORE),
    getCapabilities: (): Promise<CapabilityDef[]> =>
      ipcRenderer.invoke(PERMISSION_IPC.GET_CAPABILITIES),
    getChecks: (limit?: number): Promise<PermissionCheckRecord[]> =>
      ipcRenderer.invoke(PERMISSION_IPC.GET_CHECKS, limit),
    getSessionGrants: (): Promise<Record<string, string[]>> =>
      ipcRenderer.invoke(PERMISSION_IPC.GET_SESSION_GRANTS),
    setGlobal: (capabilityId: string, policy: CapabilityPolicy): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.SET_GLOBAL, capabilityId, policy),
    setProject: (projectId: string, capabilityId: string, policy: CapabilityPolicy): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.SET_PROJECT, projectId, capabilityId, policy),
    clearProject: (projectId: string, capabilityId: string): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.CLEAR_PROJECT, projectId, capabilityId),
    setPreset: (preset: "SAFE" | "ASK" | "FULL_ACCESS"): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.SET_PRESET, preset),
    clearPreset: (): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.CLEAR_PRESET),
    resetGlobal: (): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.RESET_GLOBAL),
    resetProject: (projectId: string): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.RESET_PROJECT, projectId),
    grantSession: (capabilityId: string, projectId?: string): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.GRANT_SESSION, capabilityId, projectId),
    revokeSession: (capabilityId: string, projectId?: string): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.REVOKE_SESSION, capabilityId, projectId),
    /** Respond to a pending permission approval request */
    approvalRespond: (response: PermissionApprovalResponse): Promise<void> =>
      ipcRenderer.invoke(PERMISSION_IPC.APPROVAL_RESPOND, response),
    /** Subscribe to incoming permission approval requests from the main process */
    onApprovalRequest: (cb: (req: PermissionApprovalRequest) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: PermissionApprovalRequest) => cb(req);
      ipcRenderer.on(PERMISSION_IPC.APPROVAL_REQUEST, listener);
      return () => ipcRenderer.off(PERMISSION_IPC.APPROVAL_REQUEST, listener);
    },
    /** Subscribe to approval cancellation events (e.g. Stop button pressed) */
    onApprovalCancelled: (cb: (approvalId: string) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { approvalId: string }) => cb(payload.approvalId);
      ipcRenderer.on(PERMISSION_IPC.APPROVAL_CANCELLED, listener);
      return () => ipcRenderer.off(PERMISSION_IPC.APPROVAL_CANCELLED, listener);
    },
  },

  // ── Task / Plan Runtime V1 ────────────────────────────────────────────────
  tasks: {
    /** Get the active task snapshot for a conversation (null if none) */
    getActive: (convId: string): Promise<TaskRuntimeSnapshot | null> =>
      ipcRenderer.invoke(TASK_IPC.GET_ACTIVE, convId),

    /** Get a specific task + plan by task ID */
    getTask: (taskId: string): Promise<{ task: ForgeTask; plan: ForgeTaskPlan } | null> =>
      ipcRenderer.invoke(TASK_IPC.GET_TASK, taskId),

    /** List all tasks for a conversation */
    listByConv: (convId: string): Promise<ForgeTask[]> =>
      ipcRenderer.invoke(TASK_IPC.LIST_BY_CONV, convId),

    /** Pause the active task in a conversation */
    pause: (convId: string): Promise<void> =>
      ipcRenderer.invoke(TASK_IPC.PAUSE, convId),

    /** Resume a paused task */
    resume: (taskId: string): Promise<void> =>
      ipcRenderer.invoke(TASK_IPC.RESUME, taskId),

    /** Cancel a task */
    cancel: (taskId: string): Promise<void> =>
      ipcRenderer.invoke(TASK_IPC.CANCEL, taskId),

    /** Retry a failed/cancelled task from the beginning */
    retry: (taskId: string): Promise<void> =>
      ipcRenderer.invoke(TASK_IPC.RETRY, taskId),

    /** Retry a specific failed step */
    retryStep: (taskId: string, stepId: string): Promise<void> =>
      ipcRenderer.invoke(TASK_IPC.RETRY_STEP, taskId, stepId),

    /** Skip a specific step (mark as skipped, advance plan) */
    skipStep: (taskId: string, stepId: string): Promise<boolean> =>
      ipcRenderer.invoke(TASK_IPC.SKIP_STEP, taskId, stepId),

    /** Subscribe to task created events */
    onTaskCreated: (cb: (snapshot: TaskRuntimeSnapshot) => void): UnsubFn => {
      const listener = (_e: Electron.IpcRendererEvent, snapshot: TaskRuntimeSnapshot) => cb(snapshot);
      ipcRenderer.on(TASK_IPC.TASK_CREATED, listener);
      return () => ipcRenderer.removeListener(TASK_IPC.TASK_CREATED, listener);
    },

    /** Subscribe to task updated events */
    onTaskUpdated: (cb: (snapshot: TaskRuntimeSnapshot) => void): UnsubFn => {
      const listener = (_e: Electron.IpcRendererEvent, snapshot: TaskRuntimeSnapshot) => cb(snapshot);
      ipcRenderer.on(TASK_IPC.TASK_UPDATED, listener);
      return () => ipcRenderer.removeListener(TASK_IPC.TASK_UPDATED, listener);
    },

    /** Subscribe to task terminal events */
    onTaskTerminal: (cb: (snapshot: TaskRuntimeSnapshot) => void): UnsubFn => {
      const listener = (_e: Electron.IpcRendererEvent, snapshot: TaskRuntimeSnapshot) => cb(snapshot);
      ipcRenderer.on(TASK_IPC.TASK_TERMINAL, listener);
      return () => ipcRenderer.removeListener(TASK_IPC.TASK_TERMINAL, listener);
    },

    /** Subscribe to task replanned events */
    onTaskReplanned: (cb: (snapshot: TaskRuntimeSnapshot) => void): UnsubFn => {
      const listener = (_e: Electron.IpcRendererEvent, snapshot: TaskRuntimeSnapshot) => cb(snapshot);
      ipcRenderer.on(TASK_IPC.TASK_REPLANNED, listener);
      return () => ipcRenderer.removeListener(TASK_IPC.TASK_REPLANNED, listener);
    },

    /** Subscribe to step updated events */
    onStepUpdated: (
      cb: (payload: { taskId: string; step: ForgeTaskStep; snapshot: TaskRuntimeSnapshot }) => void
    ): UnsubFn => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: { taskId: string; step: ForgeTaskStep; snapshot: TaskRuntimeSnapshot }
      ) => cb(payload);
      ipcRenderer.on(TASK_IPC.STEP_UPDATED, listener);
      return () => ipcRenderer.removeListener(TASK_IPC.STEP_UPDATED, listener);
    },
  },
};

contextBridge.exposeInMainWorld("forgeApi", forgeApi);

export type ForgeApi = typeof forgeApi;