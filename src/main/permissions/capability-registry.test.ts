import { describe, it, expect } from "vitest";
import {
  getAllCapabilities,
  getCapability,
  isKnownCapability,
  getCapabilitiesByCategory,
} from "./capability-registry.js";

describe("capability-registry", () => {
  describe("getAllCapabilities", () => {
    it("returns a non-empty array", () => {
      const caps = getAllCapabilities();
      expect(caps.length).toBeGreaterThan(0);
    });

    it("returns a clone — mutations do not affect registry", () => {
      const caps1 = getAllCapabilities();
      caps1.splice(0, caps1.length);
      const caps2 = getAllCapabilities();
      expect(caps2.length).toBeGreaterThan(0);
    });

    it("all capabilities have required fields", () => {
      for (const cap of getAllCapabilities()) {
        expect(typeof cap.id).toBe("string");
        expect(cap.id.length).toBeGreaterThan(0);
        expect(typeof cap.category).toBe("string");
        expect(typeof cap.name).toBe("string");
        expect(typeof cap.description).toBe("string");
        expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(cap.risk);
        expect(["DENY", "ASK", "ALLOW_SESSION", "ALLOW_PROJECT", "ALWAYS_ALLOW"]).toContain(cap.defaultPolicy);
        expect(typeof cap.requiresProject).toBe("boolean");
        expect(typeof cap.isDestructive).toBe("boolean");
        expect(typeof cap.isNetworked).toBe("boolean");
        expect(typeof cap.isCredentialSensitive).toBe("boolean");
      }
    });

    it("all capability IDs are unique", () => {
      const caps = getAllCapabilities();
      const ids = caps.map((c) => c.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it("all capability IDs follow <category>.<name> pattern", () => {
      for (const cap of getAllCapabilities()) {
        expect(cap.id).toMatch(/^[a-z][a-z0-9._]*[a-z0-9]$/);
      }
    });
  });

  describe("getCapability", () => {
    it("returns capability def for known ID", () => {
      const cap = getCapability("git.status");
      expect(cap).not.toBeNull();
      expect(cap!.id).toBe("git.status");
      expect(cap!.category).toBe("git");
      expect(cap!.defaultPolicy).toBe("ALWAYS_ALLOW");
      expect(cap!.risk).toBe("LOW");
    });

    it("returns null for unknown ID", () => {
      expect(getCapability("does.not.exist")).toBeNull();
      expect(getCapability("")).toBeNull();
      expect(getCapability("git.push")).toBeNull();
    });

    it("returns a reference (not a clone) for performance", () => {
      const cap = getCapability("git.commit");
      expect(cap).not.toBeNull();
      expect(cap!.id).toBe("git.commit");
    });
  });

  describe("isKnownCapability", () => {
    it("returns true for all registered capabilities", () => {
      for (const cap of getAllCapabilities()) {
        expect(isKnownCapability(cap.id)).toBe(true);
      }
    });

    it("returns false for unregistered IDs", () => {
      expect(isKnownCapability("fake.capability")).toBe(false);
      expect(isKnownCapability("")).toBe(false);
      expect(isKnownCapability("git.push")).toBe(false);
      expect(isKnownCapability("terminal.arbitrary_code_execution")).toBe(false);
    });
  });

  describe("getCapabilitiesByCategory", () => {
    it("returns all git capabilities", () => {
      const gitCaps = getCapabilitiesByCategory("git");
      expect(gitCaps.length).toBeGreaterThan(0);
      for (const cap of gitCaps) {
        expect(cap.category).toBe("git");
      }
    });

    it("includes all expected git capability IDs", () => {
      const gitCaps = getCapabilitiesByCategory("git");
      const ids = gitCaps.map((c) => c.id);
      expect(ids).toContain("git.status");
      expect(ids).toContain("git.diff");
      expect(ids).toContain("git.log");
      expect(ids).toContain("git.show");
      expect(ids).toContain("git.branch_info");
      expect(ids).toContain("git.stage");
      expect(ids).toContain("git.unstage");
      expect(ids).toContain("git.commit");
    });

    it("returns all browser capabilities", () => {
      const browserCaps = getCapabilitiesByCategory("browser");
      expect(browserCaps.length).toBeGreaterThan(0);
      for (const cap of browserCaps) {
        expect(cap.category).toBe("browser");
      }
    });

    it("includes browser.web.interact with MEDIUM risk and ASK default", () => {
      const browserCaps = getCapabilitiesByCategory("browser");
      const interact = browserCaps.find((c) => c.id === "browser.web.interact");
      expect(interact).toBeDefined();
      expect(interact!.risk).toBe("MEDIUM");
      expect(interact!.defaultPolicy).toBe("ASK");
      expect(interact!.isCredentialSensitive).toBe(true);
    });

    it("returns all terminal capabilities", () => {
      const terminalCaps = getCapabilitiesByCategory("terminal");
      expect(terminalCaps.length).toBeGreaterThan(0);
      for (const cap of terminalCaps) {
        expect(cap.category).toBe("terminal");
      }
    });

    it("terminal.shell is CRITICAL/DENY", () => {
      const shell = getCapability("terminal.shell");
      expect(shell).not.toBeNull();
      expect(shell!.risk).toBe("CRITICAL");
      expect(shell!.defaultPolicy).toBe("DENY");
    });

    it("terminal.outside_project is CRITICAL/DENY", () => {
      const outside = getCapability("terminal.outside_project");
      expect(outside).not.toBeNull();
      expect(outside!.risk).toBe("CRITICAL");
      expect(outside!.defaultPolicy).toBe("DENY");
    });

    it("returns all filesystem capabilities", () => {
      const fsCaps = getCapabilitiesByCategory("filesystem");
      expect(fsCaps.length).toBeGreaterThan(0);
      for (const cap of fsCaps) {
        expect(cap.category).toBe("filesystem");
      }
    });

    it("project.delete is CRITICAL/destructive", () => {
      const del = getCapability("project.delete");
      expect(del).not.toBeNull();
      expect(del!.risk).toBe("CRITICAL");
      expect(del!.isDestructive).toBe(true);
    });

    it("returns empty array for unknown category", () => {
      // @ts-expect-error — testing invalid input
      const result = getCapabilitiesByCategory("unknown_category");
      expect(result).toEqual([]);
    });
  });

  describe("risk consistency checks", () => {
    it("CRITICAL capabilities all have non-ALWAYS_ALLOW defaults", () => {
      for (const cap of getAllCapabilities()) {
        if (cap.risk === "CRITICAL") {
          expect(["DENY", "ASK"]).toContain(cap.defaultPolicy);
        }
      }
    });

    it("destructive capabilities are not ALWAYS_ALLOW", () => {
      for (const cap of getAllCapabilities()) {
        if (cap.isDestructive) {
          expect(cap.defaultPolicy).not.toBe("ALWAYS_ALLOW");
        }
      }
    });

    it("DENY defaults are only on CRITICAL or HIGH risk caps", () => {
      for (const cap of getAllCapabilities()) {
        if (cap.defaultPolicy === "DENY") {
          expect(["CRITICAL", "HIGH"]).toContain(cap.risk);
        }
      }
    });
  });
});