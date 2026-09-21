/**
 * Pure-JS file-based store — no native modules required.
 * Data is persisted as JSON files in the dataDir.
 */
import path from "path";
import fs from "fs";
import type {
  ChatMessage,
  AgentConfig,
  AgentProfile,
  AppState,
  AppSettings,
  Conversation,
  Attachment,
  QueueItem,
  Project,
  EditProposal,
  AppliedEdit,
  WriteJournalEntry,
  RequestContextLedger,
  CommandExecution,
  CommandState,
  CommandTrustRule,
  CommandOutputMetadata,
  ForgeFailureCode,
  BrowserProfile,
  BrowserSession,
  BrowserTab,
  BrowserBookmark,
  BrowserHistoryEntry,
  ForgeTask,
  ForgeTaskPlan,
  TaskStatus,
} from "../../shared/types.js";
import { DEFAULT_APP_SETTINGS } from "../../shared/types.js";
import type {
  AgentInstance,
  AgentWorkItem,
  SubtaskProposal,
  ReviewResult,
  AssignmentHistoryEntry,
} from "../tasks/multi-agent/ma-types.js";

// ── Store shape ────────────────────────────────────────────────────────────

interface ConvQueue {
  items: QueueItem[];
  paused: boolean;
}

interface Store {
  appState: AppState;
  /** @deprecated kept only so migration can read it once */
  agentConfig: AgentConfig | null;
  /** Canonical multi-profile store keyed by profile id */
  agentProfiles: Record<string, AgentProfile>;
  /** Projects keyed by id */
  projects: Record<string, Project>;
  /** Legacy flat messages (migrated to conversations on first load) */
  messages?: ChatMessage[];
  conversations: Conversation[];
  /** Messages keyed by conversationId */
  messagesByConv: Record<string, ChatMessage[]>;
  /** Attachment metadata keyed by id */
  attachments: Record<string, Attachment>;
  /** Per-conversation message queues */
  queues: Record<string, ConvQueue>;
  // ── V0.3: Safe File Editing ────────────────────────────────────────────
  /** EditProposals keyed by proposal id */
  proposals: Record<string, EditProposal>;
  /** AppliedEdits keyed by appliedEdit id */
  editHistory: Record<string, AppliedEdit>;
  /** In-flight write journal entries keyed by entry id */
  writeJournal: Record<string, WriteJournalEntry>;
  // ── V0.4: Agent Read Tools ─────────────────────────────────────────────
  /** RequestContextLedgers keyed by requestId */
  requestLedgers: Record<string, RequestContextLedger>;
  // ── V0.9 addendum: App Settings ───────────────────────────────────────
  appSettings: AppSettings;
  // ── V1: Safe Terminal ─────────────────────────────────────────────────
  /** CommandExecution records keyed by id */
  commands: Record<string, CommandExecution>;
  /** Command output text keyed by commandId (stored separately to avoid bloating main store) */
  commandOutputs: Record<string, string>;
  /** CommandTrustRules keyed by id */
  trustRules: Record<string, CommandTrustRule>;
  // ── V1.1: Browser Runtime ─────────────────────────────────────────────
  /** BrowserProfile metadata keyed by id (no raw cookies/tokens — Chromium partition owns those) */
  browserProfiles: Record<string, BrowserProfile>;
  /** BrowserSession metadata keyed by id */
  browserSessions: Record<string, BrowserSession>;
  /** BrowserTab metadata keyed by id */
  browserTabs: Record<string, BrowserTab>;
  // ── V2.1: Browser Bookmarks + History ─────────────────────────────────
  /** BrowserBookmarks keyed by id */
  browserBookmarks: Record<string, BrowserBookmark>;
  /** BrowserHistoryEntries keyed by id (private profiles never write here) */
  browserHistory: Record<string, BrowserHistoryEntry>;
  // ── Task / Plan Runtime V1 ─────────────────────────────────────────────
  /** ForgeTask records keyed by task id */
  tasks: Record<string, ForgeTask>;
  /** Latest TaskPlan for each task, keyed by task id */
  taskPlans: Record<string, ForgeTaskPlan>;
  /** Full plan version history keyed by task id */
  taskPlanHistory: Record<string, ForgeTaskPlan[]>;
  // ── Multi-Agent Orchestration V1 ────────────────────────────────────────
  /** AgentInstance records keyed by id */
  agentInstances: Record<string, AgentInstance>;
  /** AgentWorkItem records keyed by id */
  workItems: Record<string, AgentWorkItem>;
  /** SubtaskProposal records keyed by id */
  subtaskProposals: Record<string, SubtaskProposal>;
  /** ReviewResult records keyed by id (workItemId:attempt) */
  reviewResults: Record<string, ReviewResult>;
  /** AssignmentHistoryEntry records keyed by id */
  assignmentHistory: Record<string, AssignmentHistoryEntry>;
}

const DEFAULT_STORE: Store = {
  appState: { onboardingComplete: false, agentConfigId: null, defaultAgentProfileId: null },
  appSettings: { ...DEFAULT_APP_SETTINGS },
  agentConfig: null,
  agentProfiles: {},
  projects: {},
  conversations: [],
  messagesByConv: {},
  requestLedgers: {},
  attachments: {},
  queues: {},
  proposals: {},
  editHistory: {},
  writeJournal: {},
  commands: {},
  commandOutputs: {},
  trustRules: {},
  browserProfiles: {},
  browserSessions: {},
  browserTabs: {},
  browserBookmarks: {},
  browserHistory: {},
  tasks: {},
  taskPlans: {},
  taskPlanHistory: {},
  agentInstances: {},
  workItems: {},
  subtaskProposals: {},
  reviewResults: {},
  assignmentHistory: {},
};

// ── Singleton ──────────────────────────────────────────────────────────────

let _dataDir: string | null = null;
let _store: Store | null = null;

function storePath(): string {
  if (!_dataDir) throw new Error("DB not initialised — call getDb() first");
  return path.join(_dataDir, "forge.json");
}

function load(): Store {
  const p = storePath();
  if (!fs.existsSync(p)) return structuredClone(DEFAULT_STORE);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Store>;
    const base: Store = {
      appState: raw.appState ?? DEFAULT_STORE.appState,
      agentConfig: raw.agentConfig ?? null,
      agentProfiles: raw.agentProfiles ?? {},
      projects: raw.projects ?? {},
      conversations: raw.conversations ?? [],
      messagesByConv: raw.messagesByConv ?? {},
      attachments: raw.attachments ?? {},
      queues: raw.queues ?? {},
      proposals: raw.proposals ?? {},
      editHistory: raw.editHistory ?? {},
      writeJournal: raw.writeJournal ?? {},
      requestLedgers: raw.requestLedgers ?? {},
      appSettings: raw.appSettings ?? { ...DEFAULT_APP_SETTINGS },
      commands: raw.commands ?? {},
      commandOutputs: raw.commandOutputs ?? {},
      trustRules: raw.trustRules ?? {},
      browserProfiles: raw.browserProfiles ?? {},
      browserSessions: raw.browserSessions ?? {},
      browserTabs: raw.browserTabs ?? {},
      browserBookmarks: raw.browserBookmarks ?? {},
      browserHistory: raw.browserHistory ?? {},
      tasks: raw.tasks ?? {},
      taskPlans: raw.taskPlans ?? {},
      taskPlanHistory: raw.taskPlanHistory ?? {},
      agentInstances: raw.agentInstances ?? {},
      workItems: raw.workItems ?? {},
      subtaskProposals: raw.subtaskProposals ?? {},
      reviewResults: raw.reviewResults ?? {},
      assignmentHistory: raw.assignmentHistory ?? {},
    };

    // ── One-time migration: AgentConfig → AgentProfile ─────────────────
    // If there is a legacy agentConfig and it has not been migrated yet,
    // create an AgentProfile from it and update AppState.
    if (base.agentConfig && Object.keys(base.agentProfiles).length === 0) {
      const legacy = base.agentConfig;
      const profile: AgentProfile = {
        id: legacy.id,
        name: legacy.name,
        endpoint: legacy.endpoint,
        protocol: legacy.protocol,
        model: legacy.model,
        ...(legacy.apiKeyHeader !== undefined && { apiKeyHeader: legacy.apiKeyHeader }),
        ...(legacy.timeoutMs !== undefined && { timeoutMs: legacy.timeoutMs }),
        isDefault: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      base.agentProfiles[profile.id] = profile;
      // Update AppState to point to new canonical field
      base.appState = {
        ...base.appState,
        defaultAgentProfileId: profile.id,
      };
      // Null out legacy record so migration does not run again
      base.agentConfig = null;
    }

    // Ensure defaultAgentProfileId is present on appState
    if (!('defaultAgentProfileId' in base.appState)) {
      // Access legacy agentConfigId from the raw parsed object before it was typed
      const rawState = base.appState as Record<string, unknown>;
      const legacyId = typeof rawState['agentConfigId'] === 'string' ? rawState['agentConfigId'] : null;
      (base.appState as AppState).defaultAgentProfileId = legacyId;
    }
    // Migrate legacy flat messages into a default conversation
    if (raw.messages && raw.messages.length > 0 && base.conversations.length === 0) {
      const legacyConvId = "conv-legacy";
      const now = Date.now();
      base.conversations.push({
        id: legacyConvId,
        title: "Previous conversation",
        createdAt: now,
        updatedAt: now,
      });
      base.messagesByConv[legacyConvId] = raw.messages.map((m) => ({
        ...m,
        conversationId: legacyConvId,
      }));
    }
    // On restart: any "processing" items become "paused" (interrupted)
    for (const q of Object.values(base.queues)) {
      for (const item of q.items) {
        if (item.status === "processing") {
          item.status = "paused";
          item.lastError = "Interrupted by app restart";
        }
      }
      // If any item is paused after restart, pause the queue too
      if (q.items.some((i) => i.status === "paused")) {
        q.paused = true;
      }
    }
    return base;
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

function save(s: Store): void {
  fs.writeFileSync(storePath(), JSON.stringify(s, null, 2), "utf8");
}

// ── Public init ────────────────────────────────────────────────────────────

/** Reset the singleton — for tests only. */
export function resetDb(): void {
  _dataDir = null;
  _store = null;
}

/** Initialise (idempotent). Returns an opaque handle for call-site compat. */
export function getDb(dataDir: string): true {
  if (_dataDir) return true;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  _dataDir = dataDir;
  _store = load();
  return true;
}

export function getDataDir(): string {
  if (!_dataDir) throw new Error("DB not initialised");
  return _dataDir;
}

function store(): Store {
  if (!_store) throw new Error("DB not initialised");
  return _store;
}

function persist(): void {
  save(store());
}

// ── App State ──────────────────────────────────────────────────────────────

export function getAppState(_db: true): AppState {
  return structuredClone(store().appState);
}

export function setAppState(_db: true, state: AppState): void {
  store().appState = state;
  persist();
}

// ── Agent Config (legacy shim — used only by old tests) ───────────────────

export function saveAgentConfig(_db: true, cfg: AgentConfig): void {
  // Write-through to agentProfiles so both old and new code work
  const existing = store().agentProfiles[cfg.id];
  const now = Date.now();
  const profile: AgentProfile = {
    id: cfg.id,
    name: cfg.name,
    endpoint: cfg.endpoint,
    protocol: cfg.protocol,
    model: cfg.model,
    ...(cfg.apiKeyHeader !== undefined && { apiKeyHeader: cfg.apiKeyHeader }),
    ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
    isDefault: existing?.isDefault ?? (Object.keys(store().agentProfiles).length === 0),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store().agentProfiles[profile.id] = profile;
  // If becoming the only profile, make default
  if (Object.keys(store().agentProfiles).length === 1) {
    store().agentProfiles[profile.id]!.isDefault = true;
    store().appState.defaultAgentProfileId = profile.id;
  }
  persist();
}

export function getAgentConfig(_db: true, id: string): AgentConfig | null {
  const p = store().agentProfiles[id];
  if (!p) return null;
  return {
    id: p.id, name: p.name, endpoint: p.endpoint, protocol: p.protocol, model: p.model,
    ...(p.apiKeyHeader !== undefined && { apiKeyHeader: p.apiKeyHeader }),
    ...(p.timeoutMs !== undefined && { timeoutMs: p.timeoutMs }),
  };
}

export function deleteAgentConfig(_db: true, id: string): void {
  delete store().agentProfiles[id];
  persist();
}

// ── Agent Profiles ─────────────────────────────────────────────────────────

export function listAgentProfiles(_db: true): AgentProfile[] {
  return structuredClone(
    Object.values(store().agentProfiles)
      .filter((p) => !p.archived)
      .sort((a, b) => {
        // Default first, then by lastUsedAt desc, then createdAt desc
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;
        const aLast = a.lastUsedAt ?? a.createdAt;
        const bLast = b.lastUsedAt ?? b.createdAt;
        return bLast - aLast;
      })
  );
}

export function getAgentProfile(_db: true, id: string): AgentProfile | null {
  const p = store().agentProfiles[id];
  return p ? structuredClone(p) : null;
}

export function saveAgentProfile(_db: true, profile: AgentProfile): void {
  const s = store();
  // If this profile is being set as default, clear existing default
  if (profile.isDefault) {
    for (const p of Object.values(s.agentProfiles)) {
      if (p.id !== profile.id) p.isDefault = false;
    }
    s.appState.defaultAgentProfileId = profile.id;
  }
  s.agentProfiles[profile.id] = profile;
  persist();
}

export function updateAgentProfile(
  _db: true,
  id: string,
  patch: Partial<Omit<AgentProfile, "id" | "createdAt">>
): AgentProfile | null {
  const s = store();
  const p = s.agentProfiles[id];
  if (!p) return null;
  // If setting as default, clear others
  if (patch.isDefault === true) {
    for (const other of Object.values(s.agentProfiles)) {
      if (other.id !== id) other.isDefault = false;
    }
    s.appState.defaultAgentProfileId = id;
  }
  Object.assign(p, patch);
  p.updatedAt = Date.now();
  persist();
  return structuredClone(p);
}

export function archiveAgentProfile(_db: true, id: string): void {
  const s = store();
  const p = s.agentProfiles[id];
  if (!p) return;
  p.archived = true;
  // If it was the default, pick another
  if (p.isDefault) {
    p.isDefault = false;
    const next = Object.values(s.agentProfiles).find((x) => !x.archived);
    if (next) {
      next.isDefault = true;
      s.appState.defaultAgentProfileId = next.id;
    } else {
      s.appState.defaultAgentProfileId = null;
    }
  }
  persist();
}

export function setDefaultAgentProfile(_db: true, id: string): void {
  const s = store();
  for (const p of Object.values(s.agentProfiles)) {
    p.isDefault = p.id === id;
  }
  s.appState.defaultAgentProfileId = id;
  persist();
}

export function touchAgentProfileLastUsed(_db: true, id: string): void {
  const p = store().agentProfiles[id];
  if (!p) return;
  p.lastUsedAt = Date.now();
  persist();
}

export function updateAgentProfileStatus(
  _db: true,
  id: string,
  status: AgentProfile["lastConnectionStatus"]
): void {
  const p = store().agentProfiles[id];
  if (!p) return;
  if (status !== undefined) {
    p.lastConnectionStatus = status;
  }
  p.lastConnectionTestAt = Date.now();
  persist();
}

// ── Conversations ──────────────────────────────────────────────────────────

export function listConversations(
  _db: true,
  includeArchived = false,
  scopeProjectId?: string | null
): Conversation[] {
  const convs = store().conversations.filter((c) => {
    if (!includeArchived && c.archivedAt) return false;
    // Scope filter: undefined = all, null = global only, string = that project
    if (scopeProjectId === undefined) return true;
    if (scopeProjectId === null) return !c.projectId;
    return c.projectId === scopeProjectId;
  });
  return structuredClone(
    convs.sort((a, b) => {
      if (a.pinnedAt && !b.pinnedAt) return -1;
      if (!a.pinnedAt && b.pinnedAt) return 1;
      return b.updatedAt - a.updatedAt;
    })
  );
}

export function searchConversations(
  _db: true,
  query: string,
  scopeProjectId?: string | null
): Conversation[] {
  const q = query.toLowerCase();
  return structuredClone(
    store().conversations.filter((c) => {
      if (c.archivedAt) return false;
      if (scopeProjectId !== undefined) {
        if (scopeProjectId === null && c.projectId) return false;
        if (typeof scopeProjectId === "string" && c.projectId !== scopeProjectId) return false;
      }
      return c.title.toLowerCase().includes(q);
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  );
}

export function searchMessages(
  _db: true,
  query: string,
  scopeProjectId?: string | null
): Array<{ message: ChatMessage; conversation: Conversation }> {
  const q = query.toLowerCase();
  const s = store();
  const results: Array<{ message: ChatMessage; conversation: Conversation }> = [];
  for (const conv of s.conversations) {
    if (conv.archivedAt) continue;
    if (scopeProjectId !== undefined) {
      if (scopeProjectId === null && conv.projectId) continue;
      if (typeof scopeProjectId === "string" && conv.projectId !== scopeProjectId) continue;
    }
    const msgs = s.messagesByConv[conv.id] ?? [];
    for (const msg of msgs) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      if (msg.content.toLowerCase().includes(q)) {
        results.push({
          message: structuredClone(msg),
          conversation: structuredClone(conv),
        });
      }
    }
  }
  return results.sort((a, b) => b.message.createdAt - a.message.createdAt).slice(0, 50);
}

export function getConversation(_db: true, id: string): Conversation | null {
  const conv = store().conversations.find((c) => c.id === id);
  return conv ? structuredClone(conv) : null;
}

export function createConversation(_db: true, conv: Conversation): void {
  store().conversations.push(conv);
  if (!store().messagesByConv[conv.id]) {
    store().messagesByConv[conv.id] = [];
  }
  persist();
}

export function updateConversation(
  _db: true,
  id: string,
  patch: Partial<Pick<Conversation, "title" | "updatedAt" | "pinnedAt" | "archivedAt" | "defaultAgentProfileId">>
): void {
  const conv = store().conversations.find((c) => c.id === id);
  if (!conv) return;
  if (patch.title !== undefined) conv.title = patch.title;
  if (patch.updatedAt !== undefined) conv.updatedAt = patch.updatedAt;
  if ("pinnedAt" in patch) conv.pinnedAt = patch.pinnedAt;
  if ("archivedAt" in patch) conv.archivedAt = patch.archivedAt;
  if ("defaultAgentProfileId" in patch) conv.defaultAgentProfileId = patch.defaultAgentProfileId;
  persist();
}

export function exportConversationMarkdown(_db: true, id: string): string {
  const conv = store().conversations.find((c) => c.id === id);
  if (!conv) return "";
  const msgs = getMessagesByConversation(true, id);
  const lines: string[] = [
    `# ${conv.title}`,
    ``,
    `_Exported from Uzmoon Forge — ${new Date(conv.createdAt).toLocaleString()}_`,
    ``,
  ];
  for (const msg of msgs) {
    if (msg.role === "user") {
      lines.push(`**You**  `);
    } else if (msg.role === "assistant") {
      // Show agent name snapshot if available
      const label = msg.agentNameSnapshot
        ? `**${msg.agentNameSnapshot}${msg.modelSnapshot ? ` — ${msg.modelSnapshot}` : ""}**`
        : "**Agent**";
      lines.push(`${label}  `);
    } else {
      lines.push(`**Error**  `);
    }
    lines.push(`_${new Date(msg.createdAt).toLocaleString()}_`, ``);
    lines.push(msg.content || "_(no text content)_");
    if (msg.attachments && msg.attachments.length > 0) {
      lines.push(``);
      for (const att of msg.attachments) {
        lines.push(`— ${att.filename} (${(att.size / 1024).toFixed(1)} KB)`);
      }
    }
    lines.push(``, `---`, ``);
  }
  return lines.join("\n");
}

export function deleteConversation(_db: true, id: string): { attachmentPaths: string[] } {
  const s = store();
  s.conversations = s.conversations.filter((c) => c.id !== id);
  delete s.messagesByConv[id];
  delete s.queues[id];
  const attachmentPaths: string[] = [];
  for (const [attId, att] of Object.entries(s.attachments)) {
    if (att.conversationId === id) {
      attachmentPaths.push(att.localPath);
      delete s.attachments[attId];
    }
  }
  persist();
  return { attachmentPaths };
}

export function branchConversation(
  _db: true,
  sourceConvId: string,
  upToMessageId: string,
  newConvId: string
): Conversation | null {
  const s = store();
  const sourceConv = s.conversations.find((c) => c.id === sourceConvId);
  if (!sourceConv) return null;
  const sourceMsgs = s.messagesByConv[sourceConvId] ?? [];
  const idx = sourceMsgs.findIndex((m) => m.id === upToMessageId);
  if (idx === -1) return null;
  const now = Date.now();
  const newConv: Conversation = {
    id: newConvId,
    title: `Branch: ${sourceConv.title}`,
    createdAt: now,
    updatedAt: now,
    parentConversationId: sourceConvId,
    branchedFromMessageId: upToMessageId,
    // Branch inherits projectId from source — preserves scope
    ...(sourceConv.projectId !== undefined && { projectId: sourceConv.projectId }),
  };
  s.conversations.push(newConv);
  // Copy messages up to and including the branch point
  s.messagesByConv[newConvId] = sourceMsgs.slice(0, idx + 1).map((m) => ({
    ...m,
    conversationId: newConvId,
  }));
  // Copy attachment metadata for those messages
  const copiedMsgIds = new Set(s.messagesByConv[newConvId]!.map((m) => m.id));
  for (const att of Object.values(s.attachments)) {
    if (att.conversationId === sourceConvId && copiedMsgIds.has(att.messageId)) {
      const newAtt: Attachment = { ...att, conversationId: newConvId };
      s.attachments[newAtt.id + "_branch_" + newConvId] = newAtt;
    }
  }
  persist();
  return structuredClone(newConv);
}

// ── Messages ───────────────────────────────────────────────────────────────

export function insertMessage(_db: true, msg: ChatMessage): void {
  const s = store();
  if (!s.messagesByConv[msg.conversationId]) {
    s.messagesByConv[msg.conversationId] = [];
  }
  const { attachments: _att, ...msgToStore } = msg;
  void _att;
  s.messagesByConv[msg.conversationId]!.push(msgToStore as ChatMessage);
  persist();
}

export function getMessagesByConversation(_db: true, convId: string): ChatMessage[] {
  const msgs = store().messagesByConv[convId] ?? [];
  const attachments = store().attachments;
  return structuredClone(msgs).map((m) => {
    const atts = Object.values(attachments).filter((a) => a.messageId === m.id);
    return atts.length > 0 ? { ...m, attachments: atts } : m;
  });
}

export function deleteMessage(_db: true, convId: string, msgId: string): void {
  const msgs = store().messagesByConv[convId];
  if (!msgs) return;
  store().messagesByConv[convId] = msgs.filter((m) => m.id !== msgId);
  persist();
}

export function getAllMessages(_db: true): ChatMessage[] {
  const s = store();
  return structuredClone(Object.values(s.messagesByConv).flat());
}

export function clearMessages(_db: true): void {
  store().messagesByConv = {};
  persist();
}

// ── Attachments ────────────────────────────────────────────────────────────

export function saveAttachmentMeta(_db: true, att: Attachment): void {
  store().attachments[att.id] = att;
  persist();
}

export function getAttachment(_db: true, id: string): Attachment | null {
  const att = store().attachments[id];
  return att ? structuredClone(att) : null;
}

export function deleteAttachment(_db: true, id: string): string | null {
  const att = store().attachments[id];
  if (!att) return null;
  delete store().attachments[id];
  persist();
  return att.localPath;
}

export function getAttachmentsByMessage(_db: true, msgId: string): Attachment[] {
  return structuredClone(
    Object.values(store().attachments).filter((a) => a.messageId === msgId)
  );
}

// ── Queue ──────────────────────────────────────────────────────────────────

function getQueue(convId: string): ConvQueue {
  const s = store();
  if (!s.queues[convId]) s.queues[convId] = { items: [], paused: false };
  return s.queues[convId]!;
}

export function getConvQueue(_db: true, convId: string): { items: QueueItem[]; paused: boolean } {
  return structuredClone(getQueue(convId));
}

export function enqueueItem(_db: true, item: QueueItem): void {
  getQueue(item.conversationId).items.push(item);
  persist();
}

export function updateQueueItem(_db: true, convId: string, itemId: string, patch: Partial<QueueItem>): void {
  const q = getQueue(convId);
  const item = q.items.find((i) => i.id === itemId);
  if (!item) return;
  Object.assign(item, patch);
  persist();
}

export function removeQueueItem(_db: true, convId: string, itemId: string): void {
  const q = getQueue(convId);
  q.items = q.items.filter((i) => i.id !== itemId);
  persist();
}

export function setQueuePaused(_db: true, convId: string, paused: boolean): void {
  getQueue(convId).paused = paused;
  persist();
}

export function reorderQueueItems(_db: true, convId: string, orderedIds: string[]): void {
  const q = getQueue(convId);
  const map = new Map(q.items.map((i) => [i.id, i]));
  const reordered: QueueItem[] = [];
  for (const id of orderedIds) {
    const item = map.get(id);
    if (item) reordered.push(item);
  }
  // Append any items not in the reorder list (shouldn't happen, but safety)
  for (const item of q.items) {
    if (!orderedIds.includes(item.id)) reordered.push(item);
  }
  q.items = reordered;
  persist();
}

/** Get next queued item (not paused, status=queued) */
export function nextQueuedItem(_db: true, convId: string): QueueItem | null {
  const q = getQueue(convId);
  if (q.paused) return null;
  const item = q.items.find((i) => i.status === "queued");
  return item ? structuredClone(item) : null;
}

/** True if a processing item exists for this conversation */
export function hasProcessingItem(_db: true, convId: string): boolean {
  return getQueue(convId).items.some((i) => i.status === "processing");
}

/** Remove completed/cancelled items older than 1 hour to keep store tidy */
export function pruneQueueHistory(_db: true, convId: string): void {
  const q = getQueue(convId);
  const cutoff = Date.now() - 60 * 60 * 1000;
  q.items = q.items.filter(
    (i) =>
      i.status === "queued" ||
      i.status === "processing" ||
      i.status === "paused" ||
      (i.status === "failed" && (i.completedAt ?? 0) > cutoff) ||
      (i.status === "cancelled" && (i.completedAt ?? 0) > cutoff) ||
      (i.status === "completed" && (i.completedAt ?? 0) > cutoff)
  );
  persist();
}

// ── Projects ───────────────────────────────────────────────────────────────

export function listProjects(_db: true): Project[] {
  return structuredClone(
    Object.values(store().projects)
      .filter((p) => !p.archived)
      .sort((a, b) => {
        const aTime = a.lastOpenedAt ?? a.updatedAt;
        const bTime = b.lastOpenedAt ?? b.updatedAt;
        return bTime - aTime;
      })
  );
}

export function getProject(_db: true, id: string): Project | null {
  const p = store().projects[id];
  return p ? structuredClone(p) : null;
}

/**
 * Returns the project whose workingDirectory matches the given normalized path.
 * Used to prevent duplicate-directory projects.
 */
export function getProjectByDirectory(_db: true, normalizedPath: string): Project | null {
  const found = Object.values(store().projects).find(
    (p) => !p.archived && p.workingDirectory === normalizedPath
  );
  return found ? structuredClone(found) : null;
}

export function createProject(_db: true, project: Project): void {
  store().projects[project.id] = project;
  persist();
}

export function updateProject(
  _db: true,
  id: string,
  patch: Partial<Omit<Project, "id" | "createdAt">>
): Project | null {
  const s = store();
  const p = s.projects[id];
  if (!p) return null;
  Object.assign(p, patch);
  p.updatedAt = Date.now();
  persist();
  return structuredClone(p);
}

/**
 * Archive (soft-remove) a project.
 * - Project record is marked archived: true.
 * - Conversations that belong to this project are NOT deleted — they remain
 *   queryable by projectId for history integrity.
 * - The actual filesystem folder is NEVER touched.
 */
export function archiveProject(_db: true, id: string): void {
  const s = store();
  const p = s.projects[id];
  if (!p) return;
  p.archived = true;
  p.updatedAt = Date.now();
  persist();
}

/** Touch lastOpenedAt on the project so recency sort is accurate */
export function touchProjectLastOpened(_db: true, id: string): void {
  const p = store().projects[id];
  if (!p) return;
  p.lastOpenedAt = Date.now();
  persist();
}

// ── Edit Proposals (V0.3) ──────────────────────────────────────────────────

export function saveProposal(_db: true, proposal: EditProposal): void {
  store().proposals[proposal.id] = proposal;
  persist();
}

export function getProposal(_db: true, id: string): EditProposal | null {
  const p = store().proposals[id];
  return p ? structuredClone(p) : null;
}

export function listProposalsForConversation(_db: true, conversationId: string): EditProposal[] {
  return structuredClone(
    Object.values(store().proposals)
      .filter((p) => p.conversationId === conversationId)
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

export function updateProposal(
  _db: true,
  id: string,
  patch: Partial<Omit<EditProposal, "id" | "createdAt">>
): EditProposal | null {
  const s = store();
  const p = s.proposals[id];
  if (!p) return null;
  Object.assign(p, patch);
  p.updatedAt = Date.now();
  persist();
  return structuredClone(p);
}

/**
 * For rollback only — removes a proposal that failed to persist consistently.
 * Never call this for user-driven rejection (use updateProposal with status=rejected).
 */
export function deleteProposal(_db: true, id: string): void {
  delete store().proposals[id];
  persist();
}

// ── Applied Edit History (V0.3) ────────────────────────────────────────────

export function saveAppliedEdit(_db: true, edit: AppliedEdit): void {
  store().editHistory[edit.id] = edit;
  persist();
}

export function getAppliedEdit(_db: true, id: string): AppliedEdit | null {
  const e = store().editHistory[id];
  return e ? structuredClone(e) : null;
}

export function listAppliedEditsForProject(_db: true, projectId: string): AppliedEdit[] {
  return structuredClone(
    Object.values(store().editHistory)
      .filter((e) => e.projectId === projectId)
      .sort((a, b) => b.appliedAt - a.appliedAt)
  );
}

export function updateAppliedEdit(
  _db: true,
  id: string,
  patch: Partial<Omit<AppliedEdit, "id">>
): AppliedEdit | null {
  const s = store();
  const e = s.editHistory[id];
  if (!e) return null;
  Object.assign(e, patch);
  persist();
  return structuredClone(e);
}

// ── Write Journal (V0.3) ───────────────────────────────────────────────────

export function addWriteJournalEntry(_db: true, entry: WriteJournalEntry): void {
  store().writeJournal[entry.id] = entry;
  persist();
}

export function removeWriteJournalEntry(_db: true, id: string): void {
  delete store().writeJournal[id];
  persist();
}

export function listWriteJournalEntries(_db: true): WriteJournalEntry[] {
  return structuredClone(Object.values(store().writeJournal));
}

// ── Request Context Ledgers (V0.4) ─────────────────────────────────────────

export function saveLedger(_db: true, ledger: RequestContextLedger): void {
  store().requestLedgers[ledger.requestId] = ledger;
  persist();
}

export function getLedger(_db: true, requestId: string): RequestContextLedger | null {
  const l = store().requestLedgers[requestId];
  return l ? structuredClone(l) : null;
}

export function updateLedger(
  _db: true,
  requestId: string,
  patch: Partial<Omit<RequestContextLedger, "requestId" | "createdAt">>
): RequestContextLedger | null {
  const s = store();
  const l = s.requestLedgers[requestId];
  if (!l) return null;
  Object.assign(l, patch);
  l.updatedAt = Date.now();
  persist();
  return structuredClone(l);
}

export function getLedgersByConversation(_db: true, conversationId: string): RequestContextLedger[] {
  return structuredClone(
    Object.values(store().requestLedgers)
      .filter((l) => l.conversationId === conversationId)
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

/**
 * Returns the set of all agentReadRef snapshot IDs across ALL persisted ledgers.
 * Used by deleteOrphanedSnapshots to avoid deleting snapshots that are still
 * referenced by agent-read refs from a past request.
 */
/**
 * Returns ALL persisted RequestContextLedgers.
 * Used by the canonical immutable resource resolver to search agentReadRefs
 * across all past requests when resolving a proposal base snapshot.
 */
export function getAllLedgers(_db: true): RequestContextLedger[] {
  return structuredClone(Object.values(store().requestLedgers));
}

export function getAllAgentReadRefSnapshotIds(_db: true): Set<string> {
  const ids = new Set<string>();
  for (const ledger of Object.values(store().requestLedgers)) {
    for (const ref of ledger.agentReadRefs) {
      ids.add(ref.id);
    }
  }
  return ids;
}

// ── App Settings ──────────────────────────────────────────────────────────

export function getAppSettings(_db: true): AppSettings {
  return structuredClone(store().appSettings ?? DEFAULT_APP_SETTINGS);
}

export function setAppSettings(_db: true, settings: Partial<AppSettings>): AppSettings {
  const current = store().appSettings ?? { ...DEFAULT_APP_SETTINGS };
  const updated: AppSettings = { ...current, ...settings };
  const s = store();
  s.appSettings = updated;
  save(s);
  return structuredClone(updated);
}

// ── Command Executions (V1: Safe Terminal) ─────────────────────────────────

export function insertCommand(_db: true, cmd: CommandExecution): void {
  store().commands[cmd.id] = structuredClone(cmd);
  persist();
}

export function getCommand(_db: true, id: string): CommandExecution | null {
  const c = store().commands[id];
  return c ? structuredClone(c) : null;
}

export function updateCommand(
  _db: true,
  id: string,
  patch: Partial<{
    state: CommandState;
    authorizationState: CommandExecution["authorizationState"];
    startedAt: number;
    completedAt: number;
    durationMs: number;
    exitCode: number | undefined;
    signal: string;
    outputMetadata: CommandOutputMetadata;
    failureCode: ForgeFailureCode;
  }>
): CommandExecution | null {
  const s = store();
  const c = s.commands[id];
  if (!c) return null;
  Object.assign(c, patch);
  persist();
  return structuredClone(c);
}

export function listCommands(
  _db: true,
  projectId?: string,
  conversationId?: string
): CommandExecution[] {
  let results = Object.values(store().commands);
  if (projectId !== undefined) results = results.filter((c) => c.projectId === projectId);
  if (conversationId !== undefined) results = results.filter((c) => c.conversationId === conversationId);
  return structuredClone(
    results
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, COMMAND_MAX_LIST)
  );
}

const COMMAND_MAX_LIST = 500;

/** Prune old terminal commands beyond MAX_HISTORY_PER_PROJECT per project */
export function pruneCommandHistory(_db: true, projectId: string): void {
  const s = store();
  const all = Object.values(s.commands)
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (all.length <= 500) return;
  const toDelete = all.slice(500);
  for (const c of toDelete) {
    delete s.commands[c.id];
    delete s.commandOutputs[c.id];
  }
  persist();
}

// ── Command Output (stored separately) ────────────────────────────────────

export function setCommandOutputText(_db: true, commandId: string, text: string): void {
  store().commandOutputs[commandId] = text;
  persist();
}

export function getCommandOutputText(_db: true, commandId: string): string | null {
  return store().commandOutputs[commandId] ?? null;
}

// ── Command Trust Rules (V1: Safe Terminal) ────────────────────────────────

export function insertTrustRule(_db: true, rule: CommandTrustRule): void {
  store().trustRules[rule.id] = structuredClone(rule);
  persist();
}

export function getTrustRule(_db: true, id: string): CommandTrustRule | null {
  const r = store().trustRules[id];
  return r ? structuredClone(r) : null;
}

export function listTrustRules(_db: true, projectId: string): CommandTrustRule[] {
  return structuredClone(
    Object.values(store().trustRules)
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

export function deleteTrustRule(_db: true, id: string): void {
  delete store().trustRules[id];
  persist();
}

export function touchTrustRuleUsed(_db: true, ruleId: string): void {
  const r = store().trustRules[ruleId];
  if (!r) return;
  r.lastUsedAt = Date.now();
  r.useCount = (r.useCount ?? 0) + 1;
  persist();
}

// ── Browser Runtime V1 CRUD ───────────────────────────────────────────────
// Stores only metadata — no raw cookies, tokens, or auth data.
// Chromium session partitions own web storage.

export function saveBrowserProfile(_db: true, profile: BrowserProfile): void {
  store().browserProfiles[profile.id] = structuredClone(profile);
  persist();
}

export function getBrowserProfile(_db: true, id: string): BrowserProfile | null {
  const p = store().browserProfiles[id];
  return p ? structuredClone(p) : null;
}

export function listBrowserProfiles(_db: true): BrowserProfile[] {
  return structuredClone(
    Object.values(store().browserProfiles).sort((a, b) => a.createdAt - b.createdAt)
  );
}

export function deleteBrowserProfile(_db: true, id: string): void {
  delete store().browserProfiles[id];
  persist();
}

export function updateBrowserProfile(_db: true, id: string, patch: Partial<BrowserProfile>): BrowserProfile | null {
  const p = store().browserProfiles[id];
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: Date.now() });
  persist();
  return structuredClone(p);
}

export function saveBrowserSession(_db: true, session: BrowserSession): void {
  store().browserSessions[session.id] = structuredClone(session);
  persist();
}

export function getBrowserSession(_db: true, id: string): BrowserSession | null {
  const s = store().browserSessions[id];
  return s ? structuredClone(s) : null;
}

export function listBrowserSessions(_db: true, profileId?: string): BrowserSession[] {
  const all = Object.values(store().browserSessions);
  const filtered = profileId ? all.filter((s) => s.profileId === profileId) : all;
  return structuredClone(filtered.sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt)));
}

export function updateBrowserSession(_db: true, id: string, patch: Partial<BrowserSession>): BrowserSession | null {
  const s = store().browserSessions[id];
  if (!s) return null;
  Object.assign(s, patch, { updatedAt: Date.now() });
  persist();
  return structuredClone(s);
}

export function deleteBrowserSession(_db: true, id: string): void {
  delete store().browserSessions[id];
  persist();
}

export function saveBrowserTab(_db: true, tab: BrowserTab): void {
  store().browserTabs[tab.id] = structuredClone(tab);
  persist();
}

export function getBrowserTab(_db: true, id: string): BrowserTab | null {
  const t = store().browserTabs[id];
  return t ? structuredClone(t) : null;
}

export function listBrowserTabs(_db: true, sessionId: string): BrowserTab[] {
  return structuredClone(
    Object.values(store().browserTabs)
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
  );
}

export function updateBrowserTab(_db: true, id: string, patch: Partial<BrowserTab>): BrowserTab | null {
  const t = store().browserTabs[id];
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: Date.now() });
  persist();
  return structuredClone(t);
}

export function deleteBrowserTab(_db: true, id: string): void {
  delete store().browserTabs[id];
  persist();
}

/** Delete all tabs belonging to a session */
export function deleteBrowserTabsBySession(_db: true, sessionId: string): void {
  const s = store();
  let dirty = false;
  for (const id of Object.keys(s.browserTabs)) {
    if (s.browserTabs[id]?.sessionId === sessionId) {
      delete s.browserTabs[id];
      dirty = true;
    }
  }
  if (dirty) persist();
}

/** Get browser store summary for migration/reconcile purposes */
export function getBrowserStoreSummary(_db: true): {
  profileCount: number;
  sessionCount: number;
  tabCount: number;
} {
  const s = store();
  return {
    profileCount: Object.keys(s.browserProfiles).length,
    sessionCount: Object.keys(s.browserSessions).length,
    tabCount: Object.keys(s.browserTabs).length,
  };
}

// ── Browser Bookmarks (V2.1) ───────────────────────────────────────────────

export function saveBookmark(_db: true, bookmark: BrowserBookmark): void {
  store().browserBookmarks[bookmark.id] = structuredClone(bookmark);
  persist();
}

export function getBookmark(_db: true, id: string): BrowserBookmark | null {
  return structuredClone(store().browserBookmarks[id] ?? null);
}

export function listBookmarks(_db: true, profileId?: string): BrowserBookmark[] {
  const all = Object.values(store().browserBookmarks);
  const filtered = profileId ? all.filter((b) => b.profileId === profileId) : all;
  return filtered.sort((a, b) => b.createdAt - a.createdAt).map((b) => structuredClone(b));
}

export function deleteBookmark(_db: true, id: string): void {
  delete store().browserBookmarks[id];
  persist();
}

export function updateBookmark(_db: true, id: string, patch: Partial<Pick<BrowserBookmark, 'title' | 'folderId'>>): BrowserBookmark | null {
  const b = store().browserBookmarks[id];
  if (!b) return null;
  Object.assign(b, patch, { updatedAt: Date.now() });
  persist();
  return structuredClone(b);
}

// ── Browser History (V2.1) ─────────────────────────────────────────────────
// Private profiles must NEVER write history. Callers must check before calling.

export function appendHistory(_db: true, entry: BrowserHistoryEntry): void {
  store().browserHistory[entry.id] = structuredClone(entry);
  // Keep max 5000 entries — trim oldest
  const keys = Object.keys(store().browserHistory);
  if (keys.length > 5000) {
    const sorted = keys.sort((a, b) =>
      (store().browserHistory[a]?.visitedAt ?? 0) - (store().browserHistory[b]?.visitedAt ?? 0)
    );
    for (let i = 0; i < keys.length - 5000; i++) {
      delete store().browserHistory[sorted[i]!];
    }
  }
  persist();
}

export function listHistory(_db: true, profileId?: string, limit = 200): BrowserHistoryEntry[] {
  const all = Object.values(store().browserHistory);
  const filtered = profileId ? all.filter((h) => h.profileId === profileId) : all;
  return filtered
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, limit)
    .map((h) => structuredClone(h));
}

export function clearHistory(_db: true, profileId?: string): void {
  const s = store();
  if (profileId) {
    for (const id of Object.keys(s.browserHistory)) {
      if (s.browserHistory[id]?.profileId === profileId) {
        delete s.browserHistory[id];
      }
    }
  } else {
    s.browserHistory = {};
  }
  persist();
}

// ── Task / Plan Runtime V1 ─────────────────────────────────────────────────

export function saveTask(_db: true, task: ForgeTask): void {
  store().tasks[task.id] = structuredClone(task);
  persist();
}

export function getTask(_db: true, taskId: string): ForgeTask | null {
  return structuredClone(store().tasks[taskId] ?? null);
}

export function updateTask(_db: true, taskId: string, patch: Partial<ForgeTask>): ForgeTask | null {
  const existing = store().tasks[taskId];
  if (!existing) return null;
  const updated: ForgeTask = { ...existing, ...patch, id: taskId, updatedAt: Date.now() };
  store().tasks[taskId] = updated;
  persist();
  return structuredClone(updated);
}

export function listTasksByConversation(_db: true, convId: string): ForgeTask[] {
  return Object.values(store().tasks)
    .filter((t) => t.conversationId === convId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => structuredClone(t));
}

export function saveTaskPlan(_db: true, plan: ForgeTaskPlan): void {
  const s = store();
  s.taskPlans[plan.taskId] = structuredClone(plan);
  // Append to history
  if (!s.taskPlanHistory[plan.taskId]) {
    s.taskPlanHistory[plan.taskId] = [];
  }
  s.taskPlanHistory[plan.taskId]!.push(structuredClone(plan));
  persist();
}

export function getTaskPlan(_db: true, taskId: string): ForgeTaskPlan | null {
  return structuredClone(store().taskPlans[taskId] ?? null);
}

export function getTaskPlanHistory(_db: true, taskId: string): ForgeTaskPlan[] {
  return (store().taskPlanHistory[taskId] ?? []).map((p) => structuredClone(p));
}

/**
 * Returns all tasks that were mid-execution at last shutdown (for startup reconciliation).
 * These should be reconciled to paused state — never blindly resumed.
 */
export function listInterruptedTasks(_db: true): ForgeTask[] {
  const activeStatuses: TaskStatus[] = [
    "running",
    "waiting_for_approval",
    "waiting_for_human",
    "verifying",
    "planning",
  ];
  return Object.values(store().tasks)
    .filter((t) => activeStatuses.includes(t.status))
    .map((t) => structuredClone(t));
}


// ── Multi-Agent Orchestration V1 — DB functions ─────────────────────────────

// ── AgentInstance ──────────────────────────────────────────────────────────

export function saveAgentInstance(_db: true, inst: AgentInstance): void {
  const s = store();
  s.agentInstances[inst.id] = structuredClone(inst);
  persist();
}

export function getAgentInstance(_db: true, id: string): AgentInstance | null {
  return structuredClone(store().agentInstances[id] ?? null);
}

export function updateAgentInstance(_db: true, id: string, patch: Partial<AgentInstance>): AgentInstance | null {
  const s = store();
  const existing = s.agentInstances[id];
  if (!existing) return null;
  const updated: AgentInstance = { ...existing, ...patch, updatedAt: Date.now() };
  s.agentInstances[id] = updated;
  persist();
  return structuredClone(updated);
}

export function listAgentInstances(_db: true, taskId: string): AgentInstance[] {
  return Object.values(store().agentInstances)
    .filter((i) => i.taskId === taskId)
    .map((i) => structuredClone(i));
}

export function listAllAgentInstances(_db: true): AgentInstance[] {
  return Object.values(store().agentInstances).map((i) => structuredClone(i));
}

// ── AgentWorkItem ──────────────────────────────────────────────────────────

export function saveWorkItem(_db: true, item: AgentWorkItem): void {
  const s = store();
  s.workItems[item.id] = structuredClone(item);
  persist();
}

export function getWorkItem(_db: true, id: string): AgentWorkItem | null {
  return structuredClone(store().workItems[id] ?? null);
}

export function updateWorkItem(_db: true, id: string, patch: Partial<AgentWorkItem>): AgentWorkItem | null {
  const s = store();
  const existing = s.workItems[id];
  if (!existing) return null;
  const updated: AgentWorkItem = { ...existing, ...patch, updatedAt: Date.now() };
  s.workItems[id] = updated;
  persist();
  return structuredClone(updated);
}

export function listWorkItems(_db: true, taskId: string): AgentWorkItem[] {
  return Object.values(store().workItems)
    .filter((w) => w.taskId === taskId)
    .map((w) => structuredClone(w));
}

export function listInterruptedWorkItems(_db: true): AgentWorkItem[] {
  const activeStatuses: AgentWorkItem["status"][] = [
    "running",
    "assigned",
    "waiting_for_human",
    "waiting_for_approval",
    "reviewing",
  ];
  return Object.values(store().workItems)
    .filter((w) => activeStatuses.includes(w.status))
    .map((w) => structuredClone(w));
}

export function listAllWorkItems(_db: true): AgentWorkItem[] {
  return Object.values(store().workItems).map((w) => structuredClone(w));
}

// ── SubtaskProposal ────────────────────────────────────────────────────────

export function saveSubtaskProposal(_db: true, proposal: SubtaskProposal): void {
  const s = store();
  s.subtaskProposals[proposal.id] = structuredClone(proposal);
  persist();
}

export function getSubtaskProposal(_db: true, id: string): SubtaskProposal | null {
  return structuredClone(store().subtaskProposals[id] ?? null);
}

export function updateSubtaskProposal(_db: true, id: string, patch: Partial<SubtaskProposal>): SubtaskProposal | null {
  const s = store();
  const existing = s.subtaskProposals[id];
  if (!existing) return null;
  const updated: SubtaskProposal = { ...existing, ...patch };
  s.subtaskProposals[id] = updated;
  persist();
  return structuredClone(updated);
}

export function listSubtaskProposals(_db: true, taskId: string): SubtaskProposal[] {
  return Object.values(store().subtaskProposals)
    .filter((p) => p.taskId === taskId)
    .map((p) => structuredClone(p));
}

// ── ReviewResult ──────────────────────────────────────────────────────────

export function saveReviewResult(_db: true, review: ReviewResult): void {
  const key = `${review.targetWorkItemId}:${review.reviewedAttempt}`;
  const s = store();
  s.reviewResults[key] = structuredClone(review);
  persist();
}

export function getReviewResult(_db: true, targetWorkItemId: string, reviewedAttempt: number): ReviewResult | null {
  const key = `${targetWorkItemId}:${reviewedAttempt}`;
  return structuredClone(store().reviewResults[key] ?? null);
}

export function listReviewResults(_db: true, taskId?: string): ReviewResult[] {
  const all = Object.values(store().reviewResults).map((r) => structuredClone(r));
  if (!taskId) return all;
  // Filter by looking up the work item's taskId
  const wis = store().workItems;
  return all.filter((r) => {
    const wi = wis[r.targetWorkItemId];
    return wi?.taskId === taskId;
  });
}

// ── AssignmentHistoryEntry ────────────────────────────────────────────────

export function saveAssignmentHistory(_db: true, entry: AssignmentHistoryEntry): void {
  const s = store();
  s.assignmentHistory[entry.id] = structuredClone(entry);
  persist();
}

export function updateAssignmentHistory(_db: true, id: string, patch: Partial<AssignmentHistoryEntry>): AssignmentHistoryEntry | null {
  const s = store();
  const existing = s.assignmentHistory[id];
  if (!existing) return null;
  const updated: AssignmentHistoryEntry = { ...existing, ...patch };
  s.assignmentHistory[id] = updated;
  persist();
  return structuredClone(updated);
}

export function listAssignmentHistory(_db: true, taskId: string): AssignmentHistoryEntry[] {
  return Object.values(store().assignmentHistory)
    .filter((e) => e.taskId === taskId)
    .sort((a, b) => a.assignedAt - b.assignedAt)
    .map((e) => structuredClone(e));
}
