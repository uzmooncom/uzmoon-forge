import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import {
  getDb,
  resetDb,
  getAppState,
  setAppState,
  saveAgentConfig,
  getAgentConfig,
  deleteAgentConfig,
  insertMessage,
  getAllMessages,
  clearMessages,
} from "./db.js";
import type { AgentConfig, ChatMessage } from "../../shared/types.js";

let tmpDir: string;
let db: true;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-test-"));
  resetDb();
  db = getDb(tmpDir);
});

afterEach(() => {
  resetDb();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("JSON file store", () => {
  it("initialises without error", () => {
    expect(db).toBe(true);
  });

  it("returns default AppState when nothing is saved", () => {
    const state = getAppState(db);
    expect(state.onboardingComplete).toBe(false);
    expect(state.agentConfigId).toBeNull();
  });

  it("persists AppState", () => {
    setAppState(db, { onboardingComplete: true, agentConfigId: "abc" });
    const state = getAppState(db);
    expect(state.onboardingComplete).toBe(true);
    expect(state.agentConfigId).toBe("abc");
  });

  it("saves and retrieves AgentConfig", () => {
    const cfg: AgentConfig = {
      id: "agent-1",
      name: "Test Agent",
      endpoint: "https://api.example.com",
      protocol: "openai",
      model: "gpt-4",
    };
    saveAgentConfig(db, cfg);
    const retrieved = getAgentConfig(db, "agent-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Test Agent");
    expect(retrieved!.protocol).toBe("openai");
  });

  it("returns null for unknown agent id", () => {
    expect(getAgentConfig(db, "no-such-id")).toBeNull();
  });

  it("deletes AgentConfig", () => {
    const cfg: AgentConfig = {
      id: "agent-del",
      name: "To Delete",
      endpoint: "https://x.com",
      protocol: "anthropic",
      model: "claude-3",
    };
    saveAgentConfig(db, cfg);
    deleteAgentConfig(db, "agent-del");
    expect(getAgentConfig(db, "agent-del")).toBeNull();
  });

  it("inserts and retrieves messages", () => {
    const msg: ChatMessage = {
      id: "msg-1",
      role: "user",
      content: "Hello!",
      createdAt: Date.now(),
    };
    insertMessage(db, msg);
    const msgs = getAllMessages(db);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("Hello!");
  });

  it("inserts multiple messages in order", () => {
    const now = Date.now();
    insertMessage(db, { id: "m1", role: "user", content: "A", createdAt: now });
    insertMessage(db, { id: "m2", role: "assistant", content: "B", createdAt: now + 1 });
    const msgs = getAllMessages(db);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.id).toBe("m1");
    expect(msgs[1]!.id).toBe("m2");
  });

  it("clears messages", () => {
    insertMessage(db, { id: "m1", role: "user", content: "X", createdAt: Date.now() });
    clearMessages(db);
    expect(getAllMessages(db)).toHaveLength(0);
  });

  it("persists optional message fields", () => {
    const msg: ChatMessage = {
      id: "msg-opt",
      role: "assistant",
      content: "Hi",
      createdAt: Date.now(),
      model: "gpt-4",
      durationMs: 1234,
    };
    insertMessage(db, msg);
    const msgs = getAllMessages(db);
    expect(msgs[0]!.model).toBe("gpt-4");
    expect(msgs[0]!.durationMs).toBe(1234);
  });

  it("saves agent config with optional fields", () => {
    const cfg: AgentConfig = {
      id: "agent-opt",
      name: "Opts",
      endpoint: "https://a.com",
      protocol: "openai",
      model: "gpt-4",
      apiKeyHeader: "X-Custom-Key",
      timeoutMs: 5000,
    };
    saveAgentConfig(db, cfg);
    const r = getAgentConfig(db, "agent-opt");
    expect(r!.apiKeyHeader).toBe("X-Custom-Key");
    expect(r!.timeoutMs).toBe(5000);
  });

  it("overwrites agent config on re-save", () => {
    saveAgentConfig(db, { id: "a1", name: "Old", endpoint: "https://x.com", protocol: "openai", model: "g3" });
    saveAgentConfig(db, { id: "a1", name: "New", endpoint: "https://x.com", protocol: "openai", model: "g4" });
    expect(getAgentConfig(db, "a1")!.name).toBe("New");
  });

  it("persists data to disk", () => {
    setAppState(db, { onboardingComplete: true, agentConfigId: "x" });
    const jsonPath = path.join(tmpDir, "forge.json");
    expect(fs.existsSync(jsonPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    expect(raw.appState.onboardingComplete).toBe(true);
  });

  it("AppState > returns default state when nothing is saved", () => {
    const state = getAppState(db);
    expect(state).toEqual({ onboardingComplete: false, agentConfigId: null });
  });
});
