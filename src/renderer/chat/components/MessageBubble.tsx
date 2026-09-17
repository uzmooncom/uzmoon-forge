import React, { useState, useEffect, useRef } from "react";
import type { ChatMessage, Attachment, ContextRef, EditProposal, FileEdit, AgentReadRef } from "../../../shared/types.js";
import { DiffReviewModal } from "../../project/DiffReviewModal.js";
import { fileEmoji, truncFilename, formatTime } from "../helpers.js";
import { CopyIcon, CheckIcon, ReplyIcon, EditIcon, RetryIcon } from "../icons.js";
import { MessageImage } from "./MessageImage.js";
import { MarkdownContent } from "./MarkdownContent.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function FileContextIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 2h7l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 8.5h4M6 11h2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ size = 10, open }: { size?: number; open: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms" }}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CopySmallIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="8" height="9" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 11V3h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldCheckIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 2L3 4.5v4c0 3 2.5 5 5 5.5 2.5-.5 5-2.5 5-5.5v-4L8 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5.5 8l2 2 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldAlertIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 2L3 4.5v4c0 3 2.5 5 5 5.5 2.5-.5 5-2.5 5-5.5v-4L8 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 6v3M8 11v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function QuestionIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.5 6.5C6.5 5.7 7.1 5 8 5c.9 0 1.5.6 1.5 1.5 0 .8-.7 1.2-1.5 1.5v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r=".5" fill="currentColor" />
    </svg>
  );
}

// ── Snapshot integrity verification ───────────────────────────────────────

type SnapshotStatus = "verified" | "integrity-failed" | "legacy" | "missing";

async function computeHashAsync(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Status pill ────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: SnapshotStatus }) {
  if (status === "verified") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400/80 bg-emerald-900/20 border border-emerald-700/30 rounded-full px-1.5 py-0.5">
        <ShieldCheckIcon size={9} />
        Verified
      </span>
    );
  }
  if (status === "integrity-failed") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-red-400/80 bg-red-900/20 border border-red-700/30 rounded-full px-1.5 py-0.5">
        <ShieldAlertIcon size={9} />
        Integrity Failed
      </span>
    );
  }
  if (status === "missing") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-orange-400/70 bg-orange-900/15 border border-orange-700/25 rounded-full px-1.5 py-0.5">
        <QuestionIcon size={9} />
        Missing
      </span>
    );
  }
  // legacy
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-white/35 bg-white/5 border border-white/10 rounded-full px-1.5 py-0.5">
      <QuestionIcon size={9} />
      Legacy
    </span>
  );
}

// ── Snapshot viewer modal ─────────────────────────────────────────────────

interface SnapshotViewerModalProps {
  ref_: ContextRef;
  onClose: () => void;
}

function SnapshotViewerModal({ ref_, onClose }: SnapshotViewerModalProps) {
  const [loadState, setLoadState] = useState<{
    content: string | null;
    loading: boolean;
    status: SnapshotStatus | null;
  }>({ content: null, loading: true, status: null });
  const [copied, setCopied] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Load snapshot on mount and verify integrity
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.forgeApi.projectFiles.readSnapshot(ref_.snapshotPath);
        if (cancelled) return;
        const content = result.ok && result.content ? result.content : null;
        // Compute async hash for integrity check
        let status: SnapshotStatus;
        if (content === null) {
          status = "missing";
        } else if (!ref_.contentHash) {
          status = "legacy";
        } else {
          const actualHash = await computeHashAsync(content);
          status = actualHash === ref_.contentHash ? "verified" : "integrity-failed";
        }
        if (!cancelled) setLoadState({ content, loading: false, status });
      } catch {
        if (!cancelled) setLoadState({ content: null, loading: false, status: "missing" });
      }
    })();
    return () => { cancelled = true; };
  }, [ref_.snapshotPath, ref_.contentHash]);

  const handleCopy = async () => {
    if (!loadState.content) return;
    await window.forgeApi.copyText(loadState.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const label = refLabelFull(ref_);
  const { content, loading, status } = loadState;

  // Metadata
  const capturedStr = new Date(ref_.capturedAt).toLocaleString();
  const sizeStr = formatBytes(ref_.size);
  const lineInfo = ref_.lineStart !== undefined
    ? `Lines ${ref_.lineStart}–${ref_.lineEnd ?? "end"}`
    : "Full file";

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="bg-[#0f0f16] border border-white/10 rounded-xl shadow-2xl w-[680px] max-w-[92vw] max-h-[80vh] flex flex-col">

        {/* ── Header ── */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/8 flex-shrink-0">
          <FileContextIcon size={11} />
          <span className="flex-1 min-w-0 font-mono text-[12px] text-white/75 truncate">{label}</span>
          {status && !loading && <StatusPill status={status} />}
          <button
            onClick={onClose}
            className="flex-shrink-0 p-1 rounded text-white/25 hover:text-white/60 hover:bg-white/5 transition-colors ml-1"
          >
            <CloseIcon size={11} />
          </button>
        </div>

        {/* ── Metadata row ── */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-white/5 text-[10px] text-white/30 flex-shrink-0">
          <span title="Captured at">{capturedStr}</span>
          <span className="text-white/12">·</span>
          <span>{sizeStr}</span>
          <span className="text-white/12">·</span>
          <span>{ref_.language}</span>
          <span className="text-white/12">·</span>
          <span>{lineInfo}</span>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 overflow-auto">
          {loading && (
            <div className="px-4 py-8 text-center text-[12px] text-white/30">
              Loading snapshot…
            </div>
          )}

          {!loading && status === "missing" && (
            <div className="px-4 py-8 text-center">
              <p className="text-[13px] text-orange-300/70 font-medium mb-1">Snapshot unavailable</p>
              <p className="text-[11px] text-white/30">
                The original captured context can no longer be read.<br />
                The snapshot file may have been cleaned up or moved.
              </p>
            </div>
          )}

          {!loading && status === "integrity-failed" && (
            <div className="px-4 py-4 border-b border-red-800/20 flex-shrink-0">
              <p className="text-[12px] text-red-300/80 font-medium mb-0.5">Snapshot integrity check failed</p>
              <p className="text-[11px] text-white/35">
                <span className="font-mono text-white/45">{ref_.relativePath}</span>
                &nbsp;— the snapshot has been modified or corrupted since it was captured.
                Do not treat this as a verified historical record.
              </p>
            </div>
          )}

          {!loading && status === "legacy" && (
            <div className="px-4 py-2 border-b border-white/5 flex-shrink-0">
              <p className="text-[11px] text-white/35">
                Legacy snapshot — integrity at original capture cannot be verified
                (no hash was recorded when this snapshot was saved).
              </p>
            </div>
          )}

          {!loading && content !== null && status !== "missing" && (
            <>
              <div className="flex items-center justify-between px-4 pt-2.5 pb-1 flex-shrink-0">
                <span className="text-[10px] text-white/20 font-mono">{ref_.language}</span>
                <button
                  onClick={handleCopy}
                  disabled={!content}
                  className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors px-1.5 py-0.5 rounded hover:bg-white/5 disabled:opacity-40"
                >
                  <CopySmallIcon size={10} />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="px-4 pb-4 text-[11.5px] font-mono text-white/65 leading-relaxed whitespace-pre-wrap break-words">
                {content}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Unambiguous short label: shows "parent/filename" so duplicate basenames are distinguishable.
 */
function refLabel(relativePath: string, lineStart?: number, lineEnd?: number): string {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const filename = parts[parts.length - 1] ?? relativePath;
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;
  const base = parent ? `${parent}/${filename}` : filename;
  if (lineStart !== undefined && lineEnd !== undefined) return `${base}:${lineStart}-${lineEnd}`;
  if (lineStart !== undefined) return `${base}:${lineStart}+`;
  return base;
}

function refLabelFull(ref: ContextRef): string {
  return refLabel(ref.relativePath, ref.lineStart, ref.lineEnd);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function AttachmentBadge({ att }: { att: Attachment }) {
  if (att.mimeType.startsWith("image/")) return null;
  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/8 border border-white/10 text-xs text-white/70 max-w-[200px]">
      <span className="text-sm leading-none flex-shrink-0">
        {fileEmoji(att.mimeType)}
      </span>
      <span className="truncate">{truncFilename(att.filename, 22)}</span>
    </div>
  );
}

function ReplyBanner({ content, role }: { content: string; role: string }) {
  return (
    <div
      className={`border-l-2 px-2 py-1 rounded-r-lg mb-2 text-xs ${
        role === "user"
          ? "border-blue-400/40 bg-blue-500/8 text-blue-200/60"
          : "border-white/20 bg-white/4 text-white/50"
      }`}
    >
      <span className="font-medium opacity-60">
        {role === "user" ? "You" : "Agent"}
      </span>
      <div className="truncate text-white/35 mt-0.5">
        {content.slice(0, 120)}
        {content.length > 120 ? "…" : ""}
      </div>
    </div>
  );
}

/**
 * Historical context references display — collapsed by default.
 * Clicking "View" on a ref opens the SnapshotViewerModal with integrity check.
 */
function ContextRefsBadge({ refs }: { refs: ContextRef[] }) {
  const [expanded, setExpanded] = useState(false);

  if (refs.length === 0) return null;

  return (
    <div className="mb-1.5">
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-white/35 hover:text-white/60 transition-colors py-0.5 pl-1 pr-2 rounded-md hover:bg-white/4"
        title={expanded ? "Collapse context" : "Expand context files"}
      >
        <ChevronIcon size={9} open={expanded} />
        <FileContextIcon size={10} />
        <span>
          Context · {refs.length} {refs.length === 1 ? "file" : "files"}
        </span>
      </button>

      {/* Expanded list */}
      {expanded && (
        <div className="mt-0.5 ml-3 flex flex-col gap-0.5">
          {refs.map((ref) => (
            <ContextRefRow key={ref.id} ref_={ref} />
          ))}
        </div>
      )}
    </div>
  );
}

function ContextRefRow({ ref_ }: { ref_: ContextRef }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const label = refLabel(ref_.relativePath, ref_.lineStart, ref_.lineEnd);
  const fullPath = ref_.relativePath + (ref_.lineStart !== undefined
    ? ` (lines ${ref_.lineStart}–${ref_.lineEnd ?? "end"})`
    : "");

  return (
    <>
      <div
        className="flex items-center gap-1.5 py-[2px] text-[11px] text-white/40 group/ref"
        title={`${fullPath} · ${formatBytes(ref_.size)} · captured ${new Date(ref_.capturedAt).toLocaleTimeString()}`}
      >
        <FileContextIcon size={10} />
        <span className="font-mono text-white/50 truncate max-w-[220px]">{label}</span>
        <span className="text-[10px] text-white/25 flex-shrink-0">{formatBytes(ref_.size)}</span>
        <button
          onClick={() => setViewerOpen(true)}
          className="ml-auto text-[10px] text-white/20 hover:text-white/60 transition-colors opacity-0 group-hover/ref:opacity-100 px-1.5 py-0.5 rounded hover:bg-white/5"
          title="View snapshot"
        >
          View
        </button>
      </div>
      {viewerOpen && (
        <SnapshotViewerModal
          ref_={ref_}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

// ── Agent avatar (small inline mark for document style) ────────────────────

function ForgeMarkIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M4 3h8M4 8h6M4 13V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── ExploredFilesSection ──────────────────────────────────────────────────

function ExploredIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ExploredFilesSection({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const [viewerRef, setViewerRef] = useState<AgentReadRef | null>(null);

  // V0.4: agentReadRefs are stored as an extension field on assistant messages
  const agentReadRefs = (msg as unknown as Record<string, unknown>)["agentReadRefs"] as AgentReadRef[] | undefined;
  if (!agentReadRefs || agentReadRefs.length === 0) return null;

  return (
    <>
      <div className="mt-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] text-white/30 hover:text-white/55 transition-colors py-0.5 px-1 rounded hover:bg-white/5"
        >
          <ChevronIcon size={9} open={open} />
          <ExploredIcon size={10} />
          <span>Explored {agentReadRefs.length} file{agentReadRefs.length !== 1 ? "s" : ""}</span>
        </button>

        {open && (
          <div className="mt-1 ml-4 flex flex-col gap-0.5">
            {agentReadRefs.map((ref) => (
              <button
                key={ref.id}
                onClick={() => setViewerRef(ref)}
                className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white/70 py-0.5 px-1.5 rounded hover:bg-white/5 transition-colors text-left"
              >
                <FileContextIcon size={10} />
                <span className="font-mono truncate max-w-[280px]" title={ref.relativePath}>{refLabel(ref.relativePath)}</span>
                {ref.fullFile ? null : (
                  <span className="text-white/20 ml-1">(range)</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Snapshot viewer for a clicked explored file */}
      {viewerRef && (
        <ExploredFileViewerModal ref_={viewerRef} onClose={() => setViewerRef(null)} />
      )}
    </>
  );
}

function ExploredFileViewerModal({ ref_, onClose }: { ref_: AgentReadRef; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "missing">("loading");

  useEffect(() => {
    let cancelled = false;
    window.forgeApi.projectFiles.readSnapshot(ref_.snapshotPath).then((res) => {
      if (cancelled) return;
      if ("content" in res) {
        setContent(res.content);
        setStatus("loaded");
      } else {
        setStatus("missing");
      }
    }).catch(() => {
      if (!cancelled) setStatus("missing");
    });
    return () => { cancelled = true; };
  }, [ref_.snapshotPath]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#0d1117] border border-white/10 rounded-xl shadow-2xl w-[700px] max-w-[92vw] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-xs text-white/70">{ref_.relativePath}</span>
            {ref_.fullFile ? null : (
              <span className="text-[11px] text-white/35">range read (lines {ref_.lineStart ?? "?"}–{ref_.lineEnd ?? "end"})</span>
            )}
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70 p-1">
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {status === "loading" && (
            <div className="text-xs text-white/30 italic">Loading…</div>
          )}
          {status === "missing" && (
            <div className="text-xs text-red-400/70">Snapshot unavailable — the captured file content can no longer be read.</div>
          )}
          {status === "loaded" && content !== null && (
            <pre className="text-xs text-white/75 font-mono whitespace-pre-wrap break-words leading-relaxed">{content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentIdentityRow({
  agentName,
  model,
  isError,
}: {
  agentName?: string;
  model?: string;
  isError?: boolean;
}) {
  return (
    <div className={`flex items-center gap-1.5 mb-2 ${isError ? "text-red-400/60" : "text-white/30"}`}>
      <div
        className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center border ${
          isError
            ? "bg-red-900/40 border-red-700/40 text-red-400/80"
            : "bg-white/8 border-white/12 text-white/45"
        }`}
      >
        {isError
          ? <svg width="8" height="8" viewBox="0 0 16 16" fill="none"><path d="M8 3v6M8 12v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          : <ForgeMarkIcon size={8} />
        }
      </div>
      <span className="text-[11px] font-medium">
        {agentName ?? "Forge"}
      </span>
      {model && (
        <span className="text-[10px] text-white/18 font-mono">{model}</span>
      )}
    </div>
  );
}

/** Clean avatar for left-column display next to user messages */
function AgentAvatar({ isError }: { isError: boolean }) {
  if (isError) {
    return (
      <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-red-900/50 text-red-400 mt-0.5">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M8 3v6M8 12v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
    );
  }
  return (
    <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-white/8 border border-white/10 text-white/50 mt-0.5">
      <ForgeMarkIcon size={11} />
    </div>
  );
}

// ── ProposalCard ─────────────────────────────────────────────────────────

function ProposalStatusBadge({ status }: { status: EditProposal["status"] }) {
  const map: Record<string, { label: string; cls: string }> = {
    ready:             { label: "Ready",            cls: "bg-green-900/50 text-green-300/80 border-green-700/30" },
    needs_context:     { label: "Needs context",    cls: "bg-amber-900/50 text-amber-300/80 border-amber-700/30" },
    ambiguous_context: { label: "Ambiguous",        cls: "bg-amber-900/50 text-amber-300/80 border-amber-700/30" },
    applied:           { label: "Applied",          cls: "bg-blue-900/50 text-blue-300/80 border-blue-700/30" },
    partiallyApplied:  { label: "Partial",          cls: "bg-blue-900/30 text-blue-300/60 border-blue-700/20" },
    rejected:          { label: "Rejected",         cls: "bg-gray-800/60 text-gray-400/70 border-gray-700/30" },
    stale:             { label: "Stale",             cls: "bg-orange-900/50 text-orange-300/80 border-orange-700/30" },
    failed:            { label: "Failed",            cls: "bg-red-900/50 text-red-300/80 border-red-700/30" },
    cancelled:         { label: "Cancelled",         cls: "bg-gray-800/60 text-gray-400/70 border-gray-700/30" },
    draft:             { label: "Draft",             cls: "bg-gray-800/60 text-gray-400/70 border-gray-700/30" },
  };
  const cfg = map[status] ?? map["failed"]!;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function ProposalFileLine({ fe }: { fe: FileEdit }) {
  const dot: Record<FileEdit["status"], string> = {
    ready:             "bg-green-400",
    needs_context:     "bg-amber-400",
    ambiguous_context: "bg-amber-400",
    stale:             "bg-orange-400",
    applied:           "bg-blue-400",
    rejected:          "bg-gray-500",
    failed:            "bg-red-400",
    missing:           "bg-red-400",
  };
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot[fe.status] ?? "bg-gray-500"}`} />
      <span
        className="text-[11px] text-white/55 truncate"
        style={{ fontFamily: "ui-monospace, monospace" }}
        title={fe.relativePath}
      >
        {fe.relativePath}
      </span>
      {fe.failureReason && (
        <span className="text-[10px] text-amber-400/60 shrink-0 truncate max-w-[160px]" title={fe.failureReason}>
          — {fe.failureReason}
        </span>
      )}
    </div>
  );
}

function ProposalCard({ proposalId }: { proposalId: string }) {
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void (async () => {
      const p = await window.forgeApi.fileEditing.getProposal(proposalId);
      setProposal(p);
      setLoading(false);
    })();
  }, [proposalId]);

  // Subscribe to live updates — keyed on proposalId (stable, from prop)
  useEffect(() => {
    if (!proposal) return;
    const currentId = proposal.id;
    const unsub = window.forgeApi.fileEditing.onProposalUpdate((updated) => {
      if (updated.id === currentId) setProposal(updated);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalId]);

  if (loading || !proposal) return null;

  const canReview = proposal.status !== "rejected" && proposal.status !== "cancelled";

  return (
    <>
      <div className="mt-3 rounded-lg border border-white/8 bg-white/3 overflow-hidden">
        {/* Card header */}
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/6">
          <div className="flex items-center gap-2">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-white/40 shrink-0">
              <path d="M3 2h7l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <path d="M6 7h4M6 9.5h4M6 12h2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
            <span className="text-[12px] text-white/75 font-medium leading-tight">{proposal.summary}</span>
          </div>
          <ProposalStatusBadge status={proposal.status} />
        </div>

        {/* File list */}
        <div className="px-3.5 py-2">
          {proposal.fileEdits.map((fe) => (
            <ProposalFileLine key={fe.id} fe={fe} />
          ))}
        </div>

        {/* Actions */}
        {canReview && (
          <div className="flex items-center gap-2 px-3.5 py-2 border-t border-white/5">
            <button
              onClick={() => setShowModal(true)}
              className="text-[12px] px-3 py-1.5 rounded bg-blue-600/70 hover:bg-blue-500/70 text-white font-medium transition-colors"
            >
              Review Changes
            </button>
            {proposal.status === "needs_context" && (
              <span className="text-[11px] text-amber-400/70">
                Add missing files to context before applying
              </span>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <DiffReviewModal
          proposal={proposal}
          onClose={() => setShowModal(false)}
          onProposalUpdate={setProposal}
        />
      )}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function MessageBubble({
  msg,
  allMessages,
  onExpand,
  onCopy,
  onRetry,
  onEdit,
  onQuote,
}: {
  msg: ChatMessage;
  allMessages: ChatMessage[];
  onExpand: (att: Attachment) => void;
  onCopy: (text: string) => void;
  onRetry?: ((msg: ChatMessage) => void) | undefined;
  onEdit?: ((msg: ChatMessage) => void) | undefined;
  onQuote?: ((msg: ChatMessage) => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = msg.role === "user";
  const isError = msg.role === "error" || !!msg.isError;
  const isAssistant = msg.role === "assistant";

  const replyTarget = msg.replyToMessageId
    ? allMessages.find((m) => m.id === msg.replyToMessageId)
    : null;

  const handleCopy = () => {
    onCopy(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const imageAtts = msg.attachments?.filter((a) => a.mimeType.startsWith("image/")) ?? [];
  const fileAtts = msg.attachments?.filter((a) => !a.mimeType.startsWith("image/")) ?? [];
  const contextRefs = msg.contextRefs ?? [];

  // ── ASSISTANT — document-style ────────────────────────────────────────────
  //
  // Assistant (and error) messages are NOT wrapped in a rounded bubble.
  // They are rendered as content directly on the workspace, with only a small
  // identity row (agent name + model) above the text.
  // Read proposalId from the extension field stored on the message
  const proposalId = (msg as unknown as Record<string, unknown>)["proposalId"] as string | undefined;

  if (!isUser) {
    return (
      <div className="group flex flex-col gap-0 py-3 px-1">
        {/* Identity row */}
        <AgentIdentityRow
          {...(msg.agentNameSnapshot !== undefined && { agentName: msg.agentNameSnapshot })}
          {...(msg.modelSnapshot !== undefined && { model: msg.modelSnapshot })}
          isError={isError}
        />

        {/* Image attachments */}
        {imageAtts.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {imageAtts.map((att) => (
              <MessageImage key={att.id} att={att} onExpand={onExpand} />
            ))}
          </div>
        )}

        {/* Content — rendered as markdown for assistant, plain for errors */}
        {msg.content && (
          <div className={`text-sm leading-relaxed ${isError ? "text-red-300/85" : "text-gray-100/90"}`}>
            {isError ? (
              <div className="flex items-start gap-2">
                <div className="flex-shrink-0 mt-0.5">
                  <AgentAvatar isError />
                </div>
                <span className="whitespace-pre-wrap break-words">{msg.content}</span>
              </div>
            ) : (
              <MarkdownContent content={msg.content} />
            )}
          </div>
        )}

        {/* Proposal card (shown when this message contains a file edit proposal) */}
        {proposalId && isAssistant && !isError && (
          <ProposalCard proposalId={proposalId} />
        )}

        {/* Explored files section (V0.4 — agent autonomously read files) */}
        {isAssistant && !isError && (
          <ExploredFilesSection msg={msg} />
        )}

        {/* Action bar */}
        <div className="flex items-center gap-2 px-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <span className="text-[10px] text-white/20">{formatTime(msg.createdAt)}</span>
          {isAssistant && msg.durationMs && (
            <span className="text-[10px] text-white/18">
              {(msg.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {msg.content && (
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {onQuote && (
            <button
              onClick={() => onQuote(msg)}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              <ReplyIcon size={11} /> Reply
            </button>
          )}
          {isError && onRetry && (
            <button
              onClick={() => onRetry(msg)}
              className="flex items-center gap-1 text-[11px] text-red-400/50 hover:text-red-300 transition-colors py-0.5 px-1.5 rounded hover:bg-red-900/10"
            >
              <RetryIcon size={11} /> Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── USER — right-aligned bubble ───────────────────────────────────────────

  return (
    <div className="group flex gap-2.5 py-2 justify-end">
      <div className="flex flex-col gap-1 min-w-0 max-w-[72%] items-end">
        {/* Historical context refs (user messages only) */}
        {contextRefs.length > 0 && (
          <ContextRefsBadge refs={contextRefs} />
        )}

        {/* Image attachments */}
        {imageAtts.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1">
            {imageAtts.map((att) => (
              <MessageImage key={att.id} att={att} onExpand={onExpand} />
            ))}
          </div>
        )}

        {/* File attachments */}
        {fileAtts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1">
            {fileAtts.map((att) => (
              <AttachmentBadge key={att.id} att={att} />
            ))}
          </div>
        )}

        {/* User bubble */}
        {(msg.content ||
          (!msg.content && imageAtts.length === 0 && fileAtts.length === 0)) && (
          <div className="rounded-2xl rounded-tr-sm text-sm leading-relaxed bg-[#1e2d45] border border-blue-900/40 text-blue-50/90 px-4 py-2.5">
            {replyTarget && (
              <ReplyBanner content={replyTarget.content} role={replyTarget.role} />
            )}
            <span className="whitespace-pre-wrap break-words">{msg.content}</span>
          </div>
        )}

        {/* Action bar */}
        <div className="flex items-center gap-2 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex-row-reverse">
          <span className="text-[10px] text-white/20">{formatTime(msg.createdAt)}</span>
          {msg.content && (
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {onQuote && (
            <button
              onClick={() => onQuote(msg)}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              <ReplyIcon size={11} /> Reply
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(msg)}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              <EditIcon size={11} /> Edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}