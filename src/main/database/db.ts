/**
 * Pure-JS file-based store — no native modules required.
 * Data is persisted as JSON files in the dataDir.
 */
import path from "path";
import fs from "fs";
import type { ChatMessage, AgentConfig, AppState } from "../../shared/types.js";

// ── Store shape ────────────────────────────────────────────────────────────

interface Store {
  appState: AppState;
  agentConfig: AgentConfig | null;
  messages: ChatMessage[];
}

const DEFAULT_STORE: Store = {
  appState: { onboardingComplete: false, agentConfigId: null },
  agentConfig: null,
  messages: [],
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
    return JSON.parse(fs.readFileSync(p, "utf8")) as Store;
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

function save(store: Store): void {
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
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

// ── Messages ───────────────────────────────────────────────────────────────

export function insertMessage(_db: true, msg: ChatMessage): void {
  store().messages.push(msg);
  persist();
}

export function getAllMessages(_db: true): ChatMessage[] {
  return structuredClone(store().messages);
}

export function clearMessages(_db: true): void {
  store().messages = [];
  persist();
}