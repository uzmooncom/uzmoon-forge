/**
 * Pure-JS file-based store — no native modules required.
 * Data is persisted as JSON files in the dataDir.
 */
import path from "path";
import fs from "fs";
import type {
  ChatMessage,
  AgentConfig,
  AppState,
  Conversation,
  Attachment,
} from "../../shared/types.js";

// ── Store shape ────────────────────────────────────────────────────────────

interface Store {
  appState: AppState;
  agentConfig: AgentConfig | null;
  /** Legacy flat messages (migrated to conversations on first load) */
  messages?: ChatMessage[];
  conversations: Conversation[];
  /** Messages keyed by conversationId */
  messagesByConv: Record<string, ChatMessage[]>;
  /** Attachment metadata keyed by id */
  attachments: Record<string, Attachment>;
}

const DEFAULT_STORE: Store = {
  appState: { onboardingComplete: false, agentConfigId: null },
  agentConfig: null,
  conversations: [],
  messagesByConv: {},
  attachments: {},
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
    // Migrate legacy flat messages into a default conversation
    const base: Store = {
      appState: raw.appState ?? DEFAULT_STORE.appState,
      agentConfig: raw.agentConfig ?? null,
      conversations: raw.conversations ?? [],
      messagesByConv: raw.messagesByConv ?? {},
      attachments: raw.attachments ?? {},
    };
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

// ── Agent Config ───────────────────────────────────────────────────────────

export function saveAgentConfig(_db: true, cfg: AgentConfig): void {
  store().agentConfig = cfg;
  persist();
}

export function getAgentConfig(_db: true, id: string): AgentConfig | null {
  const cfg = store().agentConfig;
  return cfg && cfg.id === id ? structuredClone(cfg) : null;
}

export function deleteAgentConfig(_db: true, _id: string): void {
  store().agentConfig = null;
  persist();
}

// ── Conversations ──────────────────────────────────────────────────────────

export function listConversations(_db: true): Conversation[] {
  return structuredClone(
    [...store().conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  );
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
  patch: Partial<Pick<Conversation, "title" | "updatedAt">>
): void {
  const conv = store().conversations.find((c) => c.id === id);
  if (!conv) return;
  if (patch.title !== undefined) conv.title = patch.title;
  if (patch.updatedAt !== undefined) conv.updatedAt = patch.updatedAt;
  persist();
}

export function deleteConversation(_db: true, id: string): string[] {
  const s = store();
  s.conversations = s.conversations.filter((c) => c.id !== id);
  delete s.messagesByConv[id];
  // Collect and remove attachments for this conversation
  const toDelete: string[] = [];
  for (const [attId, att] of Object.entries(s.attachments)) {
    if (att.conversationId === id) {
      toDelete.push(att.localPath);
      delete s.attachments[attId];
    }
  }
  persist();
  return toDelete; // caller deletes files
}

// ── Messages ───────────────────────────────────────────────────────────────

export function insertMessage(_db: true, msg: ChatMessage): void {
  const s = store();
  if (!s.messagesByConv[msg.conversationId]) {
    s.messagesByConv[msg.conversationId] = [];
  }
  // Strip attachments array — stored separately
  const { attachments: _att, ...msgToStore } = msg;
  void _att;
  s.messagesByConv[msg.conversationId]!.push(msgToStore as ChatMessage);
  persist();
}

export function getMessagesByConversation(_db: true, convId: string): ChatMessage[] {
  const msgs = store().messagesByConv[convId] ?? [];
  const attachments = store().attachments;
  // Join attachments
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

// Legacy — kept for backward compat / tests
export function getAllMessages(_db: true): ChatMessage[] {
  const s = store();
  return structuredClone(
    Object.values(s.messagesByConv).flat()
  );
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