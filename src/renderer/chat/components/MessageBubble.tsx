import React, { useState } from "react";
import type { ChatMessage, Attachment } from "../../../shared/types.js";
import { fileEmoji, truncFilename, formatTime } from "../helpers.js";
import { CopyIcon, CheckIcon } from "../icons.js";
import { MessageImage } from "./MessageImage.js";
import { MarkdownContent } from "./MarkdownContent.js";

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
          ? "border-blue-400/60 bg-blue-500/10 text-blue-200/70"
          : "border-violet-400/60 bg-violet-500/10 text-violet-200/70"
      }`}
    >
      <span className="font-medium">
        {role === "user" ? "You" : "Agent"}
      </span>
      <div className="truncate text-white/40 mt-0.5">
        {content.slice(0, 120)}
        {content.length > 120 ? "…" : ""}
      </div>
    </div>
  );
}

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
  const isError = msg.role === "error" || msg.isError;
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

  return (
    <div className={`group flex gap-3 py-2 ${isUser ? "justify-end" : "justify-start"}`}>
      {/* Avatar — assistant / error only */}
      {!isUser && (
        <div
          className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold mt-0.5 ${
            isError
              ? "bg-red-900/60 text-red-300"
              : "bg-gradient-to-br from-blue-500 to-violet-600 text-white"
          }`}
        >
          {isError ? "!" : "A"}
        </div>
      )}

      <div className="flex flex-col gap-1 min-w-0 max-w-[75%]">
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
                ? "bg-blue-600 text-white rounded-tr-sm px-4 py-2.5"
                : isError
                ? "bg-red-950/60 border border-red-800/50 text-red-300 rounded-tl-sm px-4 py-2.5"
                : "bg-[#1a1a26] border border-white/6 text-gray-100 rounded-tl-sm px-4 py-3"
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
          <span className="text-[10px] text-white/25">{formatTime(msg.createdAt)}</span>
          {isAssistant && msg.durationMs && (
            <span className="text-[10px] text-white/20">
              {(msg.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {msg.content && (
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/80 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {onQuote && (
            <button
              onClick={() => onQuote(msg)}
              className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/80 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              ↩ Reply
            </button>
          )}
          {isUser && onEdit && (
            <button
              onClick={() => onEdit(msg)}
              className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/80 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
            >
              ✎ Edit
            </button>
          )}
          {isError && onRetry && (
            <button
              onClick={() => onRetry(msg)}
              className="flex items-center gap-1 text-[11px] text-red-400/60 hover:text-red-300 transition-colors py-0.5 px-1.5 rounded hover:bg-red-900/10"
            >
              ↺ Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}