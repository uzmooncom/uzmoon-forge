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
  Conversation,
  Attachment,
  QueueItem,
  Project,
  EditProposal,
  AppliedEdit,
  WriteJournalEntry,
} from "../../shared/types.js";

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
}

const DEFAULT_STORE: Store = {
  appState: { onboardingComplete: false, agentConfigId: null, defaultAgentProfileId: null },
  agentConfig: null,
  agentProfiles: {},
  projects: {},
  conversations: [],
  messagesByConv: {},
  attachments: {},
  queues: {},
  proposals: {},
  editHistory: {},
  writeJournal: {},
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