/**
 * eligibility.ts — centralized file access rules engine.
 *
 * ALL decisions about which files to show, read, or include in context
 * must flow through this module. The renderer never calls these directly —
 * all validation happens in the privileged main process.
 *
 * Rules (in priority order):
 * 1. Path traversal / sandbox escape  → always blocked
 * 2. Sensitive patterns (secrets)      → blocked for read/context, shown as "sensitive" in tree
 * 3. Hard-ignored directories          → hidden from tree
 * 4. Gitignore rules                   → hidden from tree (best-effort, no git binary)
 * 5. Binary file heuristic             → shown in tree, read blocked
 * 6. File too large                    → shown in tree, read truncated or blocked
 */
import path from "path";
import fs from "fs";

// ── Hard-ignore directory names ────────────────────────────────────────────

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",         // Rust/Java
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  ".nyc_output",
  "tmp",
  "temp",
  ".DS_Store",
  "Thumbs.db",
]);

// ── Sensitive filename/extension patterns ──────────────────────────────────

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(\.|$)/i,               // .env .env.local .env.production
  /^\.envrc$/i,
  /^secrets?(\.|$)/i,            // secret secret.json
  /^credentials?(\.|$)/i,
  /^auth(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /\.cer$/i,
  /\.csr$/i,
  /\.jks$/i,                     // Java keystore
  /^id_rsa$/i,
  /^id_dsa$/i,
  /^id_ecdsa$/i,
  /^id_ed25519$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^kubeconfig$/i,
  /^\.kube$/i,
  /service.?account.*\.json$/i,  // GCP service account
  /keystore.*\.json$/i,
  /firebase.*\.json$/i,
  /google.*credentials?.*\.json$/i,
  /aws.*credentials?/i,
  /\.aws\/credentials$/i,
];

// ── Size limits ────────────────────────────────────────────────────────────

/** Max bytes for a file that can be read at all */
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Max bytes included in a single context snapshot */
export const MAX_CONTEXT_BYTES = 512 * 1024; // 512 KB

/** Max bytes returned by a full file preview */
export const MAX_PREVIEW_BYTES = 256 * 1024; // 256 KB

// ── Path sandbox validation ────────────────────────────────────────────────

/**
 * Resolve a relative path against the project working directory.
 * Returns null if the result escapes the project root (path traversal attack).
 */
export function resolveProjectPath(
  workingDirectory: string,
  relativePath: string
): string | null {
  if (!relativePath) return workingDirectory;
  // Normalize and reject absolute paths
  if (path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(workingDirectory, relativePath);
  const root = path.resolve(workingDirectory);
  // Must stay within root
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  return resolved;
}

// ── Ignore / sensitive checks ──────────────────────────────────────────────

/**
 * Returns true if a directory should be completely hidden from the tree.
 */
export function isDirIgnored(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name);
}

/**
 * Returns true if a filename matches known sensitive patterns.
 */
export function isSensitive(name: string): boolean {
  return SENSITIVE_FILENAME_PATTERNS.some((re) => re.test(name));
}

// ── Binary detection ───────────────────────────────────────────────────────

/** Max bytes to scan for null bytes (binary detection probe) */
const BINARY_PROBE_BYTES = 8192;

/**
 * Returns true if the file is likely binary (non-text).
 * Uses a null-byte heuristic — fast, no external dependencies.
 */
export function isBinary(absolutePath: string): boolean {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return false;
    const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, stat.size));
    const fd = fs.openSync(absolutePath, "r");
    try {
      fs.readSync(fd, probe, 0, probe.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    // Null byte → binary
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Gitignore parsing ──────────────────────────────────────────────────────

interface GitignoreRule {
  negate: boolean;
  pattern: string;
  regex: RegExp;
}

function gitignorePatternToRegex(pattern: string): RegExp {
  // Very minimal gitignore-to-regex (covers >90% of real cases)
  let p = pattern;
  // Escape special regex chars except * and ?
  p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  p = p.replace(/\*\*/g, "DOUBLESTAR");
  p = p.replace(/\*/g, "[^/]*");
  p = p.replace(/\?/g, "[^/]");
  p = p.replace(/DOUBLESTAR/g, ".*");
  // If pattern starts with /, anchor to root
  if (p.startsWith("/")) {
    p = "^" + p.slice(1);
  } else {
    p = "(^|/)" + p;
  }
  // If pattern ends with /, match directories (we add trailing /? flexibility)
  if (p.endsWith("/")) {
    p = p + "?";
  }
  return new RegExp(p + "(/.*)?$");
}

function parseGitignore(gitignorePath: string): GitignoreRule[] {
  try {
    const lines = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/);
    const rules: GitignoreRule[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const negate = line.startsWith("!");
      const pattern = negate ? line.slice(1) : line;
      try {
        rules.push({ negate, pattern, regex: gitignorePatternToRegex(pattern) });
      } catch {
        // skip malformed pattern
      }
    }
    return rules;
  } catch {
    return [];
  }
}

/** Cached gitignore rules per directory */
const gitignoreCache = new Map<string, GitignoreRule[]>();

function getGitignoreRules(directory: string): GitignoreRule[] {
  if (gitignoreCache.has(directory)) return gitignoreCache.get(directory)!;
  const gitignorePath = path.join(directory, ".gitignore");
  const rules = parseGitignore(gitignorePath);
  gitignoreCache.set(directory, rules);
  return rules;
}

/** Evict a directory's gitignore cache (call when project changes) */
export function evictGitignoreCache(directory: string): void {
  gitignoreCache.delete(directory);
}

/**
 * Returns true if the path (relative to projectRoot) matches gitignore rules.
 * Checks .gitignore in projectRoot only (not subdirectory gitignores).
 */
export function isGitignored(projectRoot: string, relativePath: string): boolean {
  const rules = getGitignoreRules(projectRoot);
  if (rules.length === 0) return false;
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relativePath)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

// ── Language detection ─────────────────────────────────────────────────────

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", cc: "cpp",
  h: "c", hpp: "cpp", cs: "csharp", php: "php", lua: "lua",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  ps1: "powershell", sql: "sql", r: "r", m: "matlab",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass",
  less: "less", json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", svg: "xml",
  md: "markdown", mdx: "markdown", rst: "plaintext", txt: "plaintext",
  env: "plaintext", conf: "plaintext", ini: "ini", cfg: "ini",
  dockerfile: "dockerfile", makefile: "makefile", cmake: "cmake",
  graphql: "graphql", gql: "graphql", proto: "protobuf",
  tf: "terraform", tfvars: "terraform",
  vue: "vue", svelte: "svelte",
};

export function detectLanguage(filename: string): string {
  const base = path.basename(filename).toLowerCase();
  // Whole-name matches (Dockerfile, Makefile, etc.)
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base === "rakefile") return "ruby";
  if (base === "gemfile" || base === "gemfile.lock") return "ruby";
  if (base === "podfile") return "ruby";
  if (base === "cargo.toml" || base === "cargo.lock") return "toml";
  if (base === ".gitignore" || base === ".gitattributes") return "plaintext";
  if (base === "package.json" || base === "tsconfig.json") return "json";

  const ext = base.includes(".") ? base.split(".").pop() ?? "" : "";
  return EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}

// ── Token estimation ───────────────────────────────────────────────────────

/**
 * Rough token estimate (1 token ≈ 4 chars for code).
 * Good enough for UI hints — not used for hard limits.
 */
export function estimateTokens(byteSize: number): number {
  return Math.ceil(byteSize / 4);
}

// ── Eligibility result ─────────────────────────────────────────────────────

export type EligibilityStatus =
  | "ok"
  | "sensitive"
  | "binary"
  | "too_large"
  | "missing"
  | "dir"
  | "ignored";

export interface EligibilityResult {
  status: EligibilityStatus;
  absolutePath: string;
  /** Only present when status=ok or status=too_large */
  size?: number;
  language?: string;
}

/**
 * Check all eligibility rules for reading a file at the given absolute path.
 */
export function checkEligibility(
  projectRoot: string,
  absolutePath: string,
  relativePath: string
): EligibilityResult {
  // Must exist
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { status: "missing", absolutePath };
  }

  if (stat.isDirectory()) return { status: "dir", absolutePath };

  const name = path.basename(absolutePath);
  if (isSensitive(name)) return { status: "sensitive", absolutePath };
  if (isGitignored(projectRoot, relativePath)) return { status: "ignored", absolutePath, size: stat.size };
  if (isBinary(absolutePath)) return { status: "binary", absolutePath, size: stat.size };

  const language = detectLanguage(name);
  return { status: "ok", absolutePath, size: stat.size, language };
}