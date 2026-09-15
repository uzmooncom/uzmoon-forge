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
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  getMessagesByConversation,
  saveAttachmentMeta,
  getAttachment,
  deleteAttachment,
} from "./db.js";
import type { AgentConfig, ChatMessage, Conversation, Attachment } from "../../shared/types.js";

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

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConv(id: string, title = "Test conv"): Conversation {
  return { id, title, createdAt: Date.now(), updatedAt: Date.now() };
}

function makeMsg(id: string, convId: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return { id, conversationId: convId, role, content: `msg-${id}`, createdAt: Date.now() };
}

function makeAtt(id: string, msgId: string, convId: string): Attachment {
  return {
    id,
    messageId: msgId,
    conversationId: convId,
    mimeType: "image/png",
    filename: "test.png",
    localPath: `/tmp/${id}.png`,
    size: 1024,
  };
}

// ── Init ───────────────────────────────────────────────────────────────────

describe("JSON file store — init", () => {
  it("initialises without error", () => {
    expect(db).toBe(true);
  });

  it("returns default AppState when nothing is saved", () => {
    const state = getAppState(db);
    expect(state.onboardingComplete).toBe(false);
    expect(state.agentConfigId).toBeNull();
  });
});

// ── AppState ───────────────────────────────────────────────────────────────

describe("AppState", () => {
  it("persists AppState", () => {
    setAppState(db, { onboardingComplete: true, agentConfigId: "abc" });
    const state = getAppState(db);
    expect(state.onboardingComplete).toBe(true);
    expect(state.agentConfigId).toBe("abc");
  });

  it("returns default state when nothing is saved", () => {
    const state = getAppState(db);
    expect(state).toEqual({ onboardingComplete: false, agentConfigId: null });
  });

  it("persists data to disk", () => {
    setAppState(db, { onboardingComplete: true, agentConfigId: "x" });
    const jsonPath = path.join(tmpDir, "forge.json");
    expect(fs.existsSync(jsonPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    expect(raw.appState.onboardingComplete).toBe(true);
  });
});

// ── AgentConfig ────────────────────────────────────────────────────────────

describe("AgentConfig", () => {
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
});

// ── Conversations ──────────────────────────────────────────────────────────

describe("Conversations", () => {
  it("starts with empty list", () => {
    expect(listConversations(db)).toHaveLength(0);
  });

  it("creates and retrieves a conversation", () => {
    const conv = makeConv("c1", "My chat");
    createConversation(db, conv);
    const got = getConversation(db, "c1");
    expect(got).not.toBeNull();
    expect(got!.title).toBe("My chat");
  });

  it("returns null for unknown conversation", () => {
    expect(getConversation(db, "nope")).toBeNull();
  });

  it("lists conversations sorted by updatedAt descending", () => {
    const now = Date.now();
    createConversation(db, { id: "old", title: "Old", createdAt: now - 2000, updatedAt: now - 2000 });
    createConversation(db, { id: "new", title: "New", createdAt: now, updatedAt: now });
    const list = listConversations(db);
    expect(list[0]!.id).toBe("new");
    expect(list[1]!.id).toBe("old");
  });

  it("updates conversation title", () => {
    createConversation(db, makeConv("c2", "Old title"));
    updateConversation(db, "c2", { title: "New title" });
    expect(getConversation(db, "c2")!.title).toBe("New title");
  });

  it("deletes a conversation", () => {
    createConversation(db, makeConv("c3"));
    deleteConversation(db, "c3");
    expect(getConversation(db, "c3")).toBeNull();
    expect(listConversations(db)).toHaveLength(0);
  });

  it("deleteConversation cascades messages", () => {
    createConversation(db, makeConv("c4"));
    insertMessage(db, makeMsg("m1", "c4"));
    deleteConversation(db, "c4");
    expect(getMessagesByConversation(db, "c4")).toHaveLength(0);
  });

  it("deleteConversation returns attachment paths for cleanup", () => {
    createConversation(db, makeConv("c5"));
    const att = makeAtt("a1", "m1", "c5");
    saveAttachmentMeta(db, att);
    const paths = deleteConversation(db, "c5");
    expect(paths).toContain(att.localPath);
    expect(getAttachment(db, "a1")).toBeNull();
  });
});

// ── Messages ───────────────────────────────────────────────────────────────

describe("Messages", () => {
  it("inserts and retrieves messages by conversation", () => {
    createConversation(db, makeConv("c1"));
    insertMessage(db, makeMsg("m1", "c1"));
    const msgs = getMessagesByConversation(db, "c1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("msg-m1");
  });

  it("inserts multiple messages in order", () => {
    createConversation(db, makeConv("c1"));
    const now = Date.now();
    insertMessage(db, { id: "m1", conversationId: "c1", role: "user", content: "A", createdAt: now });
    insertMessage(db, { id: "m2", conversationId: "c1", role: "assistant", content: "B", createdAt: now + 1 });
    const msgs = getMessagesByConversation(db, "c1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.id).toBe("m1");
    expect(msgs[1]!.id).toBe("m2");
  });

  it("keeps messages from different conversations separate", () => {
    createConversation(db, makeConv("c1"));
    createConversation(db, makeConv("c2"));
    insertMessage(db, makeMsg("m1", "c1"));
    insertMessage(db, makeMsg("m2", "c2"));
    expect(getMessagesByConversation(db, "c1")).toHaveLength(1);
    expect(getMessagesByConversation(db, "c2")).toHaveLength(1);
  });

  it("clears all messages", () => {
    createConversation(db, makeConv("c1"));
    insertMessage(db, makeMsg("m1", "c1"));
    clearMessages(db);
    expect(getAllMessages(db)).toHaveLength(0);
  });

  it("persists optional message fields", () => {
    createConversation(db, makeConv("c1"));
    const msg: ChatMessage = {
      id: "msg-opt",
      conversationId: "c1",
      role: "assistant",
      content: "Hi",
      createdAt: Date.now(),
      model: "gpt-4",
      durationMs: 1234,
    };
    insertMessage(db, msg);
    const msgs = getMessagesByConversation(db, "c1");
    expect(msgs[0]!.model).toBe("gpt-4");
    expect(msgs[0]!.durationMs).toBe(1234);
  });
});

// ── Attachments ────────────────────────────────────────────────────────────

describe("Attachments", () => {
  it("saves and retrieves attachment metadata", () => {
    const att = makeAtt("a1", "m1", "c1");
    saveAttachmentMeta(db, att);
    const got = getAttachment(db, "a1");
    expect(got).not.toBeNull();
    expect(got!.filename).toBe("test.png");
    expect(got!.mimeType).toBe("image/png");
  });

  it("returns null for unknown attachment", () => {
    expect(getAttachment(db, "no-att")).toBeNull();
  });

  it("deletes attachment and returns localPath", () => {
    const att = makeAtt("a2", "m1", "c1");
    saveAttachmentMeta(db, att);
    const localPath = deleteAttachment(db, "a2");
    expect(localPath).toBe(att.localPath);
    expect(getAttachment(db, "a2")).toBeNull();
  });

  it("deleteAttachment returns null for unknown id", () => {
    expect(deleteAttachment(db, "ghost")).toBeNull();
  });
});

// ── Legacy getAllMessages ──────────────────────────────────────────────────

describe("Legacy getAllMessages", () => {
  it("returns messages across all conversations", () => {
    createConversation(db, makeConv("c1"));
    createConversation(db, makeConv("c2"));
    insertMessage(db, makeMsg("m1", "c1"));
    insertMessage(db, makeMsg("m2", "c2"));
    expect(getAllMessages(db)).toHaveLength(2);
  });
});