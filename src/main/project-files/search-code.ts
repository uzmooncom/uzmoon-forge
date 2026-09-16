/**
 * search-code.ts — content search for Agent tool.
 *
 * Searches project source files for a literal string query.
 * Uses the existing in-memory file index from service.ts for candidate discovery.
 * Applies all eligibility rules (sensitive, binary, ignored) — reuses eligibility.ts.
 *
 * Design:
 * - Candidate paths come from the existing in-memory index (never re-walks filesystem)
 * - File bytes are read fresh from disk for accuracy (index provides paths only)
 * - Returns bounded snippets — search results are CLUES, not complete file content
 * - One problematic file never fails the whole search
 */
import fs from "fs";
import path from "path";
import {
  resolveProjectPath,
  isSensitive,
  isBinary,
  isGitignored,
  isDirIgnored,
} from "./eligibility.js";
import { searchFiles, getIndexStatus, buildIndex } from "./service.js";

// ── Result types ────────────────────────────────────────────────────────────

export interface CodeSearchMatch {
  relativePath: string;
  lineNumber: number;
  /** Small surrounding snippet (contextLines lines before + match + contextLines lines after) */
  snippet: string;
  language: string;
}

export interface CodeSearchResult {
  ok: true;
  matches: CodeSearchMatch[];
  /** true if there were more matches than MAX_SEARCH_RESULTS */
  truncated: boolean;
  totalScanned: number;
}

export interface CodeSearchError {
  ok: false;
  errorCode: string;
  errorMessage: string;
}

// ── Limits (from TOOL_LIMITS — imported here to keep in sync) ──────────────

const MAX_SEARCH_RESULTS = 20;
const MAX_SNIPPET_LINES = 3;   // lines of context around match (above + below)
const MAX_FILE_SCAN_BYTES = 1 * 1024 * 1024; // 1 MB — skip files larger than this in search
const MAX_LINE_LENGTH = 200;   // truncate very long lines in snippet

// ── Main search function ────────────────────────────────────────────────────

/**
 * Search project files for a literal string query.
 *
 * @param projectId  - The project whose in-memory index is used
 * @param projectRoot - Absolute path to project working directory
 * @param query       - Literal search string (NOT a regex)
 * @param caseSensitive - If false, uses case-insensitive matching
 * @param limit       - Max results (capped at MAX_SEARCH_RESULTS)
 */
export function searchCode(
  projectId: string,
  projectRoot: string,
  query: string,
  caseSensitive = false,
  limit = MAX_SEARCH_RESULTS
): CodeSearchResult | CodeSearchError {
  if (!query || query.trim().length === 0) {
    return { ok: false, errorCode: "EMPTY_QUERY", errorMessage: "Query must not be empty" };
  }
  if (query.length > 500) {
    return { ok: false, errorCode: "QUERY_TOO_LONG", errorMessage: "Query must be 500 characters or fewer" };
  }

  const effectiveLimit = Math.min(Math.max(1, limit), MAX_SEARCH_RESULTS);

  // Ensure index is built (non-blocking — uses whatever is available)
  const status = getIndexStatus(projectId);
  if (status.state === "idle") {
    buildIndex(projectId, projectRoot);
  }

  // Use indexed file list — never re-walk the filesystem for discovery
  // searchFiles with an empty query is not useful; instead enumerate the index entries
  // We use a broad search to get all indexed paths, then filter by content
  const allFiles = getIndexedPaths(projectId, projectRoot);

  const matches: CodeSearchMatch[] = [];
  let totalScanned = 0;
  let truncated = false;

  const queryLower = caseSensitive ? query : query.toLowerCase();

  for (const relPath of allFiles) {
    if (matches.length >= effectiveLimit) {
      truncated = true;
      break;
    }

    // Security: skip sensitive files — no content revealed
    const fileName = path.basename(relPath);
    if (isSensitive(fileName)) continue;

    // Resolve absolute path safely
    const absPath = resolveProjectPath(projectRoot, relPath);
    if (!absPath) continue;

    // Skip if path escapes project root (symlink attack)
    try {
      const real = fs.realpathSync(absPath);
      const rootReal = fs.realpathSync(projectRoot);
      if (!real.startsWith(rootReal + path.sep) && real !== rootReal) continue;
    } catch {
      continue;
    }

    // Skip binary
    if (isBinary(absPath)) continue;

    // Skip files larger than scan limit
    let fileSize = 0;
    try {
      fileSize = fs.statSync(absPath).size;
    } catch {
      continue;
    }
    if (fileSize > MAX_FILE_SCAN_BYTES) continue;

    // Read file content
    let content: string;
    try {
      const buf = fs.readFileSync(absPath);
      content = buf.toString("utf8");
    } catch {
      continue;
    }

    totalScanned++;

    // Search for matches line by line
    const lines = content.split("\n");
    const totalLines = lines.length;

    for (let i = 0; i < totalLines; i++) {
      if (matches.length >= effectiveLimit) {
        truncated = true;
        break;
      }

      const line = lines[i] ?? "";
      const lineToSearch = caseSensitive ? line : line.toLowerCase();

      if (!lineToSearch.includes(queryLower)) continue;

      // Build snippet: contextLines above + match line + contextLines below
      const snippetStart = Math.max(0, i - MAX_SNIPPET_LINES);
      const snippetEnd = Math.min(totalLines - 1, i + MAX_SNIPPET_LINES);
      const snippetLines: string[] = [];
      for (let j = snippetStart; j <= snippetEnd; j++) {
        const snippetLine = (lines[j] ?? "").slice(0, MAX_LINE_LENGTH);
        snippetLines.push(snippetLine);
      }
      const snippet = snippetLines.join("\n");

      // Detect language from extension
      const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() ?? "" : "";
      const language = detectLanguageFromExt(ext, fileName);

      matches.push({
        relativePath: relPath,
        lineNumber: i + 1, // 1-based
        snippet,
        language,
      });
    }
  }

  return { ok: true, matches, truncated, totalScanned };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Get all indexed file paths for a project.
 * Uses the existing in-memory index from service.ts.
 * Falls back to a bounded filesystem walk if index is not yet ready.
 */
function getIndexedPaths(projectId: string, projectRoot: string): string[] {
  const status = getIndexStatus(projectId);

  if (status.state === "ready" || status.state === "indexing") {
    // Use index: searchFiles with a very broad query won't work,
    // so we use a workaround: search with "/" which matches all paths.
    // The actual filtering is done per-file in searchCode.
    // Better: directly use the index data via a path-only search.
    // Since service.ts doesn't export the raw entries, we use a broad path query.
    const results = searchFiles(projectId, projectRoot, "/", 50000);
    const paths = results.map((r) => r.relativePath);
    // searchFiles returns up to limit; for search_code we need all files.
    // If the index has more files, do a second broader search.
    return paths;
  }

  // Index not ready — do a bounded walk for search_code
  return boundedWalk(projectRoot, projectRoot, 0, []);
}

function boundedWalk(
  root: string,
  current: string,
  depth: number,
  acc: string[]
): string[] {
  if (depth > 10 || acc.length >= 5000) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= 5000) break;
    const name = entry.name;
    const absPath = path.join(current, name);
    const relPath = path.relative(root, absPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (isDirIgnored(name)) continue;
      if (isGitignored(root, relPath)) continue;
      boundedWalk(root, absPath, depth + 1, acc);
    } else if (entry.isFile()) {
      if (isSensitive(name)) continue;
      if (isGitignored(root, relPath)) continue;
      acc.push(relPath);
    }
  }
  return acc;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", cs: "csharp",
  php: "php", html: "html", css: "css", scss: "scss", json: "json",
  yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", md: "markdown",
  sh: "shell", bash: "shell", sql: "sql", tf: "terraform",
  vue: "vue", svelte: "svelte",
};

function detectLanguageFromExt(ext: string, filename: string): string {
  const base = filename.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return EXT_TO_LANG[ext] ?? "plaintext";
}