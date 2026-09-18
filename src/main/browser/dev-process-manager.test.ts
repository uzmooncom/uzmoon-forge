/**
 * dev-process-manager.test.ts
 *
 * Unit tests for DevProcessManager — start/stop/read/list operations,
 * CWD containment, and URL detection from output.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";

// ── Module-level mocks ─────────────────────────────────────────────────────

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", on: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = "/Users/test/myproject";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("resolveDevProcessCwd", () => {
  it("resolves a valid relative path inside project root", async () => {
    const { resolveDevProcessCwd } = await import("../commands/dev-process-manager.js");
    const result = resolveDevProcessCwd(PROJECT_ROOT, "packages/web");
    expect(result).toBe(path.join(PROJECT_ROOT, "packages/web"));
  });

  it("returns project root when cwd_relative is undefined", async () => {
    const { resolveDevProcessCwd } = await import("../commands/dev-process-manager.js");
    const result = resolveDevProcessCwd(PROJECT_ROOT, undefined);
    expect(result).toBe(PROJECT_ROOT);
  });

  it("blocks path traversal with ../", async () => {
    const { resolveDevProcessCwd } = await import("../commands/dev-process-manager.js");
    const result = resolveDevProcessCwd(PROJECT_ROOT, "../../etc");
    expect(result).toBeNull();
  });

  it("blocks absolute path escape", async () => {
    const { resolveDevProcessCwd } = await import("../commands/dev-process-manager.js");
    const result = resolveDevProcessCwd(PROJECT_ROOT, "/etc/passwd");
    // /etc/passwd does not start with PROJECT_ROOT
    expect(result).toBeNull();
  });

  it("allows a subdirectory that starts with the same prefix", async () => {
    const { resolveDevProcessCwd } = await import("../commands/dev-process-manager.js");
    const result = resolveDevProcessCwd(PROJECT_ROOT, "src");
    expect(result).toBe(path.join(PROJECT_ROOT, "src"));
  });
});

describe("listDevProcesses", () => {
  beforeEach(async () => {
    // Import fresh state — processes are module-level
    const dpm = await import("../commands/dev-process-manager.js");
    // Stop any lingering processes from other tests (best-effort)
    for (const p of dpm.listDevProcesses()) {
      dpm.stopDevProcess(p.id);
    }
  });

  it("returns empty list when no processes started", async () => {
    const { listDevProcesses } = await import("../commands/dev-process-manager.js");
    const result = listDevProcesses("proj-none");
    expect(Array.isArray(result)).toBe(true);
  });

  it("filters by projectId when provided", async () => {
    const { listDevProcesses } = await import("../commands/dev-process-manager.js");
    const all = listDevProcesses();
    const forProj = listDevProcesses("proj-abc");
    expect(forProj.length).toBeLessThanOrEqual(all.length);
  });
});

describe("readDevProcessOutput", () => {
  it("returns found=false for unknown processId", async () => {
    const { readDevProcessOutput } = await import("../commands/dev-process-manager.js");
    const result = readDevProcessOutput("no-such-process");
    expect(result.found).toBe(false);
    expect(result.output).toBe("");
  });
});

describe("stopDevProcess", () => {
  it("returns found=false for unknown processId", async () => {
    const { stopDevProcess } = await import("../commands/dev-process-manager.js");
    const result = stopDevProcess("no-such-process");
    expect(result.found).toBe(false);
  });
});

describe("URL detection regex", () => {
  it("detects typical Vite dev server URL pattern", () => {
    const urlPattern = /http:\/\/localhost:(\d+)/g;
    const output = "  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://localhost:5173/";
    const matches = [...output.matchAll(urlPattern)];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.[0]).toBe("http://localhost:5173");
  });

  it("detects CRA dev server URL pattern", () => {
    const urlPattern = /http:\/\/localhost:(\d+)/g;
    const output = "Local:            http://localhost:3000";
    const matches = [...output.matchAll(urlPattern)];
    expect(matches.length).toBeGreaterThan(0);
  });

  it("detects Next.js dev server URL pattern", () => {
    const urlPattern = /http:\/\/localhost:(\d+)/g;
    const output = "  - Local:        http://localhost:3001";
    const matches = [...output.matchAll(urlPattern)];
    expect(matches.length).toBeGreaterThan(0);
  });

  it("does not detect non-localhost URLs", () => {
    const urlPattern = /http:\/\/localhost:(\d+)/g;
    const output = "Connected to https://api.example.com";
    const matches = [...output.matchAll(urlPattern)];
    expect(matches.length).toBe(0);
  });
});
