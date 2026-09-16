/**
 * edit-service.ts — Safe File Editing domain logic (V0.3)
 *
 * All filesystem mutations are gated behind explicit user approval.
 * The pipeline: parse → verify base → capture target → preflight → atomic write → backup.
 *
 * Invariants:
 * - The model NEVER supplies trusted hashes. Only main-process-computed hashes are trusted.
 * - Every MODIFY requires exactly one full-file ContextRef for the target path.
 * - Temp files live in the same directory as the target for atomic rename.
 * - Content written to disk == content the user reviewed (verified post-write).
 * - All failures produce explicit rollback; no orphaned temp files remain.
 */
import { randomUUID, createHash } from "crypto";
import fs from "fs";
import path from "path";
import type {
  ContextRef,
  EditProposal,
  FileEdit,
  WriteJournalEntry,
  PreflightResult,
} from "../../shared/types.js";
import { resolveProjectPath, checkEligibility } from "./eligibility.js";
import * as db from "../database/db.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Max bytes of proposed content for a single file (512 KB) */
const MAX_CONTEXT_BYTES = 512 * 1024;

// ── Utility ────────────────────────────────────────────────────────────────

function sha256hex(content: string | Buffer): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha256").update(buf).digest("hex");
}

// ── Parse proposal fence ───────────────────────────────────────────────────

interface RawFileEdit {
  path: string;
  content: string;
}

interface ParsedProposal {
  type: string;
  summary: string;
  explanation: string | undefined;
  files: RawFileEdit[];
}

/**
 * Extract the first ```forge_edit_proposal ... ``` fence from a model response.
 * Returns the raw fence JSON string, or null if none found.
 */
export function extractProposalFence(fullText: string): string | null {
  const fenceRe = /```forge_edit_proposal\s*\n([\s\S]*?)```/;
  const m = fenceRe.exec(fullText);
  if (!m) return null;
  return m[1]?.trim() ?? null;
}

/**
 * Strip the forge_edit_proposal fence from a message body.
 * The fence block is stored separately in EditProposal.rawProposalJson.
 */
export function stripProposalFence(fullText: string): string {
  return fullText.replace(/```forge_edit_proposal\s*\n[\s\S]*?```/g, "").trim();
}

/**
 * Parse the raw JSON from a forge_edit_proposal fence.
 * Returns null on parse failure or schema mismatch.
 */
export function parseProposalJson(raw: string): ParsedProposal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["summary"] !== "string") return null;
  if (!Array.isArray(obj["files"])) return null;
  const files: RawFileEdit[] = [];
  for (const f of obj["files"] as unknown[]) {
    if (!f || typeof f !== "object") return null;
    const fe = f as Record<string, unknown>;
    if (typeof fe["path"] !== "string" || typeof fe["content"] !== "string") return null;
    // Normalize path: no leading slash, forward slashes
    const relPath = (fe["path"] as string).replace(/\\/g, "/").replace(/^\/+/, "");
    if (!relPath) return null;
    const content = fe["content"] as string;
    if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_BYTES) {
      // Content too large — skip or truncate (we skip to be safe)
      continue;
    }
    files.push({ path: relPath, content });
  }
  if (files.length === 0) return null;
  return {
    type: typeof obj["type"] === "string" ? obj["type"] : "modify",
    summary: obj["summary"] as string,
    explanation: typeof obj["explanation"] === "string" ? obj["explanation"] : undefined,
    files,
  };
}

// ── Resource storage helpers ───────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write the proposed content for a FileEdit into dataDir/proposals/<proposalId>/<fileEditId>.txt
 * Returns the absolute resource path and its SHA-256 hash.
 */
export function captureProposalTarget(
  proposalId: string,
  fileEditId: string,
  content: string
): { ok: true; resourcePath: string; contentHash: string } | { ok: false; error: string } {
  const dataDir = db.getDataDir();
  const proposalDir = path.join(dataDir, "proposals", proposalId);
  ensureDir(proposalDir);
  const resourcePath = path.join(proposalDir, `${fileEditId}.txt`);
  try {
    fs.writeFileSync(resourcePath, content, "utf8");
  } catch {
    return { ok: false, error: "Failed to write proposal target resource" };
  }
  const contentHash = sha256hex(content);
  return { ok: true, resourcePath, contentHash };
}

/**
 * Read a proposal target resource file.
 * Returns null if missing.
 */
export function readProposalTarget(resourcePath: string): string | null {
  // Security: must be inside dataDir/proposals/
  const dataDir = db.getDataDir();
  const proposalsDir = path.resolve(path.join(dataDir, "proposals"));
  const resolved = path.resolve(resourcePath);
  if (!resolved.startsWith(proposalsDir + path.sep)) return null;
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

/**
 * Create a backup of a file before applying an edit.
 * Backup stored at dataDir/backups/<appliedEditId>.txt
 */
export function createBackupSnapshot(
  appliedEditId: string,
  sourceAbsPath: string
): { ok: true; backupPath: string; contentHash: string } | { ok: false; error: string } {
  let content: string;
  try {
    content = fs.readFileSync(sourceAbsPath, "utf8");
  } catch {
    return { ok: false, error: "Failed to read source file for backup" };
  }
  const dataDir = db.getDataDir();
  const backupsDir = path.join(dataDir, "backups");
  ensureDir(backupsDir);
  const backupPath = path.join(backupsDir, `${appliedEditId}.txt`);
  try {
    fs.writeFileSync(backupPath, content, "utf8");
  } catch {
    return { ok: false, error: "Failed to write backup file" };
  }
  const contentHash = sha256hex(content);
  return { ok: true, backupPath, contentHash };
}

/**
 * Read a backup file (for undo or historical diff).
 * Returns null if missing or outside backups dir.
 */
export function readBackup(backupPath: string): string | null {
  const dataDir = db.getDataDir();
  const backupsDir = path.resolve(path.join(dataDir, "backups"));
  const resolved = path.resolve(backupPath);
  if (!resolved.startsWith(backupsDir + path.sep)) return null;
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

// ── ContextRef resolution ──────────────────────────────────────────────────

/**
 * Resolve the single ContextRef that should serve as the base for a MODIFY edit.
 *
 * Resolution rules (from V0.3 plan):
 * - Only look in item.contextRefs from the originating request
 * - Filter: projectId must match, relativePath must match (normalized), lineStart/lineEnd undefined, contentHash non-empty
 * - 0 matches → needs_context
 * - 1 match → proceed (verify)
 * - 2+ matches → ambiguous_context
 */
export function resolveContextRef(
  contextRefs: ContextRef[],
  projectId: string,
  relativePath: string
): { status: "ok"; ref: ContextRef } | { status: "needs_context" } | { status: "ambiguous_context" } {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const matches = contextRefs.filter(
    (r) =>
      r.projectId === projectId &&
      r.relativePath.replace(/\\/g, "/").replace(/^\/+/, "") === normalized &&
      r.lineStart === undefined &&
      r.lineEnd === undefined &&
      r.contentHash &&
      r.contentHash.length > 0
  );
  if (matches.length === 0) return { status: "needs_context" };
  if (matches.length > 1) return { status: "ambiguous_context" };
  return { status: "ok", ref: matches[0]! };
}

/**
 * Verify a ContextRef's snapshot against its stored hash.
 * This re-reads the snapshot file and checks the hash.
 *
 * - Missing snapshot → needs_context (not an integrity failure; file may have been swept)
 * - Hash mismatch → failed (snapshot was tampered)
 * - Match → ok, returns the verified hash
 */
export function verifyBaseSnapshot(
  ref: ContextRef
): { ok: true; verifiedHash: string } | { ok: false; status: "needs_context" | "failed"; reason: string } {
  let content: string;
  try {
    content = fs.readFileSync(ref.snapshotPath, "utf8");
  } catch {
    return {
      ok: false,
      status: "needs_context",
      reason: `Base snapshot for "${ref.relativePath}" is no longer available. Please re-add the file to context.`,
    };
  }
  const actualHash = sha256hex(content);
  if (actualHash !== ref.contentHash) {
    return {
      ok: false,
      status: "failed",
      reason: `Base snapshot integrity check failed for "${ref.relativePath}": content has been modified since capture.`,
    };
  }
  return { ok: true, verifiedHash: actualHash };
}

// ── Compute current file hash ──────────────────────────────────────────────

/**
 * Read the current content of a project file and compute its SHA-256 hash.
 * Returns null if the file cannot be read.
 */
export function computeCurrentHash(
  projectRoot: string,
  relativePath: string
): { ok: true; hash: string; content: string } | { ok: false; error: string } {
  const absPath = resolveProjectPath(projectRoot, relativePath);
  if (!absPath) return { ok: false, error: "Path traversal detected" };
  try {
    const content = fs.readFileSync(absPath, "utf8");
    return { ok: true, hash: sha256hex(content), content };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, error: "File not found" };
    return { ok: false, error: "Failed to read file" };
  }
}

// ── Eligibility check for editing ─────────────────────────────────────────

/**
 * Check whether a file path is eligible for editing.
 * Returns ok=true if the file can be modified, or ok=false with a reason.
 */
export function isEditEligible(
  projectRoot: string,
  relativePath: string
): { ok: true } | { ok: false; reason: string } {
  const absPath = resolveProjectPath(projectRoot, relativePath);
  if (!absPath) return { ok: false, reason: "Path traversal detected" };
  const eligibility = checkEligibility(projectRoot, absPath, relativePath);
  if (eligibility.status === "sensitive") return { ok: false, reason: "File contains sensitive data and cannot be edited" };
  if (eligibility.status === "binary") return { ok: false, reason: "Binary files cannot be edited" };
  if (eligibility.status === "dir") return { ok: false, reason: "Path is a directory, not a file" };
  if (eligibility.status === "missing") return { ok: false, reason: "File not found" };
  if (eligibility.status === "ignored") return { ok: false, reason: "File is gitignored" };
  return { ok: true };
}

// ── Atomic write ──────────────────────────────────────────────────────────

/**
 * Write content to a project file atomically using a temp file + rename.
 *
 * Steps:
 * 1. Validate target path eligibility
 * 2. Verify reviewedTargetHash matches the proposal resource (pre-write integrity)
 * 3. Write to temp file (same dir as target for atomic rename)
 * 4. Journal the temp file path (crash recovery)
 * 5. fsync + close temp file
 * 6. Rename temp → target (atomic on POSIX)
 * 7. Remove journal entry
 * 8. Verify post-write hash matches expected
 *
 * Returns the actual SHA-256 hash of the written content on success.
 */
export function writeFileAtomic(
  projectRoot: string,
  targetRelativePath: string,
  content: string,
  reviewedTargetHash: string
): { ok: true; actualHash: string } | { ok: false; error: string } {
  // 1. Validate target path
  const targetAbsPath = resolveProjectPath(projectRoot, targetRelativePath);
  if (!targetAbsPath) return { ok: false, error: "Path traversal detected" };

  // 2. Verify the content hash matches what was reviewed
  const contentHash = sha256hex(content);
  if (contentHash !== reviewedTargetHash) {
    return { ok: false, error: "Proposal resource integrity mismatch — content changed since review" };
  }

  // 3. Write to temp file in same directory as target
  const targetDir = path.dirname(targetAbsPath);
  const tempId = randomUUID().replace(/-/g, "").slice(0, 8);
  const tempFilename = `.forge-tmp-${tempId}`;
  const tempAbsPath = path.join(targetDir, tempFilename);
  const tempRelativePath = path.relative(projectRoot, tempAbsPath).replace(/\\/g, "/");

  // 4. Journal the temp file (crash recovery)
  const journalEntry: WriteJournalEntry = {
    id: randomUUID(),
    projectId: "", // filled by caller via context — kept "" here for generic function
    tempRelativePath,
    targetRelativePath,
    createdAt: Date.now(),
  };
  db.addWriteJournalEntry(true, journalEntry);

  try {
    // Write content using low-level fd for fsync
    const fd = fs.openSync(tempAbsPath, "w", 0o644);
    try {
      fs.writeSync(fd, content, 0, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // 6. Atomic rename
    fs.renameSync(tempAbsPath, targetAbsPath);

    // 7. Remove journal entry (rename succeeded)
    db.removeWriteJournalEntry(true, journalEntry.id);

    // 8. Verify post-write hash
    let writtenContent: string;
    try {
      writtenContent = fs.readFileSync(targetAbsPath, "utf8");
    } catch {
      return { ok: false, error: "Post-write verification read failed" };
    }
    const actualHash = sha256hex(writtenContent);
    if (actualHash !== contentHash) {
      return { ok: false, error: "Post-write integrity check failed — written content does not match" };
    }

    return { ok: true, actualHash };
  } catch (err) {
    // Cleanup: remove journal entry and temp file (best effort)
    db.removeWriteJournalEntry(true, journalEntry.id);
    try { if (fs.existsSync(tempAbsPath)) fs.unlinkSync(tempAbsPath); } catch { /* best effort */ }
    const e = err as NodeJS.ErrnoException;
    return { ok: false, error: `Write failed: ${e.message}` };
  }
}

/**
 * Overload of writeFileAtomic that also journals the projectId.
 * Used by the IPC handler which has the projectId available.
 */
export function writeFileAtomicWithProject(
  projectRoot: string,
  projectId: string,
  targetRelativePath: string,
  content: string,
  reviewedTargetHash: string
): { ok: true; actualHash: string } | { ok: false; error: string } {
  // Delegate to writeFileAtomic — we patch the journal entry's projectId
  const targetAbsPath = resolveProjectPath(projectRoot, targetRelativePath);
  if (!targetAbsPath) return { ok: false, error: "Path traversal detected" };

  const contentHash = sha256hex(content);
  if (contentHash !== reviewedTargetHash) {
    return { ok: false, error: "Proposal resource integrity mismatch — content changed since review" };
  }

  const targetDir = path.dirname(targetAbsPath);
  const tempId = randomUUID().replace(/-/g, "").slice(0, 8);
  const tempFilename = `.forge-tmp-${tempId}`;
  const tempAbsPath = path.join(targetDir, tempFilename);
  const tempRelativePath = path.relative(projectRoot, tempAbsPath).replace(/\\/g, "/");

  const journalEntry: WriteJournalEntry = {
    id: randomUUID(),
    projectId,
    tempRelativePath,
    targetRelativePath,
    createdAt: Date.now(),
  };
  db.addWriteJournalEntry(true, journalEntry);

  try {
    const fd = fs.openSync(tempAbsPath, "w", 0o644);
    try {
      fs.writeSync(fd, content, 0, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempAbsPath, targetAbsPath);
    db.removeWriteJournalEntry(true, journalEntry.id);

    let writtenContent: string;
    try {
      writtenContent = fs.readFileSync(targetAbsPath, "utf8");
    } catch {
      return { ok: false, error: "Post-write verification read failed" };
    }
    const actualHash = sha256hex(writtenContent);
    if (actualHash !== contentHash) {
      return { ok: false, error: "Post-write integrity check failed" };
    }
    return { ok: true, actualHash };
  } catch (err) {
    db.removeWriteJournalEntry(true, journalEntry.id);
    try { if (fs.existsSync(tempAbsPath)) fs.unlinkSync(tempAbsPath); } catch { /* best effort */ }
    const e = err as NodeJS.ErrnoException;
    return { ok: false, error: `Write failed: ${e.message}` };
  }
}

// ── Restore from backup (undo) ─────────────────────────────────────────────

/**
 * Restore a file to its pre-apply state from a backup.
 * Returns the hash of the restored content.
 */
export function restoreFromBackup(
  projectRoot: string,
  projectId: string,
  targetRelativePath: string,
  backupPath: string,
  expectedBackupHash: string
): { ok: true; restoredHash: string } | { ok: false; error: string } {
  const backupContent = readBackup(backupPath);
  if (backupContent === null) return { ok: false, error: "Backup file not found or outside backup directory" };

  // Verify backup integrity before restoring
  const backupHash = sha256hex(backupContent);
  if (backupHash !== expectedBackupHash) {
    return { ok: false, error: "Backup integrity check failed — cannot restore safely" };
  }

  // Use the full atomic writer for the restore as well
  const result = writeFileAtomicWithProject(
    projectRoot,
    projectId,
    targetRelativePath,
    backupContent,
    backupHash
  );
  if (!result.ok) return result;
  return { ok: true, restoredHash: result.actualHash };
}

// ── Write journal sweep ────────────────────────────────────────────────────

/**
 * Sweep the write journal on startup.
 * Any temp file that was left behind by a crash is deleted here.
 *
 * Validation:
 * - projectId must map to a real project in the DB
 * - tempRelativePath must be inside the project root
 * - tempFilename must start with ".forge-tmp-"
 * - temp must be in the same parent dir as target
 *
 * Best-effort: never throws.
 */
export function sweepWriteJournal(): void {
  let entries: ReturnType<typeof db.listWriteJournalEntries>;
  try {
    entries = db.listWriteJournalEntries(true);
  } catch {
    return;
  }

  for (const entry of entries) {
    try {
      // Validate projectId
      const project = db.getProject(true, entry.projectId);
      if (!project) {
        // Unknown project — remove journal entry only (can't find root)
        db.removeWriteJournalEntry(true, entry.id);
        continue;
      }
      const projectRoot = project.workingDirectory;

      // Validate temp path is inside project root
      const tempAbsPath = path.resolve(path.join(projectRoot, entry.tempRelativePath));
      if (!tempAbsPath.startsWith(path.resolve(projectRoot) + path.sep)) {
        db.removeWriteJournalEntry(true, entry.id);
        continue;
      }

      // Validate temp filename starts with ".forge-tmp-"
      const tempBasename = path.basename(tempAbsPath);
      if (!tempBasename.startsWith(".forge-tmp-")) {
        db.removeWriteJournalEntry(true, entry.id);
        continue;
      }

      // Validate temp is in same parent dir as target
      const targetAbsPath = path.resolve(path.join(projectRoot, entry.targetRelativePath));
      if (path.dirname(tempAbsPath) !== path.dirname(targetAbsPath)) {
        db.removeWriteJournalEntry(true, entry.id);
        continue;
      }

      // Delete the temp file (best effort)
      try {
        if (fs.existsSync(tempAbsPath)) fs.unlinkSync(tempAbsPath);
      } catch { /* best effort */ }

      db.removeWriteJournalEntry(true, entry.id);
    } catch {
      // Best effort per entry
      try { db.removeWriteJournalEntry(true, entry.id); } catch { /* skip */ }
    }
  }
}

// ── Diff stats ────────────────────────────────────────────────────────────

export interface DiffStats {
  linesAdded: number;
  linesRemoved: number;
  linesUnchanged: number;
}

/**
 * Compute line-level diff statistics between base and proposed content.
 * Simple LCS-free approach: split into lines, count additions/removals.
 */
export function computeDiffStats(baseContent: string, proposedContent: string): DiffStats {
  const baseLines = new Set(baseContent.split("\n"));
  const propLines = new Set(proposedContent.split("\n"));
  const baseArr = baseContent.split("\n");
  const propArr = proposedContent.split("\n");

  const inBoth = new Set<string>();
  for (const line of baseLines) {
    if (propLines.has(line)) inBoth.add(line);
  }

  let linesAdded = 0;
  let linesRemoved = 0;
  let linesUnchanged = 0;

  // Count by membership (approximate — not a real diff, but good enough for stats)
  for (const line of propArr) {
    if (baseLines.has(line)) linesUnchanged++;
    else linesAdded++;
  }
  for (const line of baseArr) {
    if (!propLines.has(line)) linesRemoved++;
  }

  return { linesAdded, linesRemoved, linesUnchanged };
}

// ── Proposal + assistant message persistence (consistency-safe) ────────────

/**
 * Save an assistant message with its associated EditProposal.
 *
 * Consistency-safe 4-step sequence with per-step rollback:
 * Step 1: Persist the assistant message (content = fullText with fence stripped)
 * Step 2: Persist the EditProposal (with fileEdits)
 * Step 3: Update the message to link to the proposal (proposalId on message)
 * Step 4: Return {message, proposal}
 *
 * On any failure, explicit rollback ensures we end in either:
 *   (A) message with proposalId = proposal.id + proposal in DB
 *   (B) message with proposalId = null + no orphan proposal in DB
 *
 * Note: ChatMessage doesn't have a proposalId field natively.
 * We store it as a custom field in the message and also expose it
 * via the proposal's messageId back-reference.
 */
export interface SaveProposalResult {
  message: import("../../shared/types.js").ChatMessage;
  proposal: EditProposal;
}

export function saveAssistantMessageWithProposal(opts: {
  conversationId: string;
  projectId: string;
  agentProfileId: string;
  agentNameSnapshot: string;
  modelSnapshot: string;
  fullText: string;
  rawProposalJson: string;
  parsedProposal: import("./edit-service.js").ParsedProposalForSave;
  requestContextRefs: ContextRef[];
  durationMs: number;
}): SaveProposalResult | null {
  const {
    conversationId,
    projectId,
    agentProfileId,
    agentNameSnapshot,
    modelSnapshot,
    fullText,
    rawProposalJson,
    parsedProposal,
    requestContextRefs,
    durationMs,
  } = opts;

  const msgId = randomUUID();
  const proposalId = randomUUID();
  const now = Date.now();

  // Strip the fence from the displayed message content
  const displayContent = stripProposalFence(fullText);

  // Step 1: Build and persist the assistant message
  const assistantMsg: import("../../shared/types.js").ChatMessage = {
    id: msgId,
    conversationId,
    role: "assistant",
    content: displayContent,
    createdAt: now,
    model: modelSnapshot,
    durationMs,
    agentProfileId,
    agentNameSnapshot,
    modelSnapshot,
    // Embed proposalId as extension field — stored as part of the message object
    ...({ proposalId } as Record<string, unknown>),
  };
  db.insertMessage(true, assistantMsg as import("../../shared/types.js").ChatMessage);

  // Step 2: Build FileEdits — capture target resources and resolve ContextRefs
  const fileEdits: FileEdit[] = [];
  for (const rawFile of parsedProposal.files) {
    const feId = randomUUID();
    const targetResult = captureProposalTarget(proposalId, feId, rawFile.content);
    if (!targetResult.ok) {
      // Rollback step 1
      db.deleteMessage(true, conversationId, msgId);
      return null;
    }

    // Resolve ContextRef for this file
    const resolution = resolveContextRef(requestContextRefs, projectId, rawFile.path);
    let status: import("../../shared/types.js").FileEditStatus;
    let failureReason: string | undefined;
    let baseSnapshotId: string | undefined;
    let baseContentHash: string | undefined;

    if (resolution.status === "needs_context") {
      status = "needs_context";
      failureReason = `No full-file context was provided for "${rawFile.path}". Add the file to context and retry.`;
    } else if (resolution.status === "ambiguous_context") {
      status = "ambiguous_context";
      failureReason = `Multiple context snapshots found for "${rawFile.path}". Remove duplicates and retry.`;
    } else {
      // Verify the base snapshot integrity
      const verification = verifyBaseSnapshot(resolution.ref);
      if (!verification.ok) {
        status = verification.status === "needs_context" ? "needs_context" : "failed";
        failureReason = verification.reason;
      } else {
        status = "ready";
        baseSnapshotId = resolution.ref.id;
        baseContentHash = resolution.ref.contentHash;
      }
    }

    const fe: FileEdit = {
      id: feId,
      proposalId,
      relativePath: rawFile.path,
      targetResourcePath: targetResult.resourcePath,
      targetContentHash: targetResult.contentHash,
      status,
      ...(failureReason !== undefined && { failureReason }),
      ...(baseSnapshotId !== undefined && { baseSnapshotId }),
      ...(baseContentHash !== undefined && { baseContentHash }),
      createdAt: now,
      updatedAt: now,
    };
    fileEdits.push(fe);
  }

  // Compute overall proposal status from file edits
  const overallStatus = computeProposalStatus(fileEdits);

  // Step 3: Build and persist the proposal
  const proposal: EditProposal = {
    id: proposalId,
    conversationId,
    messageId: msgId,
    projectId,
    status: overallStatus,
    summary: parsedProposal.summary,
    ...(parsedProposal.explanation !== undefined && { explanation: parsedProposal.explanation }),
    rawProposalJson,
    fileEdits,
    createdAt: now,
    updatedAt: now,
  };

  try {
    db.saveProposal(true, proposal);
  } catch {
    // Rollback step 1
    db.deleteMessage(true, conversationId, msgId);
    // Clean up proposal target resource files (best effort)
    cleanupProposalResources(proposalId, fileEdits);
    return null;
  }

  return { message: assistantMsg, proposal };
}

/** Public type alias for the ParsedProposal used by saveAssistantMessageWithProposal */
export interface ParsedProposalForSave {
  summary: string;
  explanation?: string;
  files: Array<{ path: string; content: string }>;
}

/**
 * Compute the overall EditProposalStatus from its FileEdits.
 */
export function computeProposalStatus(
  fileEdits: FileEdit[]
): import("../../shared/types.js").EditProposalStatus {
  if (fileEdits.length === 0) return "failed";
  if (fileEdits.every((f) => f.status === "applied")) return "applied";
  if (fileEdits.some((f) => f.status === "applied") && fileEdits.some((f) => f.status !== "applied" && f.status !== "rejected")) return "partiallyApplied";
  if (fileEdits.some((f) => f.status === "needs_context")) return "needs_context";
  if (fileEdits.some((f) => f.status === "ambiguous_context")) return "ambiguous_context";
  if (fileEdits.some((f) => f.status === "stale")) return "stale";
  if (fileEdits.some((f) => f.status === "failed")) return "failed";
  if (fileEdits.some((f) => f.status === "missing")) return "failed";
  if (fileEdits.every((f) => f.status === "rejected")) return "rejected";
  return "ready";
}

/**
 * Clean up proposal resource files (best effort).
 * Used for rollback — removes files from dataDir/proposals/<proposalId>/
 */
function cleanupProposalResources(proposalId: string, fileEdits: FileEdit[]): void {
  const dataDir = db.getDataDir();
  const proposalDir = path.join(dataDir, "proposals", proposalId);
  for (const fe of fileEdits) {
    try {
      if (fs.existsSync(fe.targetResourcePath)) fs.unlinkSync(fe.targetResourcePath);
    } catch { /* best effort */ }
  }
  try {
    if (fs.existsSync(proposalDir)) fs.rmdirSync(proposalDir);
  } catch { /* not empty or doesn't exist */ }
}

/**
 * Preflight check for a set of selected FileEdit IDs.
 * Checks:
 * 1. FileEdit is in "ready" status
 * 2. Proposal target resource exists and hash matches
 * 3. Current file on disk has hash matching baseContentHash (stale detection)
 *
 * Returns a PreflightResult per file. Does NOT write anything.
 */
export function preflightFileEdits(
  projectRoot: string,
  proposal: EditProposal,
  selectedFileEditIds: string[]
): PreflightResult[] {
  const results: PreflightResult[] = [];

  for (const feId of selectedFileEditIds) {
    const fe = proposal.fileEdits.find((f) => f.id === feId);
    if (!fe) {
      results.push({ fileEditId: feId, relativePath: "(unknown)", ok: false, reason: "File edit not found in proposal" });
      continue;
    }

    // Must be ready
    if (fe.status !== "ready") {
      results.push({
        fileEditId: feId,
        relativePath: fe.relativePath,
        ok: false,
        reason: `File edit is not ready (status: ${fe.status}). ${fe.failureReason ?? ""}`.trim(),
      });
      continue;
    }

    // Proposal target resource integrity
    const targetContent = readProposalTarget(fe.targetResourcePath);
    if (targetContent === null) {
      results.push({ fileEditId: feId, relativePath: fe.relativePath, ok: false, reason: "Proposal target resource is missing" });
      continue;
    }
    const targetHash = sha256hex(targetContent);
    if (targetHash !== fe.targetContentHash) {
      results.push({ fileEditId: feId, relativePath: fe.relativePath, ok: false, reason: "Proposal resource integrity check failed — content changed since proposal was created" });
      continue;
    }

    // Stale detection: current file on disk must match the base snapshot hash
    if (fe.baseContentHash) {
      const currentResult = computeCurrentHash(projectRoot, fe.relativePath);
      if (!currentResult.ok) {
        // File missing — could be a new file creation; allow if baseContentHash indicates new file
        // For V0.3 we treat missing file as stale when a base was expected
        results.push({ fileEditId: feId, relativePath: fe.relativePath, ok: false, reason: `Cannot read current file: ${currentResult.error}` });
        continue;
      }
      if (currentResult.hash !== fe.baseContentHash) {
        results.push({ fileEditId: feId, relativePath: fe.relativePath, ok: false, reason: "File has changed since the proposal was generated (stale). Re-add the file to context and retry." });
        continue;
      }
    }

    results.push({ fileEditId: feId, relativePath: fe.relativePath, ok: true });
  }

  return results;
}
