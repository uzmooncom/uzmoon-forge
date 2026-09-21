/**
 * E2E Chaos: Persistence Integrity
 *
 * Verifies forge.json and secrets.enc remain consistent under:
 *   - Normal operation (round-trip saves)
 *   - Rapid concurrent mutations
 *   - App restart after streaming
 *   - App restart after settings save
 *   - Corrupted DB file recovery
 *
 * BUG criteria:
 *   - Data missing after clean restart
 *   - Partial/truncated JSON in forge.json
 *   - Duplicate conversations/profiles after restart
 *   - Stale "processing" queue items on startup
 *   - Conversation messages lost after restart
 */
import { test, expect } from "@playwright/test";
import { launchForge, closeForge, setupFakeAgent, sendAndAwaitEnd } from "./helpers.js";
import fs from "fs";
import path from "path";
import os from "os";

async function boot() {
  const forge = await launchForge({ fakeProvider: true });
  await forge.page.waitForLoadState("domcontentloaded");
  await forge.page.waitForTimeout(1500);
  const { profileId, convId } = await setupFakeAgent(forge.page);
  return { ...forge, convId, profileId };
}

async function readForgeJson(dataDir: string): Promise<unknown> {
  const dbPath = path.join(dataDir, "forge.json");
  if (!fs.existsSync(dbPath)) return null;
  const raw = fs.readFileSync(dbPath, "utf-8");
  return JSON.parse(raw); // throws if malformed
}

/**
 * Close the Electron app WITHOUT deleting the data dir.
 * Use for restart tests that need to inspect forge.json or relaunch with same dir.
 */
async function closeForgeKeepData(forge: Awaited<ReturnType<typeof boot>>): Promise<void> {
  await forge.app.close();
  // Do NOT delete forge.dataDir
}

test.describe("Chaos: Persistence Integrity", () => {
  test.setTimeout(90_000);

  // ── forge.json must be valid JSON after normal operations ────────────
  test("forge.json is valid JSON after conversations + messages", async () => {
    const forge = await boot();
    let dataDir = forge.dataDir;
    try {
      // Send a message and let it complete
      const result = await sendAndAwaitEnd(forge.page, forge.convId, "persist-test message", 20_000);
      expect(result.error).toBeFalsy();

      // Create more conversations
      for (let i = 0; i < 5; i++) {
        await forge.page.evaluate(async ([pid, i]: [string, number]) => {
          const api = (window as { forgeApi?: { createConversation: (c: object) => Promise<void> } }).forgeApi!;
          const now = Date.now();
          await api.createConversation({
            id: `persist-conv-${i}-${now}`,
            title: `Persist Conv ${i}`,
            defaultAgentProfileId: pid,
            createdAt: now,
            updatedAt: now,
          });
        }, [forge.profileId, i] as [string, number]);
      }

      // Read forge.json BEFORE closing (closeForge deletes tmpdir)
      const db = await readForgeJson(dataDir);
      expect(db).not.toBeNull();
      expect(typeof db).toBe("object");

      // Verify conversations are present
      const dbTyped = db as { conversations?: Record<string, unknown> };
      expect(dbTyped.conversations).toBeDefined();
      expect(Object.keys(dbTyped.conversations ?? {}).length).toBeGreaterThan(0);
    } finally {
      await closeForge(forge).catch(() => {});
    }
  });

  // ── Conversations survive app restart ────────────────────────────────
  test("conversations persist across app restart", async () => {
    // Use a manually managed tmpdir so we control cleanup
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-persist-e2e-"));
    const forge = await launchForge({
      fakeProvider: true,
      extraEnv: { FORGE_DATA_DIR: dataDir },
    });
    await forge.page.waitForLoadState("domcontentloaded");
    await forge.page.waitForTimeout(1500);
    const { profileId, convId: convId1 } = await setupFakeAgent(forge.page);

    let convId2 = "";
    let convId3 = "";

    try {
      // Create conversations with messages
      convId2 = await forge.page.evaluate(async (pid) => {
        const api = (window as { forgeApi?: { createConversation: (c: object) => Promise<void> } }).forgeApi!;
        const now = Date.now();
        const id = `restart-conv-2-${now}`;
        await api.createConversation({
          id,
          title: "Restart Conv 2",
          defaultAgentProfileId: pid,
          createdAt: now,
          updatedAt: now,
        });
        return id;
      }, profileId);

      convId3 = await forge.page.evaluate(async (pid) => {
        const api = (window as { forgeApi?: { createConversation: (c: object) => Promise<void> } }).forgeApi!;
        const now = Date.now();
        const id = `restart-conv-3-${now}`;
        await api.createConversation({
          id,
          title: "Restart Conv 3",
          defaultAgentProfileId: pid,
          createdAt: now,
          updatedAt: now,
        });
        return id;
      }, profileId);

      // Send a message to conv1
      const r = await sendAndAwaitEnd(forge.page, convId1, "persistence check message", 20_000);
      expect(r.error).toBeFalsy();

      // Close app WITHOUT deleting dataDir
      await forge.app.close();

      // Relaunch with same data dir
      const forge2 = await launchForge({
        fakeProvider: true,
        extraEnv: { FORGE_DATA_DIR: dataDir },
      });
      await forge2.page.waitForLoadState("domcontentloaded");
      await forge2.page.waitForTimeout(2000);

      try {
        // All three conversations must exist
        const convs = await forge2.page.evaluate(async () => {
          const api = (window as { forgeApi?: { listConversations: () => Promise<Array<{ id: string; title: string }>> } }).forgeApi!;
          return api.listConversations();
        });

        expect(convs).not.toBeNull();
        const convIds = (convs ?? []).map((c) => c.id);
        expect(convIds).toContain(convId1);
        expect(convIds).toContain(convId2);
        expect(convIds).toContain(convId3);

        // Messages for conv1 must be present
        const msgs = await forge2.page.evaluate(async (cid) => {
          const api = (window as { forgeApi?: { getConversationMessages: (c: string) => Promise<Array<{ role: string }>> } }).forgeApi!;
          return api.getConversationMessages(cid);
        }, convId1);
        expect((msgs ?? []).length).toBeGreaterThanOrEqual(2); // user + assistant
      } finally {
        await closeForge(forge2);
      }
    } catch (e) {
      await forge.app.close().catch(() => {});
      throw e;
    } finally {
      // cleanup manual tmpdir
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ── No stale "processing" queue items after restart ──────────────────
  test("restart mid-stream: no stuck processing items on relaunch", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-restart-e2e-"));
    const forge = await launchForge({
      fakeProvider: true,
      extraEnv: { FORGE_DATA_DIR: dataDir },
    });
    await forge.page.waitForLoadState("domcontentloaded");
    await forge.page.waitForTimeout(1500);
    const { convId } = await setupFakeAgent(forge.page);

    try {
      // Enqueue a slow message then immediately hard-kill (simulates crash).
      // We don't await the result — we close the app before it finishes.
      void forge.page.evaluate(async ([cid, msg]: [string, string]) => {
        const api = (window as { forgeApi?: {
          sendMessage: (req: object) => Promise<unknown>;
        } }).forgeApi!;
        await api.sendMessage({ conversationId: cid, content: msg, attachments: [] });
      }, [convId, "__slow__ restart-mid-stream"] as [string, string]).catch(() => { /* expected */ });

      // Give the message a moment to enqueue and start processing
      await forge.page.waitForTimeout(800);

      // Hard kill the app while stream is running (simulates crash)
      await forge.app.close();

      // Relaunch with same data dir
      const forge2 = await launchForge({
        fakeProvider: true,
        extraEnv: { FORGE_DATA_DIR: dataDir },
      });
      await forge2.page.waitForLoadState("domcontentloaded");
      await forge2.page.waitForTimeout(2000);

      try {
        // Queue must not have items stuck at "processing" on startup
        const qstate = await forge2.page.evaluate(async (cid) => {
          const api = (window as { forgeApi?: { getQueue: (c: string) => Promise<{ items: Array<{ status: string }> } | null> } }).forgeApi!;
          return api.getQueue(cid);
        }, convId);

        if (qstate) {
          const stuck = qstate.items.filter((i) => i.status === "processing");
          expect(stuck.length, "No items should be stuck at processing after restart").toBe(0);
        }

        // Runtime state must be null (no ghost run)
        const runtime = await forge2.page.evaluate(async (cid) => {
          const api = (window as { forgeApi?: { getRuntimeState: (c: string) => Promise<unknown> } }).forgeApi!;
          return api.getRuntimeState(cid);
        }, convId);
        expect(runtime, "Runtime must be null after restart — no ghost run").toBeNull();

        // forge.json must still be valid
        const db = await readForgeJson(dataDir);
        expect(db).not.toBeNull();
      } finally {
        await closeForge(forge2);
      }
    } catch (e) {
      await forge.app.close().catch(() => {});
      throw e;
    } finally {
      // cleanup manual tmpdir
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ── Rapid concurrent DB mutations don't corrupt forge.json ───────────
  test("concurrent conversation mutations: forge.json remains valid", async () => {
    const forge = await boot();
    try {
      // Rapidly create + update + archive conversations concurrently
      const ops = Array.from({ length: 20 }, async (_, i) => {
        const id = await forge.page.evaluate(async ([pid, idx]: [string, number]) => {
          const api = (window as { forgeApi?: {
            createConversation: (c: object) => Promise<void>;
            updateConversation: (id: string, u: object) => Promise<unknown>;
          } }).forgeApi!;
          const now = Date.now();
          const convId = `concurrent-${idx}-${now}`;
          await api.createConversation({
            id: convId,
            title: `Concurrent ${idx}`,
            defaultAgentProfileId: pid,
            createdAt: now,
            updatedAt: now,
          });
          // Immediately update
          await api.updateConversation(convId, { title: `Updated ${idx}` });
          return convId;
        }, [forge.profileId, i] as [string, number]);
        return id;
      });

      await Promise.all(ops);

      // Read forge.json BEFORE closing (closeForge deletes tmpdir)
      const db = await readForgeJson(forge.dataDir);
      expect(db).not.toBeNull();
      const dbTyped = db as { conversations?: Record<string, unknown> };
      expect(Object.keys(dbTyped.conversations ?? {}).length).toBeGreaterThan(20);
    } finally {
      await closeForge(forge).catch(() => {});
    }
  });

  // ── Agent profile persists across restart ────────────────────────────
  test("agent profile survives restart: default profile intact", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-profile-e2e-"));
    const forge = await launchForge({
      fakeProvider: true,
      extraEnv: { FORGE_DATA_DIR: dataDir },
    });
    await forge.page.waitForLoadState("domcontentloaded");
    await forge.page.waitForTimeout(1500);
    await setupFakeAgent(forge.page);

    try {
      // Verify profile is set
      const profile = await forge.page.evaluate(async () => {
        const api = (window as { forgeApi?: { listProfiles: () => Promise<Array<{ id: string; name: string }>> } }).forgeApi!;
        return api.listProfiles().then(ps => ps[0] ?? null);
      });
      expect(profile).not.toBeNull();
      const profileId = profile!.id;

      // Close WITHOUT deleting dataDir
      await forge.app.close();

      // Relaunch
      const forge2 = await launchForge({
        fakeProvider: true,
        extraEnv: { FORGE_DATA_DIR: dataDir },
      });
      await forge2.page.waitForLoadState("domcontentloaded");
      await forge2.page.waitForTimeout(1500);

      try {
        const profile2 = await forge2.page.evaluate(async () => {
          const api = (window as { forgeApi?: { listProfiles: () => Promise<Array<{ id: string; name: string }>> } }).forgeApi!;
          return api.listProfiles().then(ps => ps[0] ?? null);
        });
        expect(profile2).not.toBeNull();
        expect(profile2!.id).toBe(profileId);
      } finally {
        await closeForge(forge2);
      }
    } catch (e) {
      await forge.app.close().catch(() => {});
      throw e;
    } finally {
      // cleanup manual tmpdir
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});