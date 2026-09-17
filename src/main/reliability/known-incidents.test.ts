/**
 * known-incidents.test.ts — KnownIncidents manifest tests.
 * Validates the actual KnownIncidentEntry shape from fingerprint.ts:
 *   { fingerprint, invariantId, title, description, status,
 *     fixedInVersion?, mitigation?, regressionTestId? }
 */

import { describe, it, expect } from "vitest";
import { KNOWN_INCIDENTS, lookupKnownIncident, KNOWN_INCIDENTS_SCHEMA_VERSION } from "./known-incidents.js";

describe("KNOWN_INCIDENTS manifest", () => {
  it("exports KNOWN_INCIDENTS_SCHEMA_VERSION as a number", () => {
    expect(typeof KNOWN_INCIDENTS_SCHEMA_VERSION).toBe("number");
    expect(KNOWN_INCIDENTS_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it("has at least one entry", () => {
    expect(KNOWN_INCIDENTS.length).toBeGreaterThan(0);
  });

  it("all entries have non-empty fingerprint (12-hex)", () => {
    for (const entry of KNOWN_INCIDENTS) {
      expect(entry.fingerprint, `Entry ${entry.invariantId} has bad fingerprint`).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("all entries have non-empty title and description", () => {
    for (const entry of KNOWN_INCIDENTS) {
      expect(entry.title.trim().length, `Entry ${entry.invariantId} has empty title`).toBeGreaterThan(0);
      expect(entry.description.trim().length, `Entry ${entry.invariantId} has empty description`).toBeGreaterThan(0);
    }
  });

  it("all entries have valid status", () => {
    const validStatuses = new Set(["known_bug", "fixed", "wont_fix", "needs_investigation"]);
    for (const entry of KNOWN_INCIDENTS) {
      expect(
        validStatuses.has(entry.status),
        `Entry ${entry.invariantId} has invalid status: ${entry.status}`,
      ).toBe(true);
    }
  });

  it("all entries have non-empty invariantId", () => {
    for (const entry of KNOWN_INCIDENTS) {
      expect(entry.invariantId.trim().length, `Entry has empty invariantId`).toBeGreaterThan(0);
    }
  });

  it("fingerprints are unique across all entries", () => {
    const fps = KNOWN_INCIDENTS.map((e) => e.fingerprint);
    const unique = new Set(fps);
    expect(fps.length).toBe(unique.size);
  });

  it("fixedInVersion is a string when present", () => {
    for (const entry of KNOWN_INCIDENTS) {
      if (entry.fixedInVersion !== undefined) {
        expect(typeof entry.fixedInVersion).toBe("string");
        expect(entry.fixedInVersion.length).toBeGreaterThan(0);
      }
    }
  });

  it("fixed entries have a fixedInVersion", () => {
    const fixed = KNOWN_INCIDENTS.filter((e) => e.status === "fixed");
    for (const entry of fixed) {
      expect(
        entry.fixedInVersion,
        `Fixed entry ${entry.invariantId} missing fixedInVersion`,
      ).toBeDefined();
    }
  });
});

describe("lookupKnownIncident", () => {
  it("returns undefined for unknown fingerprint", () => {
    const result = lookupKnownIncident("000000000000");
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(lookupKnownIncident("")).toBeUndefined();
  });

  it("returns the matching entry for a known fingerprint", () => {
    const first = KNOWN_INCIDENTS[0]!;
    const result = lookupKnownIncident(first.fingerprint);
    expect(result).not.toBeUndefined();
    expect(result!.invariantId).toBe(first.invariantId);
    expect(result!.title).toBe(first.title);
  });

  it("returns separate entry for each known fingerprint", () => {
    for (const entry of KNOWN_INCIDENTS) {
      const result = lookupKnownIncident(entry.fingerprint);
      expect(result, `Failed to look up known incident ${entry.invariantId}`).not.toBeUndefined();
    }
  });

  it("is case-sensitive (fingerprints are lowercase hex)", () => {
    const first = KNOWN_INCIDENTS[0]!;
    // Fingerprints are lowercase hex — upper-case lookup should NOT match
    const upper = first.fingerprint.toUpperCase();
    if (upper !== first.fingerprint) {
      // Only test if the fingerprint actually has letters
      const result = lookupKnownIncident(upper);
      expect(result).toBeUndefined();
    }
  });
});