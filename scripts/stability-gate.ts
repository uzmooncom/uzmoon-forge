#!/usr/bin/env tsx
/**
 * scripts/stability-gate.ts — Stability Gate CLI
 *
 * Reads the incident store from dataDir, evaluates whether the app
 * meets the stability threshold, and exits non-zero if it does not.
 *
 * Usage:
 *   DATA_DIR=$HOME/.uzmoon-forge-v01 pnpm tsx scripts/stability-gate.ts
 *   DATA_DIR=... pnpm tsx scripts/stability-gate.ts --json
 *   DATA_DIR=... pnpm tsx scripts/stability-gate.ts --reset-on-pass
 *
 * Environment:
 *   DATA_DIR    — path to Forge data directory (default: $HOME/.uzmoon-forge-v01)
 *   FORGE_VERSION — version tag included in report (default: "unknown")
 *
 * Exit codes:
 *   0  — gate PASSED (zero blocking violations)
 *   1  — gate FAILED (one or more blocking violations in incident store)
 *   2  — error (data dir not found, incident store unreadable)
 *
 * Options:
 *   --json          Print machine-readable JSON report to stdout
 *   --verbose       Print all incidents, not just blocking ones
 *   --reset-on-pass Clear the incident store on successful gate passage
 *   --dry-run       Evaluate gate but never exit non-zero (for CI analysis)
 */

import fs from "fs";
import path from "path";
import { IncidentRecorder } from "../src/main/reliability/incident.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode    = args.includes("--json");
const verbose     = args.includes("--verbose");
const resetOnPass = args.includes("--reset-on-pass");
const dryRun      = args.includes("--dry-run");

// ── Config ────────────────────────────────────────────────────────────────────

const homeDir = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";
const dataDir = process.env["DATA_DIR"] ?? path.join(homeDir, ".uzmoon-forge-v01");
const forgeVersion = process.env["FORGE_VERSION"] ?? "unknown";

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  if (!jsonMode) process.stdout.write(msg + "\n");
}

function err(msg: string): void {
  process.stderr.write("[stability-gate] ERROR: " + msg + "\n");
}

function printSeparator(): void {
  log("─".repeat(60));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate data dir
  if (!fs.existsSync(dataDir)) {
    err(`Data directory not found: ${dataDir}`);
    err(`Set DATA_DIR environment variable to the Forge data directory.`);
    process.exit(2);
  }

  const incidentsDir = path.join(dataDir, "incidents");
  if (!fs.existsSync(incidentsDir)) {
    // No incidents directory → no incidents recorded → gate passes
    if (jsonMode) {
      console.log(JSON.stringify({
        passed: true,
        blockingViolations: [],
        totalIncidents: 0,
        evaluatedAt: new Date().toISOString(),
        forgeVersion,
        dataDir,
        reason: "No incidents directory — no incidents recorded",
      }, null, 2));
    } else {
      log("✅ GATE PASSED — No incidents directory (no incidents recorded)");
      log(`   Data dir:  ${dataDir}`);
      log(`   Version:   ${forgeVersion}`);
    }
    process.exit(0);
  }

  // Load incident recorder (read-only path — we just call getAll())
  let recorder: IncidentRecorder;
  try {
    recorder = new IncidentRecorder({ dataDir, forgeVersion });
  } catch (e) {
    err(`Failed to load incident recorder: ${String(e)}`);
    process.exit(2);
  }

  const all = recorder.getAll();
  const blockingViolations = recorder.checkStabilityGate();
  const passed = blockingViolations.length === 0;

  const report = {
    passed,
    blockingViolations,
    totalIncidents: all.length,
    evaluatedAt: new Date().toISOString(),
    forgeVersion,
    dataDir,
    ...(verbose && { allIncidents: all }),
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSeparator();
    log(`  Uzmoon Forge — Stability Gate Report`);
    log(`  Version:    ${forgeVersion}`);
    log(`  Data dir:   ${dataDir}`);
    log(`  Evaluated:  ${report.evaluatedAt}`);
    printSeparator();
    log(`  Total incidents:      ${all.length}`);
    log(`  Blocking violations:  ${blockingViolations.length}`);
    printSeparator();

    if (blockingViolations.length > 0) {
      log("  BLOCKING VIOLATIONS:");
      for (const v of blockingViolations) {
        log(`    ⛔  ${v}`);
      }
      log("");
    }

    if (verbose && all.length > 0) {
      log("  ALL INCIDENTS:");
      for (const inc of all) {
        const age = Math.round((Date.now() - inc.firstSeen) / 1000 / 60);
        log(`    [${inc.invariantId}] ${inc.title} — ${inc.occurrenceCount}× — ${age}m ago`);
      }
      log("");
    }

    printSeparator();
    if (passed) {
      log("  ✅  GATE PASSED");
    } else {
      log("  ❌  GATE FAILED");
    }
    printSeparator();
  }

  // Reset on pass
  if (passed && resetOnPass) {
    try {
      recorder.clear();
      log("  🗑   Incident store cleared after passing gate.");
    } catch (e) {
      err(`Failed to clear incident store: ${String(e)}`);
    }
  }

  if (dryRun) {
    // Always exit 0 in dry-run mode
    process.exit(0);
  }

  process.exit(passed ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`[stability-gate] FATAL: ${String(e)}\n`);
  process.exit(2);
});