import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type {
  Conversation,
  ChatMessage,
  Attachment,
  AttachmentInput,
} from "../../shared/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function randomId(): string {
  return crypto.randomUUID();
}

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

function formatRelativeDate(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const day = 86400000;
  if (diff < day) return "Today";
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) {
    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(
      new Date(ts)
    );
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(ts));
}

function groupConversationsByDate(
  convs: Conversation[]
): Array<{ label: string; items: Conversation[] }> {
  const pinned = convs.filter((c) => c.pinnedAt);
  const unpinned = convs.filter((c) => !c.pinnedAt);

  const groups: Map<string, Conversation[]> = new Map();
  if (pinned.length > 0) {
    groups.set("📌 Pinned", pinned);
  }
  for (const c of unpinned) {
    const label = formatRelativeDate(c.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(c);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({
    label,
    items,
  }));
}

// ── Types ──────────────────────────────────────────────────────────────────

interface PendingAttachment {
  id: string;
  file: File;
  previewUrl: string;
  mimeType: string;
  uploading: boolean;
  error?: string;
  savedId?: string;
}

/** Blob URL cache: savedAttachmentId → objectURL for instant local display */
const blobUrlCache = new Map<string, string>();

interface StreamingState {
  streamId: string;
  text: string;
  conversationId: string;
}

interface ReplyTarget {
  messageId: string;
  role: string;
  content: string;
}

// Per-conversation draft persistence (in-memory, clears on restart)
const draftStore = new Map<string, { input: string }>();

// ── File type helpers ─────────────────────────────────────────────────────

function fileEmoji(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "🖼";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.includes("word")) return "📝";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet")) return "📊";
  if (mimeType.includes("powerpoint") || mimeType.includes("presentation")) return "📑";
  if (mimeType === "application/json" || mimeType.includes("xml") || mimeType.includes("yaml")) return "🔧";
  if (mimeType.startsWith("text/")) return "📃";
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("gzip")) return "🗜";
  return "📎";
}

function truncFilename(name: string, max = 20): string {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")) : "";
  return name.slice(0, max - ext.length - 1) + "…" + ext;
}

// ── FileChip ─────────────────────────────────────────────────────────────

function FileChip({
  att,
  onRemove,
}: {
  att: PendingAttachment;
  onRemove: () => void;
}) {
  const isImage = att.mimeType.startsWith("image/");
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs border max-w-[180px] flex-shrink-0
        ${
          att.error
            ? "bg-red-900/30 border-red-500/30 text-red-300"
            : "bg-white/8 border-white/10 text-white/80"
        }`}
    >
      {isImage && att.previewUrl ? (
        <img src={att.previewUrl} alt="" className="w-5 h-5 rounded object-cover flex-shrink-0" />
      ) : (
        <span className="text-sm leading-none flex-shrink-0">{fileEmoji(att.mimeType)}</span>
      )}
      <span className="truncate flex-1">
        {att.error ? att.error : truncFilename(att.file.name)}
      </span>
      {att.uploading && <SpinnerIcon size={10} />}
      {!att.uploading && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── MessageImage ───────────────────────────────────────────────────────────

function MessageImage({
  att,
  onExpand,
}: {
  att: Attachment;
  onExpand: (att: Attachment) => void;
}) {
  const cached = blobUrlCache.get(att.id);
  const [src, setSrc] = useState<string | null>(cached ?? null);

  useEffect(() => {
    if (blobUrlCache.has(att.id)) return;
    let cancelled = false;
    window.forgeApi.readAttachment(att.id).then((res) => {
      if (!cancelled && res.ok) {
        setSrc(`data:${res.mimeType};base64,${res.data}`);
      }
    });
    return () => { cancelled = true; };
  }, [att.id]);

  if (!src) {
    return <div className="w-24 h-16 rounded-lg bg-white/5 animate-pulse border border-white/10" />;
  }

  return (
    <button
      onClick={() => onExpand(att)}
      className="flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-blue-500/60 rounded-lg"
    >
      <img
        src={src}
        alt={att.filename}
        className="max-w-[280px] max-h-[200px] rounded-lg object-cover border border-white/10 hover:opacity-90 transition-opacity cursor-zoom-in"
      />
    </button>
  );
}

// ── Lightbox ───────────────────────────────────────────────────────────────

function Lightbox({ att, onClose }: { att: Attachment; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(blobUrlCache.get(att.id) ?? null);

  useEffect(() => {
    if (blobUrlCache.has(att.id)) return;
    window.forgeApi.readAttachment(att.id).then((res) => {
      if (res.ok) setSrc(`data:${res.mimeType};base64,${res.data}`);
    });
  }, [att.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors text-2xl w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10"
      >
        ✕
      </button>
      {src ? (
        <img
          src={src}
          alt={att.filename}
          className="max-w-[90vw] max-h-[90vh] rounded-xl shadow-2xl object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <SpinnerIcon size={32} />
      )}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/50 text-sm">
        {att.filename}
      </div>
    </div>
  );
}

// ── Delete Confirm Dialog ──────────────────────────────────────────────────

function DeleteConfirmDialog({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onConfirm, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-[#1e1e2e] border border-white/10 rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-white font-medium mb-1">Delete conversation?</div>
        <div className="text-white/50 text-sm mb-5 truncate">"{title}"</div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/8 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Markdown components ────────────────────────────────────────────────────

const MD_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => (
    <CopyCodeBlock>{children}</CopyCodeBlock>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="bg-white/10 rounded px-1 py-0.5 text-[11px] text-blue-300 font-mono">
        {children}
      </code>
    ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="text-blue-400 hover:text-blue-300 underline underline-offset-2">
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse w-full text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-white/10 px-2 py-1.5 text-left font-semibold bg-white/5">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-white/10 px-2 py-1">{children}</td>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-blue-500/40 pl-3 my-2 text-white/60 italic">{children}</blockquote>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-inside space-y-0.5 my-1.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-inside space-y-0.5 my-1.5">{children}</ol>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-base font-bold mt-3 mb-1 border-b border-white/10 pb-1">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-sm font-bold mt-2.5 mb-1 text-white/90">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-sm font-semibold mt-2 mb-0.5 text-white/80">{children}</h3>
  ),
  hr: () => <hr className="border-white/10 my-3" />,
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-1 leading-relaxed">{children}</p>
  ),
};

// ── CopyCodeBlock ──────────────────────────────────────────────────────────

function CopyCodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // Extract language label from child code element's className
  const lang = useMemo(() => {
    const el = React.Children.toArray(children).find(
      (c): c is React.ReactElement => React.isValidElement(c) && c.type === "code"
    );
    if (!el) return null;
    const cls: string = (el.props as { className?: string }).className ?? "";
    const match = /language-(\w+)/.exec(cls);
    return match ? match[1] : null;
  }, [children]);

  const handle = () => {
    const text = preRef.current?.textContent ?? "";
    window.forgeApi.copyText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="relative group/code my-2">
      {/* Language label */}
      {lang && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-[#0d0d14] rounded-t-xl border border-b-0 border-white/8">
          <span className="text-[10px] text-white/30 font-mono uppercase tracking-widest">{lang}</span>
          <button
            onClick={handle}
            className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/70 transition-colors"
          >
            {copied ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}
      <pre
        ref={preRef}
        className={`overflow-x-auto text-[12px] !bg-[#0d0d14] border border-white/8 p-4 leading-relaxed ${
          lang ? "rounded-b-xl rounded-t-none !pt-3 pr-4" : "rounded-xl pr-16"
        }`}
      >
        {children}
      </pre>
      {/* Copy button when no lang label */}
      {!lang && (
        <button
          onClick={handle}
          className="absolute top-2.5 right-2.5 flex items-center gap-1 text-[10px] text-white/35 hover:text-white/80 bg-white/5 hover:bg-white/12 border border-white/8 px-2 py-1 rounded-md transition-all"
        >
          {copied ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
          {copied ? "Copied!" : "Copy"}
        </button>
      )}
    </div>
  );
}

// ── AttachmentBadge ────────────────────────────────────────────────────────

function AttachmentBadge({ att }: { att: Attachment }) {
  if (att.mimeType.startsWith("image/")) return null;
  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/8 border border-white/10 text-xs text-white/70 max-w-[200px]">
      <span className="text-sm leading-none flex-shrink-0">{fileEmoji(att.mimeType)}</span>
      <span className="truncate">{truncFilename(att.filename, 22)}</span>
    </div>
  );
}

// ── ReplyBanner (in bubble) ────────────────────────────────────────────────

function ReplyBanner({ content, role }: { content: string; role: string }) {
  return (
    <div className={`border-l-2 px-2 py-1 rounded-r-lg mb-2 text-xs ${
      role === "user"
        ? "border-blue-400/60 bg-blue-500/10 text-blue-200/70"
        : "border-violet-400/60 bg-violet-500/10 text-violet-200/70"
    }`}>
      <span className="font-medium">{role === "user" ? "You" : "Agent"}</span>
      <div className="truncate text-white/40 mt-0.5">{content.slice(0, 120)}{content.length > 120 ? "…" : ""}</div>
    </div>
  );
}

// ── MessageBubble ──────────────────────────────────────────────────────────

function MessageBubble({
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
      {/* Avatar — assistant/error only */}
      {!isUser && (
        <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold mt-0.5 ${
          isError ? "bg-red-900/60 text-red-300" : "bg-gradient-to-br from-blue-500 to-violet-600 text-white"
        }`}>
          {isError ? "!" : "A"}
        </div>
      )}

      <div className={`flex flex-col gap-1 min-w-0 max-w-[75%]`}>
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
        {(msg.content || (!msg.content && imageAtts.length === 0 && fileAtts.length === 0)) && (
          <div className={`rounded-2xl text-sm leading-relaxed ${
            isUser
              ? "bg-blue-600 text-white rounded-tr-sm px-4 py-2.5"
              : isError
              ? "bg-red-950/60 border border-red-800/50 text-red-300 rounded-tl-sm px-4 py-2.5"
              : "bg-[#1a1a26] border border-white/6 text-gray-100 rounded-tl-sm px-4 py-3"
          }`}>
            {/* Reply banner */}
            {replyTarget && (
              <ReplyBanner content={replyTarget.content} role={replyTarget.role} />
            )}

            {isAssistant ? (
              <div className="prose-custom">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={MD_COMPONENTS as Record<string, unknown>}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>
            ) : (
              <span className="whitespace-pre-wrap break-words">{msg.content}</span>
            )}
          </div>
        )}

        {/* Action bar */}
        <div className={`flex items-center gap-2 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 ${
          isUser ? "flex-row-reverse" : "flex-row"
        }`}>
          <span className="text-[10px] text-white/25">{formatTime(msg.createdAt)}</span>
          {isAssistant && msg.durationMs && (
            <span className="text-[10px] text-white/20">{(msg.durationMs / 1000).toFixed(1)}s</span>
          )}
          {msg.content && (
            <button onClick={handleCopy}
              className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/80 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5">
              {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {onQuote && (
            <button onClick={() => onQuote(msg)}
              className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/80 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5">
              ↩ Reply
            </button>
          )}
          {isUser && onEdit && (
            <button onClick={() => onEdit(msg)}
              className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/80 transition-colors py-0.5 px-1.5 rounded hover:bg-white/5">
              ✎ Edit
            </button>
          )}
          {isError && onRetry && (
            <button onClick={() => onRetry(msg)}
              className="flex items-center gap-1 text-[11px] text-red-400/60 hover:text-red-300 transition-colors py-0.5 px-1.5 rounded hover:bg-red-900/10">
              ↺ Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── StreamingBubble ────────────────────────────────────────────────────────

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3 py-2">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-xs font-bold text-white mt-0.5">
        A
      </div>
      <div className="max-w-[75%] min-w-0 rounded-2xl rounded-tl-sm bg-[#1a1a26] border border-white/6 px-4 py-3 text-sm text-gray-100 leading-relaxed">
        {text ? (
          <div className="prose-custom">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={MD_COMPONENTS as Record<string, unknown>}
            >
              {text}
            </ReactMarkdown>
          </div>
        ) : (
          <TypingDots />
        )}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex gap-1 items-center h-4">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

// ── ConversationItem ───────────────────────────────────────────────────────

function ConversationItem({
  conv,
  active,
  isStreaming,
  onClick,
  onRename,
  onDelete,
  onPin,
  onArchive,
  onExport,
}: {
  conv: Conversation;
  active: boolean;
  isStreaming?: boolean;
  onClick: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onArchive: (id: string) => void;
  onExport: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  const commitRename = () => {
    const v = renameValue.trim();
    if (v && v !== conv.title) onRename(conv.id, v);
    setRenaming(false);
  };

  return (
    <div
      className={`group relative flex items-center rounded-lg px-3 py-2 cursor-pointer transition-colors text-sm ${
        active
          ? "bg-white/10 text-white"
          : "text-white/60 hover:bg-white/5 hover:text-white/90"
      }`}
      onClick={() => { if (!renaming) onClick(); }}
    >
      {conv.pinnedAt && <span className="mr-1.5 text-[10px] opacity-50">📌</span>}

      {renaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { setRenameValue(conv.title); setRenaming(false); }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 bg-transparent outline-none border-b border-white/30 text-white text-sm"
        />
      ) : (
        <span className="flex-1 truncate flex items-center gap-1.5">
          {conv.title}
          {isStreaming && (
            <span className="inline-flex gap-0.5 items-center ml-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1 h-1 rounded-full bg-blue-400/70 animate-bounce"
                  style={{ animationDelay: `${i * 100}ms` }}
                />
              ))}
            </span>
          )}
        </span>
      )}

      {!renaming && (
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className="ml-1 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center text-white/50 hover:text-white rounded transition-all"
        >
          <DotsIcon size={14} />
        </button>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-8 z-30 bg-[#1e1e2e] border border-white/10 rounded-lg shadow-xl py-1 min-w-[140px]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { setMenuOpen(false); setRenameValue(conv.title); setRenaming(true); }}
            className="w-full text-left px-3 py-1.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
          >
            ✎ Rename
          </button>
          <button
            onClick={() => { setMenuOpen(false); onPin(conv.id); }}
            className="w-full text-left px-3 py-1.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
          >
            {conv.pinnedAt ? "Unpin" : "📌 Pin"}
          </button>
          <button
            onClick={() => { setMenuOpen(false); onExport(conv.id); }}
            className="w-full text-left px-3 py-1.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
          >
            ↓ Export
          </button>
          <button
            onClick={() => { setMenuOpen(false); onArchive(conv.id); }}
            className="w-full text-left px-3 py-1.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
          >
            📦 Archive
          </button>
          <div className="h-px bg-white/8 my-1" />
          <button
            onClick={() => { setMenuOpen(false); onDelete(conv.id); }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-900/20 transition-colors"
          >
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────

function SpinnerIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function DotsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function SendIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

function StopIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function PaperclipIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function ChevronLeftIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ArrowDownIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

function SettingsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function SearchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

// ── Main ChatScreen ────────────────────────────────────────────────────────

interface ChatScreenProps {
  onOpenSettings: () => void;
}

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 340;
const DEFAULT_SIDEBAR_WIDTH = 224;

export default function ChatScreen({ onOpenSettings }: ChatScreenProps) {
  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("forge:sidebarOpen") !== "false"; } catch { return true; }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return parseInt(localStorage.getItem("forge:sidebarWidth") ?? "", 10) || DEFAULT_SIDEBAR_WIDTH; } catch { return DEFAULT_SIDEBAR_WIDTH; }
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Conversations
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);

  // Messages
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Streaming keyed by conversationId
  const [streamingMap, setStreamingMap] = useState<Record<string, StreamingState>>({});
  const streaming = activeConvId ? (streamingMap[activeConvId] ?? null) : null;
  const activeStreamId = useRef<string | null>(null);
  const activeStreamConvId = useRef<string | null>(null);

  const setStreaming = useCallback((value: StreamingState | null) => {
    if (value !== null) {
      setStreamingMap((prev) => ({ ...prev, [value.conversationId]: value }));
    } else {
      const convId = activeStreamConvId.current;
      if (!convId) return;
      setStreamingMap((prev) => { const n = { ...prev }; delete n[convId]; return n; });
    }
  }, []);

  // Scroll
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottom = useRef(true);

  // Composer
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lightbox
  const [lightboxAtt, setLightboxAtt] = useState<Attachment | null>(null);

  // Delete confirm
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Draft conversation id
  const draftConvId = useRef<string>(randomId());

  // Agent info
  const [agentName, setAgentName] = useState("AI Agent");
  const [modelName, setModelName] = useState("");

  // Sidebar resize
  const resizingRef = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

  // ── Load agent info ────────────────────────────────────────────────────
  useEffect(() => {
    window.forgeApi.getAppState().then(async (state) => {
      if (state.agentConfigId) {
        const cfg = await window.forgeApi.getConfig(state.agentConfigId);
        if (cfg) { setAgentName(cfg.name); setModelName(cfg.model); }
      }
    });
  }, []);

  // ── Load conversations ─────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const convs = await window.forgeApi.listConversations();
    setConversations(convs);
    return convs;
  }, []);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    loadConversations().then((convs) => {
      if (convs.length > 0) setActiveConvId(convs[0]!.id);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load messages when conversation changes ────────────────────────────
  useEffect(() => {
    if (!activeConvId) { setMessages([]); return; }
    window.forgeApi.getConversationMessages(activeConvId).then(setMessages);
  }, [activeConvId]);

  // ── Persist sidebar prefs ──────────────────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem("forge:sidebarOpen", String(sidebarOpen)); } catch { /* */ }
  }, [sidebarOpen]);

  useEffect(() => {
    try { localStorage.setItem("forge:sidebarWidth", String(sidebarWidth)); } catch { /* */ }
  }, [sidebarWidth]);

  // ── Auto-scroll ────────────────────────────────────────────────────────
  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    if (isNearBottom.current) scrollToBottom();
  }, [messages, streaming?.text, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottom.current = dist < 80;
    setShowScrollBtn(dist > 200);
  }, []);

  // ── Stream subscriptions ───────────────────────────────────────────────
  useEffect(() => {
    const unsubChunk = window.forgeApi.onStreamChunk(({ streamId, chunk }) => {
      if (activeStreamId.current !== streamId) return;
      const convId = activeStreamConvId.current;
      if (!convId) return;
      setStreamingMap((prev) => {
        const cur = prev[convId];
        if (!cur || cur.streamId !== streamId) return prev;
        return { ...prev, [convId]: { ...cur, text: cur.text + chunk } };
      });
    });

    const unsubEnd = window.forgeApi.onStreamEnd(({ streamId, message, cancelled, conversation }) => {
      if (activeStreamId.current !== streamId) return;
      const convId = activeStreamConvId.current;
      activeStreamId.current = null;
      activeStreamConvId.current = null;
      if (convId) {
        setStreamingMap((prev) => { const n = { ...prev }; delete n[convId]; return n; });
      }
      if (message) {
        setMessages((prev) => {
          if (message.conversationId === activeConvIdRef.current || convId === activeConvIdRef.current) {
            return [...prev, message];
          }
          return prev;
        });
      }
      if (conversation) {
        setConversations((prev) => {
          const exists = prev.find((c) => c.id === conversation.id);
          if (!exists) return [conversation, ...prev];
          return prev.map((c) => c.id === conversation.id ? conversation : c);
        });
      }
      if (!cancelled) loadConversations();
    });

    const unsubErr = window.forgeApi.onStreamError(({ streamId, message }) => {
      if (activeStreamId.current !== streamId) return;
      const convId = activeStreamConvId.current;
      activeStreamId.current = null;
      activeStreamConvId.current = null;
      if (convId) {
        setStreamingMap((prev) => { const n = { ...prev }; delete n[convId]; return n; });
      }
      setMessages((prev) => {
        if (message.conversationId === activeConvIdRef.current || convId === activeConvIdRef.current) {
          return [...prev, message];
        }
        return prev;
      });
    });

    return () => { unsubChunk(); unsubEnd(); unsubErr(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConversations]);

  // ── Global keyboard shortcuts ──────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+N — new conversation
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleNewConversation();
        return;
      }
      // Cmd+F — toggle sidebar search
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setShowSearch((v) => !v);
        setTimeout(() => searchRef.current?.focus(), 50);
        return;
      }
      // Escape — clear reply target
      if (e.key === "Escape" && replyTarget) {
        e.preventDefault();
        setReplyTarget(null);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTarget]);

  // ── Sidebar resize ─────────────────────────────────────────────────────
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    resizingRef.current = true;
    resizeStartX.current = e.clientX;
    resizeStartW.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - resizeStartX.current;
      const newW = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, resizeStartW.current + delta));
      setSidebarWidth(newW);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  // ── Conversation actions ───────────────────────────────────────────────
  const handleNewConversation = useCallback(() => {
    // Save draft for current conversation
    if (activeConvId && input.trim()) {
      draftStore.set(activeConvId, { input });
    }
    draftConvId.current = randomId();
    setActiveConvId(null);
    setMessages([]);
    setInput("");
    setPendingAttachments([]);
    setReplyTarget(null);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [activeConvId, input]);

  const handleSelectConversation = useCallback((id: string) => {
    // Save draft for current conversation
    if (activeConvId && activeConvId !== id && input.trim()) {
      draftStore.set(activeConvId, { input });
    }
    setActiveConvId(id);
    // Restore draft for the new conversation
    const saved = draftStore.get(id);
    setInput(saved?.input ?? "");
    setPendingAttachments([]);
    setReplyTarget(null);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [activeConvId, input]);

  const handleRename = useCallback(async (id: string, title: string) => {
    await window.forgeApi.updateConversation(id, { title });
    setConversations((prev) => prev.map((c) => c.id === id ? { ...c, title } : c));
  }, []);

  const handleDeleteRequest = useCallback((id: string) => {
    setDeleteConfirmId(id);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    const id = deleteConfirmId;
    if (!id) return;
    setDeleteConfirmId(null);
    await window.forgeApi.deleteConversation(id);
    const updated = await loadConversations();
    if (activeConvId === id) {
      if (updated.length > 0) setActiveConvId(updated[0]!.id);
      else handleNewConversation();
    }
  }, [deleteConfirmId, activeConvId, loadConversations, handleNewConversation]);

  const handlePin = useCallback(async (id: string) => {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    if (conv.pinnedAt) {
      // Unpin — pass empty patch (db.updateConversation checks "pinnedAt" in patch)
      // We use a cast because exactOptionalPropertyTypes forbids { pinnedAt: undefined }
      await window.forgeApi.updateConversation(id, {} as Parameters<typeof window.forgeApi.updateConversation>[1]);
      setConversations((prev) =>
        prev.map((c): Conversation => {
          if (c.id !== id) return c;
          const { pinnedAt: _p, ...rest } = c;
          void _p;
          return rest as Conversation;
        })
      );
    } else {
      // Pin
      const pinnedAt = Date.now();
      await window.forgeApi.updateConversation(id, { pinnedAt });
      setConversations((prev) =>
        prev.map((c): Conversation => c.id === id ? { ...c, pinnedAt } : c)
      );
    }
  }, [conversations]);

  const handleArchive = useCallback(async (id: string) => {
    await window.forgeApi.updateConversation(id, { archivedAt: Date.now() });
    const updated = await loadConversations();
    if (activeConvId === id) {
      if (updated.length > 0) setActiveConvId(updated[0]!.id);
      else handleNewConversation();
    }
  }, [activeConvId, loadConversations, handleNewConversation]);

  const handleExport = useCallback(async (id: string) => {
    const conv = conversations.find((c) => c.id === id);
    const markdown = await window.forgeApi.exportConversation(id);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(conv?.title ?? "conversation").replace(/[^a-z0-9]/gi, "-")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [conversations]);

  // ── Search filtered conversations ──────────────────────────────────────
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupConversationsByDate(conversations);
    const q = searchQuery.toLowerCase();
    const filtered = conversations.filter((c) => c.title.toLowerCase().includes(q));
    return [{ label: "Results", items: filtered }];
  }, [conversations, searchQuery]);

  // ── Attachment handling ────────────────────────────────────────────────
  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const convId = activeConvId ?? draftConvId.current;

    for (const file of files.slice(0, 10 - pendingAttachments.length)) {
      const previewUrl = URL.createObjectURL(file);
      const pending: PendingAttachment = {
        id: randomId(), file, previewUrl, mimeType: file.type, uploading: true,
      };
      setPendingAttachments((prev) => [...prev, pending]);

      const reader = new FileReader();
      reader.onload = async (evt) => {
        const base64 = ((evt.target?.result as string).split(",")[1]) ?? "";
        const inp: AttachmentInput = { data: base64, mimeType: file.type, filename: file.name, size: file.size };
        const res = await window.forgeApi.saveAttachment(convId, inp);
        if (res.ok) {
          blobUrlCache.set(res.attachment.id, previewUrl);
          setPendingAttachments((prev) =>
            prev.map((p) => p.id === pending.id ? { ...p, uploading: false, savedId: res.attachment.id } : p)
          );
        } else {
          setPendingAttachments((prev) =>
            prev.map((p) => p.id === pending.id ? { ...p, uploading: false, error: res.error } : p)
          );
        }
      };
      reader.readAsDataURL(file);
    }
  }, [activeConvId, pendingAttachments.length]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) { addFiles(Array.from(e.target.files)); e.target.value = ""; }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const fileItems = Array.from(e.clipboardData.items).filter((i) => i.kind === "file");
    if (fileItems.length > 0) {
      e.preventDefault();
      const files = fileItems.map((i) => i.getAsFile()).filter((f): f is File => f !== null);
      addFiles(files);
    }
  }, [addFiles]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  }, [addFiles]);

  const removeAttachment = (id: string) => {
    setPendingAttachments((prev) => {
      const att = prev.find((p) => p.id === id);
      if (att) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  // ── Send message ───────────────────────────────────────────────────────
  const canSend =
    (input.trim() !== "" || pendingAttachments.some((a) => a.savedId)) &&
    !streaming &&
    !pendingAttachments.some((a) => a.uploading);

  const handleSend = useCallback(async () => {
    if (!canSend) return;

    const content = input.trim();
    const convId = activeConvId ?? draftConvId.current;
    const attachmentIds = pendingAttachments.filter((a) => a.savedId).map((a) => a.savedId!);
    const pendingAttsSnapshot = pendingAttachments
      .filter((a) => a.savedId)
      .map((a): Attachment => ({
        id: a.savedId!, messageId: "", conversationId: convId,
        mimeType: a.mimeType, filename: a.file.name, localPath: "", size: a.file.size,
      }));

    const reply = replyTarget;

    setInput("");
    setPendingAttachments([]);
    setReplyTarget(null);
    // Clear draft
    draftStore.delete(convId);
    textareaRef.current?.focus();

    const optimisticUserMsg: ChatMessage = {
      id: randomId(),
      conversationId: convId,
      role: "user",
      content,
      createdAt: Date.now(),
      ...(pendingAttsSnapshot.length > 0 && { attachments: pendingAttsSnapshot }),
      ...(reply && { replyToMessageId: reply.messageId }),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    const unsubStart = window.forgeApi.onStreamStart(({ streamId, userMessage: serverUserMsg, conversation }) => {
      unsubStart();
      activeStreamId.current = streamId;
      activeStreamConvId.current = convId;
      setStreaming({ streamId, text: "", conversationId: convId });
      const persistedUser: ChatMessage = {
        ...serverUserMsg,
        conversationId: convId,
        ...(pendingAttsSnapshot.length > 0 && { attachments: pendingAttsSnapshot }),
        ...(reply && { replyToMessageId: reply.messageId }),
      };
      setMessages((prev) => prev.map((m) => m.id === optimisticUserMsg.id ? persistedUser : m));
      setConversations((prev) => {
        const exists = prev.find((c) => c.id === conversation.id);
        if (!exists) return [conversation, ...prev];
        return prev.map((c) => c.id === conversation.id ? conversation : c);
      });
      if (!activeConvId) {
        setActiveConvId(convId);
        draftConvId.current = randomId();
      }
    });

    window.forgeApi.sendMessage({
      conversationId: convId,
      content,
      ...(attachmentIds.length > 0 && { attachmentIds }),
      ...(reply && { replyToMessageId: reply.messageId }),
    }).then((res) => {
      if (res.error && activeStreamId.current === null) {
        unsubStart();
        setInput(content);
        setTimeout(() => textareaRef.current?.focus(), 30);
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== optimisticUserMsg.id);
          return [...filtered, {
            id: randomId(), conversationId: convId, role: "error" as const,
            content: res.error!, createdAt: Date.now(), isError: true,
          }];
        });
      }
    }).catch(() => {
      unsubStart();
      setInput(content);
      setTimeout(() => textareaRef.current?.focus(), 30);
    });
  }, [canSend, input, activeConvId, pendingAttachments, setStreaming, replyTarget]);

  // ── Cancel stream ──────────────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
    const sid = activeStreamId.current;
    if (!sid) return;
    const convId = activeStreamConvId.current;
    activeStreamId.current = null;
    activeStreamConvId.current = null;
    if (convId) {
      setStreamingMap((prev) => { const n = { ...prev }; delete n[convId]; return n; });
    }
    await window.forgeApi.cancelStream(sid);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  // ── Retry ──────────────────────────────────────────────────────────────
  const handleRetry = useCallback(async (_msg: ChatMessage) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser || !activeConvId) return;
    setInput(lastUser.content);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [messages, activeConvId]);

  // ── Edit ───────────────────────────────────────────────────────────────
  const handleEdit = useCallback((msg: ChatMessage) => {
    setInput(msg.content);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 30);
  }, []);

  // ── Quote/Reply ────────────────────────────────────────────────────────
  const handleQuote = useCallback((msg: ChatMessage) => {
    setReplyTarget({ messageId: msg.id, role: msg.role, content: msg.content });
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, []);

  // ── Keyboard in composer ───────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === "Escape" && replyTarget) { e.preventDefault(); setReplyTarget(null); }
  };

  // ── Copy ───────────────────────────────────────────────────────────────
  const handleCopy = useCallback((text: string) => {
    window.forgeApi.copyText(text).catch(() => {});
  }, []);

  // ── Auto-resize textarea ───────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // ── Delete confirm conv title ──────────────────────────────────────────
  const deleteConvTitle = deleteConfirmId
    ? (conversations.find((c) => c.id === deleteConfirmId)?.title ?? "")
    : "";

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div
      className="flex h-screen w-screen bg-[#0f0f17] text-white overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Lightbox */}
      {lightboxAtt && <Lightbox att={lightboxAtt} onClose={() => setLightboxAtt(null)} />}

      {/* Delete confirm */}
      {deleteConfirmId && (
        <DeleteConfirmDialog
          title={deleteConvTitle}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <div
        className={`flex-shrink-0 flex flex-col bg-[#13131e] border-r border-white/5 transition-[width] duration-200 relative ${
          sidebarOpen ? "" : "w-0 overflow-hidden"
        }`}
        style={sidebarOpen ? { width: sidebarWidth } : undefined}
      >
        {sidebarOpen && (
          <>
            {/* Header */}
            <div className="flex items-center gap-1 px-2 pt-3 pb-1 h-[44px] flex-shrink-0">
              <button
                onClick={() => { setShowSearch((v) => !v); setTimeout(() => searchRef.current?.focus(), 50); }}
                className={`flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
                  showSearch ? "text-white bg-white/10" : "text-white/30 hover:text-white hover:bg-white/8"
                }`}
                title="Search (⌘F)"
              >
                <SearchIcon size={14} />
              </button>
              <div className="flex-1" />
              <button
                onClick={handleNewConversation}
                className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-white/30 hover:text-white hover:bg-white/8 rounded-lg transition-colors"
                title="New conversation (⌘N)"
              >
                <PlusIcon size={15} />
              </button>
            </div>

            {/* Search box */}
            {showSearch && (
              <div className="px-2 pb-2 flex-shrink-0">
                <div className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5">
                  <SearchIcon size={12} />
                  <input
                    ref={searchRef}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search conversations…"
                    className="flex-1 bg-transparent text-xs text-white/80 placeholder-white/25 outline-none"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setShowSearch(false); setSearchQuery(""); }
                    }}
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery("")} className="text-white/30 hover:text-white text-xs">✕</button>
                  )}
                </div>
              </div>
            )}

            {/* Conversation list */}
            <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-0.5">
              {conversations.length === 0 && (
                <div className="text-center text-white/20 text-xs py-8 px-2">No conversations yet</div>
              )}
              {filteredGroups.map((group) => (
                <div key={group.label}>
                  <div className="px-2 pt-3 pb-1 text-[10px] font-medium text-white/20 tracking-wide">
                    {group.label}
                  </div>
                  {group.items.map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conv={conv}
                      active={conv.id === activeConvId}
                      isStreaming={!!streamingMap[conv.id]}
                      onClick={() => handleSelectConversation(conv.id)}
                      onRename={handleRename}
                      onDelete={handleDeleteRequest}
                      onPin={handlePin}
                      onArchive={handleArchive}
                      onExport={handleExport}
                    />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Resize handle */}
        {sidebarOpen && (
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/30 transition-colors group"
            onMouseDown={handleResizeMouseDown}
          >
            <div className="absolute right-0 top-0 bottom-0 w-px bg-white/5 group-hover:bg-blue-500/50 transition-colors" />
          </div>
        )}
      </div>

      {/* ── Main area ────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center px-3 border-b border-white/5 gap-2 flex-shrink-0 h-[44px]">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="w-7 h-7 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 rounded-lg transition-colors"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            {sidebarOpen ? <ChevronLeftIcon size={15} /> : <ChevronRightIcon size={15} />}
          </button>

          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
            <span className="text-sm font-medium text-white/80 truncate">{agentName}</span>
            {modelName && (
              <span className="text-xs text-white/25 truncate hidden sm:block">{modelName}</span>
            )}
          </div>

          <button
            onClick={onOpenSettings}
            className="w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/8 rounded-lg transition-colors"
            title="Settings"
          >
            <SettingsIcon size={15} />
          </button>
        </div>

        {/* Message area — centered column */}
        <div
          ref={scrollAreaRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto scroll-smooth"
        >
          <div className="max-w-[800px] mx-auto px-6 py-6">
            {/* Empty state */}
            {messages.length === 0 && !streaming && (
              <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-600/20 border border-white/8 flex items-center justify-center text-3xl">
                  💬
                </div>
                <div>
                  <div className="text-white/70 font-semibold text-lg">{agentName}</div>
                  {modelName && <div className="text-white/30 text-sm mt-0.5">{modelName}</div>}
                  <div className="text-white/35 text-sm mt-3">
                    Start a conversation · Paste or drag files to attach
                  </div>
                  <div className="text-white/20 text-xs mt-2">
                    ⌘N new chat · ⌘F search · Shift+Enter new line
                  </div>
                </div>
              </div>
            )}

            {/* Messages */}
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                allMessages={messages}
                onExpand={setLightboxAtt}
                onCopy={handleCopy}
                onQuote={handleQuote}
                {...(msg.role === "error" ? { onRetry: handleRetry } : {})}
                {...(msg.role === "user" ? { onEdit: handleEdit } : {})}
              />
            ))}

            {/* Streaming bubble */}
            {streaming && <StreamingBubble text={streaming.text} />}

            <div ref={bottomRef} className="h-4" />
          </div>
        </div>

        {/* Jump to bottom */}
        {showScrollBtn && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-28 right-6 w-8 h-8 rounded-full bg-[#1e1e2e] border border-white/10 shadow-xl flex items-center justify-center text-white/50 hover:text-white hover:border-white/20 transition-all z-10"
          >
            <ArrowDownIcon size={14} />
          </button>
        )}

        {/* ── Composer ──────────────────────────────────────────────── */}
        <div className="flex-shrink-0 px-4 pb-4 pt-2">
          <div className="max-w-[800px] mx-auto">
            {/* Reply target banner */}
            {replyTarget && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-white/5 border border-white/8 rounded-xl text-xs">
                <span className="text-white/40">↩ Replying to</span>
                <span className={`font-medium ${replyTarget.role === 'user' ? 'text-blue-300' : 'text-violet-300'}`}>
                  {replyTarget.role === 'user' ? 'You' : 'Agent'}
                </span>
                <span className="text-white/30 truncate flex-1">
                  {replyTarget.content.slice(0, 80)}{replyTarget.content.length > 80 ? '…' : ''}
                </span>
                <button
                  onClick={() => setReplyTarget(null)}
                  className="text-white/30 hover:text-white ml-1"
                >
                  ✕
                </button>
              </div>
            )}

            <div className="relative bg-[#1a1a27] border border-white/8 rounded-2xl focus-within:border-white/15 transition-colors">
              {/* Textarea row */}
              <div className="flex items-end px-3 pt-2.5 pb-1 gap-2">
                {/* Attach button */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={pendingAttachments.length >= 10}
                  title="Attach file (image, PDF, text, code…)"
                  className="flex-shrink-0 mb-1 flex items-center justify-center w-7 h-7 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors disabled:opacity-20 disabled:pointer-events-none"
                >
                  <PaperclipIcon size={16} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="*/*"
                  multiple
                  className="hidden"
                  onChange={handleFileChange}
                />

                {/* Textarea */}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={streaming ? "Responding…" : "Message… (Enter to send, Shift+Enter for newline)"}
                  rows={1}
                  autoFocus
                  className="flex-1 bg-transparent resize-none text-sm text-white placeholder-white/25 outline-none leading-relaxed min-h-[28px]"
                  style={{ maxHeight: "140px" }}
                />

                {/* Send / Stop */}
                {streaming ? (
                  <button
                    onClick={handleCancel}
                    className="flex-shrink-0 mb-1 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-900/40 text-red-400 hover:bg-red-900/60 hover:text-red-300 transition-colors text-xs"
                  >
                    <StopIcon size={11} />
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className="flex-shrink-0 mb-1 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors text-xs disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <SendIcon size={11} />
                    Send
                  </button>
                )}
              </div>

              {/* File chips */}
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
                  {pendingAttachments.map((att) => (
                    <FileChip
                      key={att.id}
                      att={att}
                      onRemove={() => removeAttachment(att.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}