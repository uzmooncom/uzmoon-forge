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
  searchConversations,
  searchMessages,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  branchConversation,
  getMessagesByConversation,
  saveAttachmentMeta,
  getAttachment,
  deleteAttachment,
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  getProjectByDirectory,
  touchProjectLastOpened,
} from "./db.js";
import type { AgentConfig, ChatMessage, Conversation, Attachment, Project } from "../../shared/types.js";

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
    setAppState(db, { onboardingComplete: true, agentConfigId: "abc", defaultAgentProfileId: "abc" });
    const state = getAppState(db);
    expect(state.onboardingComplete).toBe(true);
    expect(state.defaultAgentProfileId).toBe("abc");
  });

  it("returns default state when nothing is saved", () => {
    const state = getAppState(db);
    expect(state).toEqual({ onboardingComplete: false, agentConfigId: null, defaultAgentProfileId: null });
  });

  it("persists data to disk", () => {
    setAppState(db, { onboardingComplete: true, agentConfigId: "x", defaultAgentProfileId: "x" });
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

// ── Projects ──────────────────────────────────────────────────────────────

function makeProject(id: string, name: string, workingDirectory: string): Project {
  const now = Date.now();
  return { id, name, workingDirectory, createdAt: now, updatedAt: now };
}

describe("Project creation", () => {
  it("creates and retrieves a project", () => {
    const p = makeProject("p1", "My App", "/tmp/myapp");
    createProject(db, p);
    const got = getProject(db, "p1");
    expect(got).not.toBeNull();
    expect(got?.name).toBe("My App");
    expect(got?.workingDirectory).toBe("/tmp/myapp");
  });

  it("lists projects sorted by recency", () => {
    const now = Date.now();
    createProject(db, { ...makeProject("p1", "Older", "/tmp/a"), createdAt: now - 10000, updatedAt: now - 10000 });
    createProject(db, { ...makeProject("p2", "Newer", "/tmp/b"), createdAt: now, updatedAt: now });
    const list = listProjects(db);
    expect(list[0]?.id).toBe("p2");
    expect(list[1]?.id).toBe("p1");
  });

  it("returns null for unknown project", () => {
    expect(getProject(db, "ghost")).toBeNull();
  });
});

describe("Project persistence", () => {
  it("persists project across store reload", () => {
    createProject(db, makeProject("p1", "Persist Test", "/tmp/persist"));
    // Simulate restart: reset and reload from same dir
    resetDb();
    const db2 = getDb(tmpDir);
    const got = getProject(db2, "p1");
    expect(got?.name).toBe("Persist Test");
    expect(got?.workingDirectory).toBe("/tmp/persist");
  });
});

describe("Project update and rename", () => {
  it("renames display name without changing workingDirectory", () => {
    createProject(db, makeProject("p1", "Old Name", "/tmp/mydir"));
    const updated = updateProject(db, "p1", { name: "New Name" });
    expect(updated?.name).toBe("New Name");
    expect(updated?.workingDirectory).toBe("/tmp/mydir");
  });

  it("returns null when updating unknown project", () => {
    expect(updateProject(db, "ghost", { name: "X" })).toBeNull();
  });

  it("updates lastOpenedAt via touchProjectLastOpened", () => {
    createProject(db, makeProject("p1", "App", "/tmp/app"));
    const before = getProject(db, "p1");
    touchProjectLastOpened(db, "p1");
    const after = getProject(db, "p1");
    expect(after?.lastOpenedAt).toBeGreaterThanOrEqual(before?.createdAt ?? 0);
  });
});

describe("Duplicate directory prevention", () => {
  it("getProjectByDirectory finds existing project by path", () => {
    createProject(db, makeProject("p1", "App", "/tmp/mydir"));
    const found = getProjectByDirectory(db, "/tmp/mydir");
    expect(found?.id).toBe("p1");
  });

  it("getProjectByDirectory returns null for different path", () => {
    createProject(db, makeProject("p1", "App", "/tmp/mydir"));
    expect(getProjectByDirectory(db, "/tmp/other")).toBeNull();
  });

  it("getProjectByDirectory ignores archived projects", () => {
    createProject(db, makeProject("p1", "App", "/tmp/mydir"));
    archiveProject(db, "p1");
    expect(getProjectByDirectory(db, "/tmp/mydir")).toBeNull();
  });
});

describe("Project removal (archive)", () => {
  it("archives project — no longer in list", () => {
    createProject(db, makeProject("p1", "App", "/tmp/app"));
    archiveProject(db, "p1");
    expect(listProjects(db)).toHaveLength(0);
  });

  it("archived project is still retrievable by id", () => {
    createProject(db, makeProject("p1", "App", "/tmp/app"));
    archiveProject(db, "p1");
    const got = getProject(db, "p1");
    expect(got?.archived).toBe(true);
  });

  it("archiving does NOT remove conversations", () => {
    createProject(db, makeProject("p1", "App", "/tmp/app"));
    createConversation(db, { ...makeConv("c1"), projectId: "p1" });
    archiveProject(db, "p1");
    // Conversations with that projectId remain
    const conv = getConversation(db, "c1");
    expect(conv).not.toBeNull();
    expect(conv?.projectId).toBe("p1");
  });
});

describe("Conversation scope filtering", () => {
  beforeEach(() => {
    createConversation(db, makeConv("global1"));
    createConversation(db, makeConv("global2"));
    createConversation(db, { ...makeConv("proj1"), projectId: "pA" });
    createConversation(db, { ...makeConv("proj2"), projectId: "pA" });
    createConversation(db, { ...makeConv("proj3"), projectId: "pB" });
  });

  it("null scopeProjectId returns only global conversations", () => {
    const convs = listConversations(db, false, null);
    const ids = convs.map((c) => c.id);
    expect(ids).toContain("global1");
    expect(ids).toContain("global2");
    expect(ids).not.toContain("proj1");
    expect(ids).not.toContain("proj3");
  });

  it("string scopeProjectId returns only that project's conversations", () => {
    const convs = listConversations(db, false, "pA");
    const ids = convs.map((c) => c.id);
    expect(ids).toContain("proj1");
    expect(ids).toContain("proj2");
    expect(ids).not.toContain("proj3");
    expect(ids).not.toContain("global1");
  });

  it("undefined scopeProjectId returns all conversations", () => {
    const convs = listConversations(db, false, undefined);
    expect(convs).toHaveLength(5);
  });

  it("no cross-scope leakage between projectA and projectB", () => {
    const aConvs = listConversations(db, false, "pA");
    const bConvs = listConversations(db, false, "pB");
    const aIds = new Set(aConvs.map((c) => c.id));
    const bIds = new Set(bConvs.map((c) => c.id));
    for (const id of aIds) expect(bIds.has(id)).toBe(false);
  });
});

describe("Scoped search", () => {
  beforeEach(() => {
    createConversation(db, { ...makeConv("g1"), title: "Global alpha" });
    createConversation(db, { ...makeConv("p1"), title: "Project alpha", projectId: "pA" });
    insertMessage(db, { ...makeMsg("m1", "g1"), content: "hello world" });
    insertMessage(db, { ...makeMsg("m2", "p1"), content: "hello project" });
  });

  it("searchConversations with null scope finds only global", () => {
    const results = searchConversations(db, "alpha", null);
    expect(results.map((c) => c.id)).toContain("g1");
    expect(results.map((c) => c.id)).not.toContain("p1");
  });

  it("searchConversations with projectId scope finds only that project", () => {
    const results = searchConversations(db, "alpha", "pA");
    expect(results.map((c) => c.id)).toContain("p1");
    expect(results.map((c) => c.id)).not.toContain("g1");
  });

  it("searchMessages with null scope finds only global messages", () => {
    const results = searchMessages(db, "hello", null);
    expect(results.map((r) => r.message.id)).toContain("m1");
    expect(results.map((r) => r.message.id)).not.toContain("m2");
  });

  it("searchMessages with projectId scope finds only project messages", () => {
    const results = searchMessages(db, "hello", "pA");
    expect(results.map((r) => r.message.id)).toContain("m2");
    expect(results.map((r) => r.message.id)).not.toContain("m1");
  });
});

describe("Branch preserves projectId", () => {
  it("branched conversation inherits projectId from source", () => {
    createConversation(db, { ...makeConv("src"), projectId: "pA" });
    insertMessage(db, makeMsg("m1", "src"));
    const branch = branchConversation(db, "src", "m1", "branch1");
    expect(branch?.projectId).toBe("pA");
  });

  it("branched global conversation has no projectId", () => {
    createConversation(db, makeConv("src"));
    insertMessage(db, makeMsg("m1", "src"));
    const branch = branchConversation(db, "src", "m1", "branch2");
    expect(branch?.projectId).toBeUndefined();
  });
});

describe("Global conversation migration compatibility", () => {
  it("existing conversations without projectId are treated as global", () => {
    // Create a conversation without any projectId (legacy style)
    createConversation(db, makeConv("legacy1"));
    const globalConvs = listConversations(db, false, null);
    expect(globalConvs.map((c) => c.id)).toContain("legacy1");
  });

  it("existing global conversations are not shown in project scope", () => {
    createConversation(db, makeConv("legacy1"));
    const projectConvs = listConversations(db, false, "someProject");
    expect(projectConvs.map((c) => c.id)).not.toContain("legacy1");
  });
});

describe("Project default agent", () => {
  it("stores and retrieves defaultAgentProfileId on project", () => {
    createProject(db, {
      ...makeProject("p1", "App", "/tmp/app"),
      defaultAgentProfileId: "profile-abc",
    });
    const got = getProject(db, "p1");
    expect(got?.defaultAgentProfileId).toBe("profile-abc");
  });

  it("can update project default agent independently", () => {
    createProject(db, { ...makeProject("p1", "App", "/tmp/app"), defaultAgentProfileId: "a" });
    updateProject(db, "p1", { defaultAgentProfileId: "b" });
    expect(getProject(db, "p1")?.defaultAgentProfileId).toBe("b");
  });
});

describe("Conversation projectId is immutable by design", () => {
  it("updateConversation does not expose projectId in patch type (by design)", () => {
    createConversation(db, { ...makeConv("c1"), projectId: "pA" });
    // The DB updateConversation patch only allows specific fields; projectId is not in the patch
    // We confirm the original projectId remains after an unrelated update
    updateConversation(db, "c1", { title: "renamed" });
    expect(getConversation(db, "c1")?.projectId).toBe("pA");
  });
});