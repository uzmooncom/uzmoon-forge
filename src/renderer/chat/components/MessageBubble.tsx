import React, { useState } from "react";
import type { ChatMessage, Attachment, ContextRef } from "../../../shared/types.js";
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

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns an unambiguous short label for a context ref path.
 * Shows "parent/filename" so duplicate basenames (e.g. two index.ts) are distinguishable.
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
 * Shows "Context · N files" header; click to expand and see paths.
 * Clicking a path opens the historical snapshot via forgeApi.
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
  const [loading, setLoading] = useState(false);
  const label = refLabel(ref_.relativePath, ref_.lineStart, ref_.lineEnd);
  const fullPath = ref_.relativePath + (ref_.lineStart !== undefined
    ? ` (lines ${ref_.lineStart}-${ref_.lineEnd ?? "end"})`
    : "");

  const handleView = async () => {
    if (loading) return;
    setLoading(true);
    try {
      // Read historical snapshot via secure IPC — path is validated server-side
      const result = await window.forgeApi.projectFiles.readSnapshot(ref_.snapshotPath);
      if (result.ok && result.content) {
        // Copy snapshot content to clipboard — user can inspect it
        await window.forgeApi.copyText(result.content);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="flex items-center gap-1.5 py-[2px] text-[11px] text-white/40 group/ref"
      title={`${fullPath} · ${formatBytes(ref_.size)} · captured ${new Date(ref_.capturedAt).toLocaleTimeString()}`}
    >
      <FileContextIcon size={10} />
      <span className="font-mono text-white/50 truncate max-w-[220px]">{label}</span>
      <span className="text-[10px] text-white/25 flex-shrink-0">{formatBytes(ref_.size)}</span>
      <button
        onClick={handleView}
        disabled={loading}
        className="ml-auto text-[10px] text-white/20 hover:text-white/60 transition-colors opacity-0 group-hover/ref:opacity-100 px-1 py-0.5 rounded hover:bg-white/5"
        title="Copy snapshot to clipboard"
      >
        {loading ? "…" : "Copy"}
      </button>
    </div>
  );
}

// ── Agent avatar ───────────────────────────────────────────────────────────

/** Clean Forge mark — no purple gradient */
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
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        {/* Minimal "F" mark for Forge */}
        <path d="M4 3h8M4 8h6M4 13V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
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

  return (
    <div className={`group flex gap-2.5 py-2 ${isUser ? "justify-end" : "justify-start"}`}>
      {/* Avatar — assistant / error only */}
      {!isUser && <AgentAvatar isError={isError} />}

      <div className={`flex flex-col gap-1 min-w-0 ${isUser ? "max-w-[72%] items-end" : "max-w-[78%] items-start"}`}>
        {/* Historical context refs (user messages only) */}
        {isUser && contextRefs.length > 0 && (
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

        {/* Bubble */}
        {(msg.content ||
          (!msg.content && imageAtts.length === 0 && fileAtts.length === 0)) && (
          <div
            className={`rounded-2xl text-sm leading-relaxed ${
              isUser
                ? "bg-[#1e2d45] border border-blue-900/40 text-blue-50/90 rounded-tr-sm px-4 py-2.5"
                : isError
                ? "bg-red-950/50 border border-red-800/40 text-red-300/90 rounded-tl-sm px-4 py-2.5"
                : "bg-[#161622] border border-white/6 text-gray-100/90 rounded-tl-sm px-4 py-3"
            }`}
          >
            {/* Reply banner */}
            {replyTarget && (
              <ReplyBanner content={replyTarget.content} role={replyTarget.role} />
            )}

            {isAssistant ? (
              <MarkdownContent content={msg.content} />
            ) : (
              <span className="whitespace-pre-wrap break-words">{msg.content}</span>
            )}
          </div>
        )}

        {/* Action bar */}
        <div
          className={`flex items-center gap-2 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 ${
            isUser ? "flex-row-reverse" : "flex-row"
          }`}
        >
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
          {isUser && onEdit && (
            <button
              onClick={() => onEdit(msg)}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/70 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              <EditIcon size={11} /> Edit
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
    </div>
  );
}