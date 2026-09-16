/**
 * service.ts — ProjectFileService
 *
 * All project filesystem operations that are called from IPC handlers.
 * Uses eligibility.ts as the single source of truth for ignore/sensitive/binary rules.
 * Snapshot files are stored in dataDir/snapshots/ — never inside the project folder.
 */
import path from "path";
import fs from "fs";
import { randomUUID, createHash } from "crypto";
import type {
  ProjectFileEntry,
  ContextRef,
  DirListResult,
  DirListError,
  FileReadResult,
  FileReadError,
  SnapshotResult,
  SnapshotError,
  FolderContextPreview,
} from "../../shared/types.js";
import {
  resolveProjectPath,
  isDirIgnored,
  isSensitive,
  isGitignored,
  isBinary,
  detectLanguage,
  checkEligibility,
  MAX_FILE_SIZE_BYTES,
  MAX_CONTEXT_BYTES,
  MAX_PREVIEW_BYTES,
} from "./eligibility.js";
import * as db from "../database/db.js";

// ── In-memory file index ────────────────────────────────────────────────────

interface IndexEntry {
  relativePath: string;
  name: string;
  extension: string;
  language: string;
  size: number;
  modifiedAt: number;
}

interface ProjectIndex {
  entries: IndexEntry[];
  projectRoot: string;
  builtAt: number;
  state: "idle" | "indexing" | "ready" | "error";
  error?: string;
}

const indexes = new Map<string, ProjectIndex>();

// ── Directory listing ───────────────────────────────────────────────────────

/**
 * List a single directory level within the project.
 * relativePath = "" or "." → list project root.
 */
export function listDirectory(
  projectId: string,
  projectRoot: string,
  relativePath: string
): DirListResult | DirListError {
  const absPath = resolveProjectPath(projectRoot, relativePath);
  if (!absPath) return { ok: false, error: "Path traversal detected" };

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, error: "Directory not found" };
    if (e.code === "EACCES") return { ok: false, error: "Permission denied" };
    return { ok: false, error: "Failed to list directory" };
  }

  const entries: ProjectFileEntry[] = [];
  for (const dirent of dirEntries) {
    const name = dirent.name;
    const entRelPath = relativePath
      ? relativePath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name
      : name;

    if (dirent.isDirectory()) {
      if (isDirIgnored(name)) continue;
      if (isGitignored(projectRoot, entRelPath)) continue;
      entries.push({
        name,
        relativePath: entRelPath,
        kind: "directory",
        ...(dirent.isSymbolicLink() && { isSymlink: true }),
      });
    } else if (dirent.isFile() || dirent.isSymbolicLink()) {
      const absFile = path.join(absPath, name);
      const sensitive = isSensitive(name);
      const gitignored = isGitignored(projectRoot, entRelPath);
      if (gitignored) continue; // hide gitignored files
      const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
      let size: number | undefined;
      let modifiedAt: number | undefined;
      try {
        const stat = fs.statSync(absFile);
        size = stat.size;
        modifiedAt = stat.mtimeMs;
      } catch {
        // stat failed — still include entry
      }
      entries.push({
        name,
        relativePath: entRelPath,
        kind: "file",
        ...(ext && { extension: ext }),
        ...(size !== undefined && { size }),
        ...(modifiedAt !== undefined && { modifiedAt }),
        ...(dirent.isSymbolicLink() && { isSymlink: true }),
        ...(sensitive && { isSensitive: true }),
      });
    }
  }

  // Sort: directories first, then files — both groups alphabetically
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  void projectId; // reserved for future per-project config
  return { ok: true, entries };
}

// ── File reading ────────────────────────────────────────────────────────────

/**
 * Read a file's content, applying all eligibility rules.
 * lineStart/lineEnd are 1-based inclusive.
 */
export function readFile(
  projectRoot: string,
  relativePath: string,
  lineStart?: number,
  lineEnd?: number,
  forContext = false
): FileReadResult | FileReadError {
  if (!relativePath) return { ok: false, error: "No path specified" };

  const absPath = resolveProjectPath(projectRoot, relativePath);
  if (!absPath) return { ok: false, error: "Path traversal detected" };

  const eligibility = checkEligibility(projectRoot, absPath, relativePath);

  if (eligibility.status === "missing") return { ok: false, error: "File not found" };
  if (eligibility.status === "dir") return { ok: false, error: "Path is a directory" };
  if (eligibility.status === "sensitive") return { ok: false, error: "File contains sensitive data", isSensitive: true };
  if (eligibility.status === "ignored") return { ok: false, error: "File is gitignored" };
  if (eligibility.status === "binary") return { ok: false, error: "Binary files cannot be displayed", isBinary: true };

  const fileSize = eligibility.size ?? 0;
  const maxBytes = forContext ? MAX_CONTEXT_BYTES : MAX_PREVIEW_BYTES;

  let rawBuffer: Buffer;
  try {
    rawBuffer = fs.readFileSync(absPath);
  } catch {
    return { ok: false, error: "Failed to read file" };
  }

  let content: string;
  try {
    content = rawBuffer.toString("utf8");
  } catch {
    return { ok: false, error: "File is not valid UTF-8", isBinary: true };
  }

  // If line range is specified, slice to that range
  if (lineStart !== undefined || lineEnd !== undefined) {
    const lines = content.split("\n");
    const total = lines.length;
    const start = Math.max(1, lineStart ?? 1);
    const end = Math.min(total, lineEnd ?? total);
    content = lines.slice(start - 1, end).join("\n");
  }

  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    // Truncate at maxBytes without splitting a multi-byte char
    const buf = Buffer.from(content, "utf8").slice(0, maxBytes);
    content = buf.toString("utf8") + "\n\n[... file truncated for display ...]";
    truncated = true;
  }

  const language = eligibility.language ?? detectLanguage(relativePath);
  const lineCount = content.split("\n").length;

  const result: FileReadResult = {
    ok: true,
    content,
    language,
    size: fileSize,
    truncated,
    lineCount,
  };
  if (fileSize > MAX_FILE_SIZE_BYTES) result.tooLarge = true;
  return result;
}

// ── Context snapshot ────────────────────────────────────────────────────────

/**
 * Capture a snapshot of a file (or line range) into dataDir/snapshots/<uuid>.txt.
 * Returns a ContextRef with a canonical, non-empty projectId.
 * projectId MUST be a valid project ID — never pass an empty string.
 */
export function captureSnapshot(
  projectId: string,
  projectRoot: string,
  relativePath: string,
  lineStart?: number,
  lineEnd?: number
): SnapshotResult | SnapshotError {
  if (!projectId) {
    return { ok: false, error: "captureSnapshot: projectId must be non-empty" };
  }
  const readResult = readFile(projectRoot, relativePath, lineStart, lineEnd, true);
  if (!readResult.ok) {
    return {
      ok: false,
      error: readResult.error,
      ...(readResult.isSensitive && { isSensitive: true }),
    };
  }

  const dataDir = db.getDataDir();
  const snapshotsDir = path.join(dataDir, "snapshots");
  if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

  const snapshotId = randomUUID();
  const snapshotFile = path.join(snapshotsDir, `${snapshotId}.txt`);
  const content = readResult.content;
  const contentBuf = Buffer.from(content, "utf8");
  const sizeBytes = contentBuf.byteLength;
  const contentHash = createHash("sha256").update(contentBuf).digest("hex");

  try {
    fs.writeFileSync(snapshotFile, content, "utf8");
  } catch {
    return { ok: false, error: "Failed to write snapshot" };
  }

  // Verify written content matches computed hash
  if (process.env["NODE_ENV"] === "development" || process.env["NODE_ENV"] === "test") {
    try {
      const written = fs.readFileSync(snapshotFile, "utf8");
      const writtenHash = createHash("sha256").update(Buffer.from(written, "utf8")).digest("hex");
      if (writtenHash !== contentHash) {
        return { ok: false, error: "Snapshot write integrity check failed" };
      }
    } catch {
      // Non-fatal in this path
    }
  }

  const ref: ContextRef = {
    id: snapshotId,
    projectId,
    relativePath,
    capturedAt: Date.now(),
    size: sizeBytes,
    language: readResult.language,
    snapshotPath: snapshotFile,
    contentHash,
    ...(lineStart !== undefined && { lineStart }),
    ...(lineEnd !== undefined && { lineEnd }),
  };

  return { ok: true, ref };
}

// ── Read existing snapshot ──────────────────────────────────────────────────

export function readSnapshot(snapshotPath: string): string | null {
  try {
    return fs.readFileSync(snapshotPath, "utf8");
  } catch {
    return null;
  }
}

// ── File search index ───────────────────────────────────────────────────────

const MAX_INDEX_FILES = 50_000;
/** How many directories to process per setImmediate tick during async build */
const DIRS_PER_TICK = 20;

// ── Index cache persistence ──────────────────────────────────────────────────

interface IndexCacheFile {
  version: 1;
  projectRoot: string;
  builtAt: number;
  entries: IndexEntry[];
}

function indexCachePath(projectId: string): string {
  const dataDir = db.getDataDir();
  const cacheDir = path.join(dataDir, "index-cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  // Use a sanitized projectId as filename
  const safe = projectId.replace(/[^a-zA-Z0-9-]/g, "_");
  return path.join(cacheDir, `${safe}.json`);
}

function saveIndexCache(projectId: string, idx: ProjectIndex): void {
  try {
    const cache: IndexCacheFile = {
      version: 1,
      projectRoot: idx.projectRoot,
      builtAt: idx.builtAt,
      entries: idx.entries,
    };
    fs.writeFileSync(indexCachePath(projectId), JSON.stringify(cache), "utf8");
  } catch {
    // Best-effort — cache write failure is non-fatal
  }
}

/**
 * Load cached index entries, validating each entry's mtime against disk.
 * Entries whose mtime no longer matches are dropped (will be re-indexed).
 * Returns null if cache is missing, corrupt, or stale (wrong projectRoot).
 */
function loadIndexCache(
  projectId: string,
  projectRoot: string
): IndexEntry[] | null {
  try {
    const raw = fs.readFileSync(indexCachePath(projectId), "utf8");
    const cache = JSON.parse(raw) as IndexCacheFile;
    if (cache.version !== 1) return null;
    if (path.resolve(cache.projectRoot) !== path.resolve(projectRoot)) return null;

    // Validate mtime for each cached entry — drop stale/missing ones
    const valid: IndexEntry[] = [];
    for (const entry of cache.entries) {
      try {
        const absPath = path.join(projectRoot, entry.relativePath);
        const stat = fs.statSync(absPath);
        if (Math.abs(stat.mtimeMs - entry.modifiedAt) < 2) {
          // mtime matches within 2ms tolerance (FAT32 has 2s granularity but we
          // only target modern filesystems; use 2ms to catch float rounding)
          valid.push(entry);
        }
        // else: file modified since cache — drop, will be re-indexed
      } catch {
        // File deleted since cache — drop
      }
    }
    return valid;
  } catch {
    return null;
  }
}

// ── Recursive index walk helpers ─────────────────────────────────────────────

function collectDirFiles(
  root: string,
  dirPath: string,
  entries: IndexEntry[],
  pendingDirs: string[],
  count: { n: number }
): void {
  if (count.n >= MAX_INDEX_FILES) return;
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirEntries) {
    if (count.n >= MAX_INDEX_FILES) break;
    const name = dirent.name;
    const absPath = path.join(dirPath, name);
    const relPath = path.relative(root, absPath).replace(/\\/g, "/");

    if (dirent.isDirectory()) {
      if (isDirIgnored(name)) continue;
      if (isGitignored(root, relPath)) continue;
      pendingDirs.push(absPath);
    } else if (dirent.isFile()) {
      if (isSensitive(name)) continue;
      if (isGitignored(root, relPath)) continue;
      const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
      let size = 0;
      let modifiedAt = 0;
      try {
        const stat = fs.statSync(absPath);
        size = stat.size;
        modifiedAt = stat.mtimeMs;
      } catch {
        // skip
      }
      entries.push({ relativePath: relPath, name, extension: ext, language: detectLanguage(name), size, modifiedAt });
      count.n++;
    }
  }
}

/**
 * Build the in-memory index asynchronously — yields every DIRS_PER_TICK
 * directories so the Electron main thread is never blocked for more than
 * a few milliseconds at a time.
 *
 * Uses the persistent cache for validation: entries whose mtime matches
 * the cached value are reused without re-reading, making restarts fast.
 *
 * If the index is already being built (state === "indexing"), returns
 * immediately — only one build per project runs at a time.
 */
export function buildIndex(projectId: string, projectRoot: string): void {
  const existing = indexes.get(projectId);
  if (existing?.state === "indexing") return;

  // Seed with validated cache entries so searches can start immediately
  const cachedEntries = loadIndexCache(projectId, projectRoot) ?? [];

  const idx: ProjectIndex = {
    entries: [...cachedEntries],
    projectRoot,
    builtAt: 0,
    // Mark ready immediately with cached data so code search can begin;
    // we'll overwrite entries once the full async walk finishes
    state: cachedEntries.length > 0 ? "ready" : "indexing",
  };
  indexes.set(projectId, idx);

  // Async walk — yields to event loop every DIRS_PER_TICK directories
  const freshEntries: IndexEntry[] = [];
  const count = { n: 0 };
  const pendingDirs: string[] = [projectRoot];

  // Mark indexing for full rebuild pass
  idx.state = "indexing";

  function tick(): void {
    // Process a batch of directories per tick
    let processed = 0;
    while (pendingDirs.length > 0 && processed < DIRS_PER_TICK) {
      const dir = pendingDirs.shift()!;
      collectDirFiles(projectRoot, dir, freshEntries, pendingDirs, count);
      processed++;
    }

    if (pendingDirs.length === 0 || count.n >= MAX_INDEX_FILES) {
      // Walk complete — commit fresh entries
      idx.entries = freshEntries;
      idx.state = "ready";
      idx.builtAt = Date.now();
      // Persist to disk for fast restart
      saveIndexCache(projectId, idx);
    } else {
      // Yield to event loop, then continue
      setImmediate(tick);
    }
  }

  // Kick off first tick on next event loop iteration
  setImmediate(tick);
}

export function getIndexStatus(projectId: string): {
  state: "idle" | "indexing" | "ready" | "error";
  fileCount?: number;
  lastIndexedAt?: number;
  error?: string;
} {
  const idx = indexes.get(projectId);
  if (!idx) return { state: "idle" };
  const out: { state: "idle" | "indexing" | "ready" | "error"; fileCount?: number; lastIndexedAt?: number; error?: string } = {
    state: idx.state,
    fileCount: idx.entries.length,
  };
  if (idx.builtAt) out.lastIndexedAt = idx.builtAt;
  if (idx.error) out.error = idx.error;
  return out;
}

export function evictIndex(projectId: string): void {
  indexes.delete(projectId);
}

/**
 * Return all indexed relative paths for a project.
 * Used by search-code.ts instead of the old searchFiles("/") hack.
 * If the index is not yet built, triggers an async build and returns
 * whatever is available so far (cached entries or empty).
 */
export function getAllIndexedPaths(
  projectId: string,
  projectRoot: string
): string[] {
  let idx = indexes.get(projectId);
  if (!idx) {
    // Trigger async build — will return cached entries immediately
    buildIndex(projectId, projectRoot);
    idx = indexes.get(projectId);
  }
  if (!idx || idx.entries.length === 0) return [];
  return idx.entries.map((e) => e.relativePath);
}

/**
 * Search the in-memory index for files matching the query.
 * Query is matched against filename and relativePath (case-insensitive).
 * If the index is not yet built, triggers an async build first.
 */
export function searchFiles(
  projectId: string,
  projectRoot: string,
  query: string,
  limit = 50
): ProjectFileEntry[] {
  let idx = indexes.get(projectId);
  if (!idx) {
    buildIndex(projectId, projectRoot);
    idx = indexes.get(projectId);
  }
  if (!idx || idx.entries.length === 0) return [];

  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results: Array<{ entry: IndexEntry; score: number }> = [];
  for (const entry of idx.entries) {
    const nameLower = entry.name.toLowerCase();
    const pathLower = entry.relativePath.toLowerCase();
    // Scoring: exact name match > name contains > path contains
    if (nameLower === q) {
      results.push({ entry, score: 100 });
    } else if (nameLower.startsWith(q)) {
      results.push({ entry, score: 80 });
    } else if (nameLower.includes(q)) {
      results.push({ entry, score: 60 });
    } else if (pathLower.includes(q)) {
      results.push({ entry, score: 40 });
    }
  }

  results.sort((a, b) => b.score - a.score || a.entry.relativePath.localeCompare(b.entry.relativePath));

  return results.slice(0, limit).map((r): ProjectFileEntry => {
    const e: ProjectFileEntry = {
      name: r.entry.name,
      relativePath: r.entry.relativePath,
      kind: "file",
      size: r.entry.size,
      modifiedAt: r.entry.modifiedAt,
    };
    if (r.entry.extension) e.extension = r.entry.extension;
    return e;
  });
}

// ── Folder context preview ──────────────────────────────────────────────────

/**
 * Preview what files would be included if a folder was added as context.
 * Does NOT capture snapshots — just returns metadata for UI confirmation.
 */
export function folderContextPreview(
  projectRoot: string,
  relativePath: string
): FolderContextPreview | { ok: false; error: string } {
  const absPath = resolveProjectPath(projectRoot, relativePath);
  if (!absPath) return { ok: false, error: "Path traversal detected" };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { ok: false, error: "Path not found" };
  }
  if (!stat.isDirectory()) return { ok: false, error: "Path is not a directory" };

  const included: ProjectFileEntry[] = [];
  let skippedIgnored = 0;
  let skippedBinary = 0;
  let skippedSensitive = 0;
  let skippedTooLarge = 0;
  let totalSize = 0;
  const MAX_FOLDER_FILES = 200;

  function walk(dir: string, relDir: string): void {
    if (included.length >= MAX_FOLDER_FILES) return;
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirEntries) {
      if (included.length >= MAX_FOLDER_FILES) break;
      const name = dirent.name;
      const relPath = relDir ? `${relDir}/${name}` : name;
      const absFile = path.join(dir, name);

      if (dirent.isDirectory()) {
        if (isDirIgnored(name) || isGitignored(projectRoot, relPath)) { skippedIgnored++; continue; }
        walk(absFile, relPath);
      } else if (dirent.isFile()) {
        if (isSensitive(name)) { skippedSensitive++; continue; }
        if (isGitignored(projectRoot, relPath)) { skippedIgnored++; continue; }
        if (isBinary(absFile)) { skippedBinary++; continue; }

        let size = 0;
        let modifiedAt = 0;
        try {
          const s = fs.statSync(absFile);
          size = s.size;
          modifiedAt = s.mtimeMs;
        } catch { continue; }

        if (size > MAX_FILE_SIZE_BYTES) { skippedTooLarge++; continue; }

        totalSize += size;
        const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
        const fe: ProjectFileEntry = { name, relativePath: relPath, kind: "file", size, modifiedAt };
        if (ext) fe.extension = ext;
        included.push(fe);
      }
    }
  }

  walk(absPath, relativePath);

  return { ok: true, relativePath, includedFiles: included, skippedIgnored, skippedBinary, skippedSensitive, skippedTooLarge, totalSize };
}

// ── Gitignore cache eviction (call when project dir changes) ────────────────
// evictGitignoreCache and evictIndex are both already directly exported above