/**
 * command-policy.ts — Deterministic command risk classification and policy evaluation.
 *
 * INVARIANT: No LLM is ever called here. AI cost = 0.
 * Same (projectId, spec, trustState) → same decision, always.
 *
 * Security model:
 * - Shell interpreters are BLOCK (no bypass via bash -c, node -e, python -c, etc.)
 * - Source-write bypass patterns are BLOCK (sed -i, awk -i, perl -i)
 * - Remote execution (npx, pnpm dlx, bunx, curl, wget) are BLOCK
 * - Git commands are BLOCK in V1
 * - Package installs are ASK
 * - Trusted exact commands auto-ALLOW (trust rule must still be valid)
 * - Unknown executables are ASK (conservative default)
 */
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import type {
  CommandSpec,
  CommandPolicyDecision,
  CommandRiskClass,
  CommandTrustRule,
} from "../../shared/types.js";

// ── Shell interpreter patterns ──────────────────────────────────────────────

/**
 * Executables that provide arbitrary code evaluation.
 * These are unconditionally BLOCK — they can execute arbitrary code and
 * trivially bypass Safe File Editing and project containment.
 */
const SHELL_INTERPRETERS = new Set([
  "bash", "sh", "zsh", "fish", "ksh", "csh", "tcsh", "dash",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  "node",         // node -e "..." is a code execution escape
  "python", "python3", "python2",
  "ruby", "perl", "php", "lua",
  "deno",         // deno eval
  "bun",          // bun eval / bun -e
]);

/**
 * Shell interpreter flags that enable inline code evaluation.
 * If the executable appears elsewhere in KNOWN_SAFE_EXECUTABLES,
 * these flags still trigger BLOCK.
 */
const EVAL_FLAGS = new Set(["-e", "-c", "--eval", "--exec", "eval", "repl"]);

// ── Remote execution patterns ───────────────────────────────────────────────

/**
 * Commands that download and execute arbitrary remote code.
 * These bypass project containment, policy, and Secret Env filtering
 * by pulling in arbitrary third-party code at runtime.
 * BLOCK unconditionally in V1.
 */
const REMOTE_EXECUTION = new Set([
  "npx",
  "npm exec", // detected via executable=npm + args[0]="exec"
  "pnpm dlx", // executable=pnpm + args[0]="dlx"
  "yarn dlx", // executable=yarn + args[0]="dlx"
  "bunx",
  "pnpx",
  "degit",
]);

// Separate sets for multi-arg detection
const REMOTE_EXEC_COMPOSITES: Array<{ executable: string; firstArg: string }> = [
  { executable: "npm",  firstArg: "exec" },
  { executable: "pnpm", firstArg: "dlx" },
  { executable: "yarn", firstArg: "dlx" },
  { executable: "bun",  firstArg: "x" },  // bun x = bunx
];

// ── Network download patterns ───────────────────────────────────────────────

const NETWORK_DOWNLOADERS = new Set([
  "curl", "wget", "fetch", "aria2", "aria2c", "axel", "httpie", "http",
]);

// ── Package installation patterns ──────────────────────────────────────────

const PACKAGE_INSTALL_EXECUTABLES = new Set([
  "pip", "pip3", "gem", "cargo", "go",
  "composer", "dotnet", "mvn", "gradle",
]);

const PACKAGE_INSTALL_COMPOSITES: Array<{ executable: string; firstArg: string }> = [
  { executable: "npm",  firstArg: "install" },
  { executable: "npm",  firstArg: "i" },
  { executable: "npm",  firstArg: "ci" },
  { executable: "npm",  firstArg: "add" },
  { executable: "pnpm", firstArg: "install" },
  { executable: "pnpm", firstArg: "add" },
  { executable: "pnpm", firstArg: "i" },
  { executable: "yarn", firstArg: "install" },
  { executable: "yarn", firstArg: "add" },
  { executable: "bun",  firstArg: "install" },
  { executable: "bun",  firstArg: "add" },
];

// ── Source-write bypass patterns ───────────────────────────────────────────

/**
 * Commands that mutate source files directly.
 * These bypass Safe File Editing — unconditionally BLOCK.
 */
const SOURCE_WRITE_BYPASS = new Set([
  "sed", "awk", "perl",       // commonly used with -i for in-place edit
  "patch",                    // applies diffs directly to files
  "dd",                       // raw byte writing
  "tee",                      // writes to files via pipe
  "install",                  // can overwrite system/project files
]);

// ── Git patterns ────────────────────────────────────────────────────────────

/** All git subcommands — blocked in V1 */
const GIT_EXECUTABLES = new Set(["git", "gh", "hub", "jj"]);

// ── Destructive patterns ────────────────────────────────────────────────────

const DESTRUCTIVE_EXECUTABLES = new Set([
  "rm", "rmdir", "shred", "wipe", "format", "fdisk", "mkfs", "diskutil",
  "del", "rd",  // Windows
]);

// ── Known verification commands ─────────────────────────────────────────────

/**
 * Commands typically used for verification (typecheck, test, lint, build).
 * These get lower risk scores but still require ASK unless trusted.
 */
const VERIFICATION_COMPOSITES: Array<{ executable: string; firstArg?: string }> = [
  { executable: "pnpm", firstArg: "test" },
  { executable: "pnpm", firstArg: "typecheck" },
  { executable: "pnpm", firstArg: "lint" },
  { executable: "pnpm", firstArg: "build" },
  { executable: "pnpm", firstArg: "check" },
  { executable: "pnpm", firstArg: "tsc" },
  { executable: "npm",  firstArg: "test" },
  { executable: "npm",  firstArg: "run" },
  { executable: "yarn", firstArg: "test" },
  { executable: "tsc" },
  { executable: "eslint" },
  { executable: "biome" },
  { executable: "vitest" },
  { executable: "jest" },
  { executable: "mocha" },
  { executable: "prettier" },
];

const PACKAGE_SCRIPT_COMPOSITES: Array<{ executable: string; firstArg: string }> = [
  { executable: "pnpm", firstArg: "run" },
  { executable: "npm",  firstArg: "run" },
  { executable: "yarn", firstArg: "run" },
  { executable: "bun",  firstArg: "run" },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function basename(executable: string): string {
  return path.basename(executable).toLowerCase().replace(/\.exe$/, "");
}

function firstArg(args: string[]): string | undefined {
  return args[0]?.toLowerCase();
}

function matchesComposite(
  exec: string,
  args: string[],
  composites: Array<{ executable: string; firstArg?: string }>
): boolean {
  const b = basename(exec);
  const f = firstArg(args);
  return composites.some(
    (c) => c.executable === b && (c.firstArg === undefined || c.firstArg === f)
  );
}

function matchesCompositeExact(
  exec: string,
  args: string[],
  composites: Array<{ executable: string; firstArg: string }>
): boolean {
  const b = basename(exec);
  const f = firstArg(args);
  return composites.some((c) => c.executable === b && c.firstArg === f);
}

// ── Risk classification ─────────────────────────────────────────────────────

/**
 * Classify the risk level of a command spec.
 * Deterministic — no external calls.
 */
export function classifyRisk(spec: CommandSpec): CommandRiskClass {
  const exec = basename(spec.executable);

  // 1. Shell interpreters (highest priority block)
  if (SHELL_INTERPRETERS.has(exec)) return "shell_interpreter";

  // 2. Eval flags on any known executable (e.g. node -e, python -c)
  if (spec.args.some((a) => EVAL_FLAGS.has(a.toLowerCase()))) return "shell_interpreter";

  // 3. Remote execution (npx, pnpm dlx, bunx, etc.)
  if (REMOTE_EXECUTION.has(exec)) return "remote_execution";
  if (matchesCompositeExact(exec, spec.args, REMOTE_EXEC_COMPOSITES)) return "remote_execution";

  // 4. Network downloaders
  if (NETWORK_DOWNLOADERS.has(exec)) return "network";

  // 5. Source-write bypass
  if (SOURCE_WRITE_BYPASS.has(exec)) return "source_write_bypass";

  // 6. Git (blocked in V1)
  if (GIT_EXECUTABLES.has(exec)) return "git";

  // 7. Destructive
  if (DESTRUCTIVE_EXECUTABLES.has(exec)) return "destructive";

  // 8. Package installation
  if (PACKAGE_INSTALL_EXECUTABLES.has(exec)) return "package_install";
  if (matchesCompositeExact(exec, spec.args, PACKAGE_INSTALL_COMPOSITES)) return "package_install";

  // 9. Package scripts (pnpm run X, npm run X)
  if (matchesCompositeExact(exec, spec.args, PACKAGE_SCRIPT_COMPOSITES)) return "project_script";

  // 10. Known verification
  if (matchesComposite(exec, spec.args, VERIFICATION_COMPOSITES)) return "verification";

  // 11. Unknown
  return "unknown";
}

// ── Policy evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate policy for a command spec against project trust rules.
 * Returns a full CommandPolicyDecision including reasonCode for UI/reliability.
 */
export function evaluatePolicy(
  spec: CommandSpec,
  trustRules: CommandTrustRule[]
): CommandPolicyDecision {
  const riskClass = classifyRisk(spec);

  // ── Hard blocks (never reach trust check) ─────────────────────────────

  if (riskClass === "shell_interpreter") {
    return {
      decision: "block",
      riskClass,
      reasonCode: "BLOCKED_SHELL_INTERPRETER",
    };
  }

  if (riskClass === "source_write_bypass") {
    return {
      decision: "block",
      riskClass,
      reasonCode: "BLOCKED_SOURCE_WRITE_BYPASS",
    };
  }

  if (riskClass === "git") {
    return {
      decision: "block",
      riskClass,
      reasonCode: "BLOCKED_GIT",
    };
  }

  if (riskClass === "remote_execution") {
    return {
      decision: "block",
      riskClass,
      reasonCode: "BLOCKED_REMOTE_EXECUTION",
    };
  }

  if (riskClass === "destructive") {
    return {
      decision: "block",
      riskClass,
      reasonCode: "BLOCKED_DESTRUCTIVE",
    };
  }

  // ── Trust check (must happen before ASK default) ───────────────────────

  const normalizedSpec = normalizeSpec(spec);
  const matchingRule = trustRules.find((r) => r.normalizedSpec === normalizedSpec);

  if (matchingRule) {
    // If this is a package script, validate the script hash is still valid
    if (matchingRule.scriptContentHash !== undefined) {
      // Script hash validation is done externally — evaluatePolicy only checks trust rules.
      // Script hash mismatch is surfaced by the caller using evaluatePolicyWithScriptHash.
      return {
        decision: "allow",
        riskClass,
        reasonCode: "TRUSTED_SCRIPT_HASH_MATCH",
        trustRuleId: matchingRule.id,
      };
    }
    return {
      decision: "allow",
      riskClass,
      reasonCode: "TRUSTED_EXACT_MATCH",
      trustRuleId: matchingRule.id,
    };
  }

  // ── ASK / BLOCK remaining classes ─────────────────────────────────────

  if (riskClass === "package_install") {
    return { decision: "ask", riskClass, reasonCode: "ASK_PACKAGE_INSTALL" };
  }

  if (riskClass === "network") {
    return { decision: "ask", riskClass, reasonCode: "ASK_NETWORK" };
  }

  if (riskClass === "project_script") {
    return { decision: "ask", riskClass, reasonCode: "ASK_PROJECT_SCRIPT" };
  }

  if (riskClass === "verification") {
    return { decision: "ask", riskClass, reasonCode: "ASK_VERIFICATION" };
  }

  if (riskClass === "read_only") {
    return { decision: "ask", riskClass, reasonCode: "ASK_READ_ONLY" };
  }

  if (riskClass === "mutation") {
    return { decision: "ask", riskClass, reasonCode: "ASK_MUTATION" };
  }

  // unknown
  return { decision: "ask", riskClass, reasonCode: "ASK_UNKNOWN" };
}

/**
 * Full policy evaluation that also checks script content hash invalidation.
 * When a trust rule matches but the script body has changed, returns ASK with
 * TRUSTED_SCRIPT_HASH_CHANGED instead of ALLOW.
 */
export function evaluatePolicyWithScriptHash(
  spec: CommandSpec,
  trustRules: CommandTrustRule[],
  projectRoot: string
): CommandPolicyDecision {
  const base = evaluatePolicy(spec, trustRules);

  // Only re-examine if we got a trusted script hash match
  if (base.reasonCode !== "TRUSTED_SCRIPT_HASH_MATCH" || !base.trustRuleId) {
    return base;
  }

  const rule = trustRules.find((r) => r.id === base.trustRuleId);
  if (!rule?.scriptContentHash) return base;

  // Recompute script hash from current package.json
  const currentHash = resolveScriptContentHash(spec, projectRoot);
  if (currentHash === null) {
    // Can't read package.json — treat as changed (ASK)
    return {
      decision: "ask",
      riskClass: base.riskClass,
      reasonCode: "TRUSTED_SCRIPT_HASH_CHANGED",
      trustRuleId: rule.id,
    };
  }

  if (currentHash !== rule.scriptContentHash) {
    return {
      decision: "ask",
      riskClass: base.riskClass,
      reasonCode: "TRUSTED_SCRIPT_HASH_CHANGED",
      trustRuleId: rule.id,
    };
  }

  return base;
}

// ── Spec normalization ──────────────────────────────────────────────────────

/**
 * Normalize a command spec to a stable string key for trust comparison.
 * Case-insensitive executable (by basename), exact args, exact cwd.
 */
export function normalizeSpec(spec: CommandSpec): string {
  const exec = basename(spec.executable);
  const argsStr = spec.args.join("\x00"); // null-byte separator — can't appear in args
  const cwd = spec.cwdRelative.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${exec}\x01${argsStr}\x01${cwd}`;
}

// ── Script hash resolution ──────────────────────────────────────────────────

/**
 * Resolve the content hash of the package.json script referenced by a spec.
 * For `pnpm run test`, reads the "test" script from package.json in cwd.
 * Returns null if not applicable or file not readable.
 */
export function resolveScriptContentHash(
  spec: CommandSpec,
  projectRoot: string
): string | null {
  const exec = basename(spec.executable);
  const f = firstArg(spec.args);

  const isPackageRun =
    (exec === "pnpm" || exec === "npm" || exec === "yarn" || exec === "bun") &&
    f === "run" &&
    spec.args.length >= 2;

  if (!isPackageRun) return null;

  const scriptName = spec.args[1];
  if (!scriptName) return null;

  // Resolve cwd to absolute
  let cwdAbs: string;
  try {
    if (spec.cwdRelative === "" || spec.cwdRelative === ".") {
      cwdAbs = path.resolve(projectRoot);
    } else {
      cwdAbs = path.resolve(projectRoot, spec.cwdRelative);
    }
    // Containment check
    if (!cwdAbs.startsWith(path.resolve(projectRoot))) return null;
  } catch {
    return null;
  }

  const pkgJsonPath = path.join(cwdAbs, "package.json");
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scriptBody = pkg.scripts?.[scriptName];
    if (!scriptBody || typeof scriptBody !== "string") return null;
    return createHash("sha256").update(scriptBody, "utf8").digest("hex");
  } catch {
    return null;
  }
}

/**
 * Snapshot the script body for display in trust invalidation UI.
 * Returns null if not applicable.
 */
export function resolveScriptBody(
  spec: CommandSpec,
  projectRoot: string
): string | null {
  const exec = basename(spec.executable);
  const f = firstArg(spec.args);

  const isPackageRun =
    (exec === "pnpm" || exec === "npm" || exec === "yarn" || exec === "bun") &&
    f === "run" &&
    spec.args.length >= 2;

  if (!isPackageRun) return null;

  const scriptName = spec.args[1];
  if (!scriptName) return null;

  let cwdAbs: string;
  try {
    if (spec.cwdRelative === "" || spec.cwdRelative === ".") {
      cwdAbs = path.resolve(projectRoot);
    } else {
      cwdAbs = path.resolve(projectRoot, spec.cwdRelative);
    }
    if (!cwdAbs.startsWith(path.resolve(projectRoot))) return null;
  } catch {
    return null;
  }

  const pkgJsonPath = path.join(cwdAbs, "package.json");
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scriptBody = pkg.scripts?.[scriptName];
    if (!scriptBody || typeof scriptBody !== "string") return null;
    return scriptBody;
  } catch {
    return null;
  }
}

// ── Display formatting ──────────────────────────────────────────────────────

/**
 * Produce a deterministic display string for a command spec.
 * Used in approval UI and history — what the user sees is exactly what runs.
 * Never re-parsed to execute.
 */
export function formatCommandForDisplay(spec: CommandSpec): string {
  const parts = [spec.executable, ...spec.args].map((a) => {
    if (/[\s"'\\$`|&;<>(){}!]/.test(a)) {
      // Quote arguments that contain special characters (display only)
      return `"${a.replace(/"/g, '\\"')}"`;
    }
    return a;
  });
  return parts.join(" ");
}
