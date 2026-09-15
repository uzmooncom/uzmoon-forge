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
  const groups: Map<string, Conversation[]> = new Map();
  for (const c of convs) {
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
  savedId?: string; // returned by main after save
}

interface StreamingState {
  streamId: string;
  text: string;
  conversationId: string;
}

// ── Attachment thumbnail ───────────────────────────────────────────────────

function AttachThumb({
  att,
  onRemove,
}: {
  att: PendingAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border border-white/10 group">
      <img
        src={att.previewUrl}
        alt={att.file.name}
        className="w-full h-full object-cover"
      />
      {att.uploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <SpinnerIcon size={16} />
        </div>
      )}
      {att.error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-900/80 text-red-200 text-[9px] text-center p-1">
          {att.error}
        </div>
      )}
      {!att.uploading && !att.error && (
        <button
          onClick={onRemove}
          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── Image in message ───────────────────────────────────────────────────────

function MessageImage({
  att,
  onExpand,
}: {
  att: Attachment;
  onExpand: (att: Attachment) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.forgeApi.readAttachment(att.id).then((res) => {
      if (!cancelled && res.ok) {
        setSrc(`data:${res.mimeType};base64,${res.data}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [att.id]);

  if (!src) {
    return (
      <div className="w-24 h-16 rounded-lg bg-white/5 animate-pulse border border-white/10" />
    );
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

function Lightbox({
  att,
  onClose,
}: {
  att: Attachment;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    window.forgeApi.readAttachment(att.id).then((res) => {
      if (res.ok) setSrc(`data:${res.mimeType};base64,${res.data}`);
    });
  }, [att.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
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

// ── Message bubble ─────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  onExpand,
  onCopy,
  onRetry,
}: {
  msg: ChatMessage;
  onExpand: (att: Attachment) => void;
  onCopy: (text: string) => void;
  onRetry?: ((msg: ChatMessage) => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = msg.role === "user";
  const isError = msg.role === "error" || msg.isError;
  const isAssistant = msg.role === "assistant";

  const handleCopy = () => {
    onCopy(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`group flex gap-3 px-4 py-1 ${isUser ? "flex-row-reverse" : "flex-row"}`}
    >
      {/* Avatar */}
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

      <div
        className={`flex flex-col gap-1 max-w-[72%] ${isUser ? "items-end" : "items-start"}`}
      >
        {/* Attachments (images) */}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1">
            {msg.attachments.map((att) => (
              <MessageImage key={att.id} att={att} onExpand={onExpand} />
            ))}
          </div>
        )}

        {/* Bubble */}
        {msg.content && (
          <div
            className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              isUser
                ? "bg-blue-600 text-white rounded-tr-sm"
                : isError
                ? "bg-red-950/60 border border-red-800/50 text-red-300 rounded-tl-sm"
                : "bg-[#1e1e2a] border border-white/6 text-gray-100 rounded-tl-sm"
            }`}
          >
            {isAssistant ? (
              <div className="markdown-body prose prose-invert prose-sm max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    pre: ({ children }) => (
                      <div className="relative group/code">
                        <pre className="rounded-lg overflow-x-auto text-[12px] !bg-[#0d0d14] border border-white/8 p-3">
                          {children}
                        </pre>
                        <CopyCodeButton
                          onCopy={() => {
                            const el = document.createElement("div");
                            el.innerHTML = String(children);
                            onCopy(el.textContent ?? "");
                          }}
                        />
                      </div>
                    ),
                    code: ({ children, className }) =>
                      className ? (
                        <code className={className}>{children}</code>
                      ) : (
                        <code className="bg-white/10 rounded px-1 py-0.5 text-[11px] text-blue-300 font-mono">
                          {children}
                        </code>
                      ),
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
                      >
                        {children}
                      </a>
                    ),
                    table: ({ children }) => (
                      <div className="overflow-x-auto">
                        <table className="border-collapse w-full text-xs">
                          {children}
                        </table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th className="border border-white/10 px-2 py-1 text-left font-semibold bg-white/5">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="border border-white/10 px-2 py-1">
                        {children}
                      </td>
                    ),
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>
            ) : (
              <span className="whitespace-pre-wrap break-words">
                {msg.content}
              </span>
            )}
          </div>
        )}

        {/* Meta row */}
        <div
          className={`flex items-center gap-2 px-1 opacity-0 group-hover:opacity-100 transition-opacity ${isUser ? "flex-row-reverse" : "flex-row"}`}
        >
          <span className="text-[10px] text-white/30">
            {formatTime(msg.createdAt)}
          </span>
          {isAssistant && msg.durationMs && (
            <span className="text-[10px] text-white/20">
              {(msg.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {msg.content && (
            <button
              onClick={handleCopy}
              className="text-[10px] text-white/30 hover:text-white/70 transition-colors flex items-center gap-1"
            >
              {copied ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {isError && onRetry && (
            <button
              onClick={() => onRetry(msg)}
              className="text-[10px] text-red-400/60 hover:text-red-300 transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyCodeButton({ onCopy }: { onCopy: () => void }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handle}
      className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity text-[10px] text-white/40 hover:text-white/80 bg-white/5 hover:bg-white/10 px-2 py-1 rounded"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ── Streaming bubble ───────────────────────────────────────────────────────

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3 px-4 py-1">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-xs font-bold text-white mt-0.5">
        A
      </div>
      <div className="max-w-[72%] rounded-2xl rounded-tl-sm bg-[#1e1e2a] border border-white/6 px-4 py-2.5 text-sm text-gray-100 leading-relaxed">
        {text ? (
          <div className="markdown-body prose prose-invert prose-sm max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
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

// ── Sidebar ────────────────────────────────────────────────────────────────

function ConversationItem({
  conv,
  active,
  onClick,
  onRename,
  onDelete,
}: {
  conv: Conversation;
  active: boolean;
  onClick: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
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
      onClick={() => {
        if (!renaming) onClick();
      }}
    >
      {renaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setRenameValue(conv.title);
              setRenaming(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 bg-transparent outline-none border-b border-white/30 text-white text-sm"
        />
      ) : (
        <span className="flex-1 truncate">{conv.title}</span>
      )}

      {!renaming && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="ml-1 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center text-white/50 hover:text-white rounded transition-all"
        >
          <DotsIcon size={14} />
        </button>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-8 z-30 bg-[#1e1e2e] border border-white/10 rounded-lg shadow-xl py-1 min-w-[120px]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setMenuOpen(false);
              setRenameValue(conv.title);
              setRenaming(true);
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
          >
            Rename
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              onDelete(conv.id);
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-900/20 transition-colors"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────

function SpinnerIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
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

// ── Main ChatScreen ────────────────────────────────────────────────────────

interface ChatScreenProps {
  onOpenSettings: () => void;
}

export default function ChatScreen({ onOpenSettings }: ChatScreenProps) {
  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("forge:sidebarOpen") !== "false";
    } catch {
      return true;
    }
  });

  // Conversations
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  // Messages for active conversation
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Streaming state
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const activeStreamId = useRef<string | null>(null);

  // Scroll
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottom = useRef(true);

  // Composer
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lightbox
  const [lightboxAtt, setLightboxAtt] = useState<Attachment | null>(null);

  // Draft conversation id (not yet persisted)
  const draftConvId = useRef<string>(randomId());

  // Agent name for display
  const [agentName, setAgentName] = useState("AI Agent");
  const [modelName, setModelName] = useState("");

  // ── Load agent info ──────────────────────────────────────────────────────
  useEffect(() => {
    window.forgeApi.getAppState().then(async (state) => {
      if (state.agentConfigId) {
        const cfg = await window.forgeApi.getConfig(state.agentConfigId);
        if (cfg) {
          setAgentName(cfg.name);
          setModelName(cfg.model);
        }
      }
    });
  }, []);

  // ── Load conversations ───────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const convs = await window.forgeApi.listConversations();
    setConversations(convs);
    return convs;
  }, []);

  useEffect(() => {
    loadConversations().then((convs) => {
      if (convs.length > 0 && !activeConvId) {
        setActiveConvId(convs[0]!.id);
      }
    });
  }, [loadConversations, activeConvId]);

  // ── Load messages when conversation changes ──────────────────────────────
  useEffect(() => {
    if (!activeConvId) {
      setMessages([]);
      return;
    }
    window.forgeApi.getConversationMessages(activeConvId).then(setMessages);
  }, [activeConvId]);

  // ── Persist sidebar open state ───────────────────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem("forge:sidebarOpen", String(sidebarOpen));
    } catch {
      /* ignore */
    }
  }, [sidebarOpen]);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
    });
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

  // ── Stream subscriptions ─────────────────────────────────────────────────
  useEffect(() => {
    const unsubChunk = window.forgeApi.onStreamChunk(({ streamId, chunk }) => {
      if (activeStreamId.current !== streamId) return;
      setStreaming((prev) =>
        prev && prev.streamId === streamId
          ? { ...prev, text: prev.text + chunk }
          : prev
      );
    });

    const unsubEnd = window.forgeApi.onStreamEnd(
      ({ streamId, message, cancelled, conversation }) => {
        if (activeStreamId.current !== streamId) return;
        activeStreamId.current = null;
        setStreaming(null);
        if (message) {
          setMessages((prev) => [...prev, message]);
        }
        if (conversation) {
          setConversations((prev) => {
            const exists = prev.find((c) => c.id === conversation.id);
            if (!exists) return [conversation, ...prev];
            return prev.map((c) =>
              c.id === conversation.id ? conversation : c
            );
          });
        }
        if (!cancelled) {
          // Refresh conversation list for updatedAt ordering
          loadConversations();
        }
      }
    );

    const unsubErr = window.forgeApi.onStreamError(({ streamId, message }) => {
      if (activeStreamId.current !== streamId) return;
      activeStreamId.current = null;
      setStreaming(null);
      setMessages((prev) => [...prev, message]);
    });

    return () => {
      unsubChunk();
      unsubEnd();
      unsubErr();
    };
  }, [loadConversations]);

  // ── New conversation ─────────────────────────────────────────────────────
  const handleNewConversation = useCallback(() => {
    draftConvId.current = randomId();
    setActiveConvId(null);
    setMessages([]);
    setInput("");
    setPendingAttachments([]);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  // ── Switch conversation ──────────────────────────────────────────────────
  const handleSelectConversation = useCallback((id: string) => {
    if (activeStreamId.current) return; // don't switch while streaming
    setActiveConvId(id);
    setStreaming(null);
    setInput("");
    setPendingAttachments([]);
  }, []);

  // ── Rename ───────────────────────────────────────────────────────────────
  const handleRename = useCallback(async (id: string, title: string) => {
    await window.forgeApi.updateConversation(id, { title });
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
  }, []);

  // ── Delete ───────────────────────────────────────────────────────────────
  const handleDelete = useCallback(
    async (id: string) => {
      await window.forgeApi.deleteConversation(id);
      const updated = await loadConversations();
      if (activeConvId === id) {
        if (updated.length > 0) {
          setActiveConvId(updated[0]!.id);
        } else {
          handleNewConversation();
        }
      }
    },
    [activeConvId, loadConversations, handleNewConversation]
  );

  // ── Attachment handling ──────────────────────────────────────────────────
  const addFiles = useCallback(
    async (files: File[]) => {
      const allowed = files.filter((f) => f.type.startsWith("image/"));
      if (allowed.length === 0) return;

      const convId = activeConvId ?? draftConvId.current;

      for (const file of allowed.slice(0, 5 - pendingAttachments.length)) {
        const previewUrl = URL.createObjectURL(file);
        const pending: PendingAttachment = {
          id: randomId(),
          file,
          previewUrl,
          mimeType: file.type,
          uploading: true,
        };
        setPendingAttachments((prev) => [...prev, pending]);

        // Read as base64 and save via IPC
        const reader = new FileReader();
        reader.onload = async (evt) => {
          const base64 = ((evt.target?.result as string).split(",")[1]) ?? "";
          const input: AttachmentInput = {
            data: base64,
            mimeType: file.type,
            filename: file.name,
            size: file.size,
          };
          const res = await window.forgeApi.saveAttachment(convId, input);
          if (res.ok) {
            setPendingAttachments((prev) =>
              prev.map((p) =>
                p.id === pending.id
                  ? { ...p, uploading: false, savedId: res.attachment.id }
                  : p
              )
            );
          } else {
            setPendingAttachments((prev) =>
              prev.map((p) =>
                p.id === pending.id
                  ? { ...p, uploading: false, error: res.error }
                  : p
              )
            );
          }
        };
        reader.readAsDataURL(file);
      }
    },
    [activeConvId, pendingAttachments.length]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((i) => i.type.startsWith("image/"));
      if (imageItems.length > 0) {
        e.preventDefault();
        const files = imageItems
          .map((i) => i.getAsFile())
          .filter((f): f is File => f !== null);
        addFiles(files);
      }
    },
    [addFiles]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      addFiles(files);
    },
    [addFiles]
  );

  const removeAttachment = (id: string) => {
    setPendingAttachments((prev) => {
      const att = prev.find((p) => p.id === id);
      if (att) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  // ── Send message ─────────────────────────────────────────────────────────
  const canSend =
    (input.trim() || pendingAttachments.some((a) => a.savedId)) &&
    !streaming &&
    !pendingAttachments.some((a) => a.uploading);

  const handleSend = useCallback(async () => {
    if (!canSend) return;

    const content = input.trim();
    const convId = activeConvId ?? draftConvId.current;
    const attachmentIds = pendingAttachments
      .filter((a) => a.savedId)
      .map((a) => a.savedId!);

    // Clear composer immediately
    setInput("");
    setPendingAttachments([]);

    // Optimistic user message
    const optimisticUserMsg: ChatMessage = {
      id: randomId(),
      conversationId: convId,
      role: "user",
      content,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    // Start streaming state
    const tempStreamId = randomId();
    activeStreamId.current = tempStreamId;
    setStreaming({ streamId: tempStreamId, text: "", conversationId: convId });

    const res = await window.forgeApi.sendMessage({
      conversationId: convId,
      content,
      ...(attachmentIds.length > 0 && { attachmentIds }),
    });

    if (res.error) {
      activeStreamId.current = null;
      setStreaming(null);
      // Remove optimistic message, add error
      setMessages((prev) => {
        const filtered = prev.filter((m) => m.id !== optimisticUserMsg.id);
        return [
          ...filtered,
          { ...res.userMessage, conversationId: convId },
          {
            id: randomId(),
            conversationId: convId,
            role: "error" as const,
            content: res.error!,
            createdAt: Date.now(),
            isError: true,
          },
        ];
      });
      return;
    }

    // Replace optimistic message with persisted one
    activeStreamId.current = res.streamId;
    setStreaming({ streamId: res.streamId, text: "", conversationId: convId });
    setMessages((prev) =>
      prev.map((m) =>
        m.id === optimisticUserMsg.id
          ? { ...res.userMessage, conversationId: convId }
          : m
      )
    );

    // If this was a draft, activate the conversation
    if (!activeConvId) {
      setActiveConvId(convId);
      draftConvId.current = randomId();
      await loadConversations();
    }
  }, [canSend, input, activeConvId, pendingAttachments, loadConversations]);

  // ── Cancel stream ────────────────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
    const sid = activeStreamId.current;
    if (sid) {
      await window.forgeApi.cancelStream(sid);
    }
  }, []);

  // ── Retry ────────────────────────────────────────────────────────────────
  const handleRetry = useCallback(
    async (_msg: ChatMessage) => {
      // Find last user message in this conversation and resend
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.role === "user");
      if (!lastUser || !activeConvId) return;
      setInput(lastUser.content);
      setTimeout(() => textareaRef.current?.focus(), 50);
    },
    [messages, activeConvId]
  );

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Copy ─────────────────────────────────────────────────────────────────
  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  // ── Auto-resize textarea ─────────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // ── Grouped conversations for sidebar ────────────────────────────────────
  const groups = useMemo(
    () => groupConversationsByDate(conversations),
    [conversations]
  );

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="flex h-screen w-screen bg-[#0f0f17] text-white overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Lightbox */}
      {lightboxAtt && (
        <Lightbox att={lightboxAtt} onClose={() => setLightboxAtt(null)} />
      )}

      {/* Sidebar */}
      <div
        className={`flex-shrink-0 flex flex-col bg-[#13131e] border-r border-white/5 transition-all duration-200 ${
          sidebarOpen ? "w-56" : "w-0 overflow-hidden"
        }`}
      >
        {sidebarOpen && (
          <>
            {/* Sidebar header */}
            <div className="flex items-center justify-between px-3 pt-4 pb-2">
              <span className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                Chats
              </span>
              <button
                onClick={handleNewConversation}
                className="w-6 h-6 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 rounded transition-colors"
                title="New conversation (⌘N)"
              >
                <PlusIcon size={14} />
              </button>
            </div>

            {/* Conversation list */}
            <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-0.5">
              {conversations.length === 0 && (
                <div className="text-center text-white/20 text-xs py-8 px-2">
                  No conversations yet. Start chatting!
                </div>
              )}
              {groups.map((group) => (
                <div key={group.label}>
                  <div className="px-2 py-2 text-[10px] font-semibold text-white/25 uppercase tracking-wider">
                    {group.label}
                  </div>
                  {group.items.map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conv={conv}
                      active={conv.id === activeConvId}
                      onClick={() => handleSelectConversation(conv.id)}
                      onRename={handleRename}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center px-4 py-2.5 border-b border-white/5 gap-2 flex-shrink-0">
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="w-7 h-7 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 rounded-lg transition-colors"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            {sidebarOpen ? (
              <ChevronLeftIcon size={15} />
            ) : (
              <ChevronRightIcon size={15} />
            )}
          </button>

          {/* Agent + model */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
            <span className="text-sm font-medium text-white/80 truncate">
              {agentName}
            </span>
            {modelName && (
              <span className="text-xs text-white/25 truncate hidden sm:block">
                {modelName}
              </span>
            )}
          </div>

          {/* Settings */}
          <button
            onClick={onOpenSettings}
            className="w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/8 rounded-lg transition-colors"
            title="Settings"
          >
            <SettingsIcon size={15} />
          </button>
        </div>

        {/* Message area */}
        <div
          ref={scrollAreaRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto py-4 space-y-1 scroll-smooth"
        >
          {/* Empty state */}
          {messages.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-8 text-center">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-600/20 border border-white/8 flex items-center justify-center text-2xl">
                💬
              </div>
              <div>
                <div className="text-white/60 font-medium">
                  Start a conversation
                </div>
                <div className="text-white/25 text-sm mt-1">
                  Type a message or paste an image to begin
                </div>
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              onExpand={setLightboxAtt}
              onCopy={handleCopy}
              {...(msg.role === "error" ? { onRetry: handleRetry } : {})}
            />
          ))}

          {/* Streaming bubble */}
          {streaming && <StreamingBubble text={streaming.text} />}

          <div ref={bottomRef} className="h-1" />
        </div>

        {/* Jump to bottom */}
        {showScrollBtn && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-28 right-6 w-8 h-8 rounded-full bg-[#1e1e2e] border border-white/10 shadow-xl flex items-center justify-center text-white/50 hover:text-white hover:border-white/20 transition-all"
          >
            <ArrowDownIcon size={14} />
          </button>
        )}

        {/* Composer */}
        <div className="flex-shrink-0 px-4 pb-4 pt-2">
          <div className="relative bg-[#1a1a27] border border-white/8 rounded-2xl overflow-hidden focus-within:border-white/15 transition-colors">
            {/* Attachment previews */}
            {pendingAttachments.length > 0 && (
              <div className="flex gap-2 px-3 pt-3 flex-wrap">
                {pendingAttachments.map((att) => (
                  <AttachThumb
                    key={att.id}
                    att={att}
                    onRemove={() => removeAttachment(att.id)}
                  />
                ))}
              </div>
            )}

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                streaming ? "Responding…" : "Message… (Shift+Enter for newline)"
              }
              disabled={!!streaming}
              rows={1}
              className="w-full bg-transparent resize-none px-4 pt-3 pb-2 text-sm text-white placeholder-white/20 outline-none leading-relaxed disabled:opacity-40"
              style={{ maxHeight: "160px" }}
            />

            {/* Composer toolbar */}
            <div className="flex items-center justify-between px-3 pb-2.5">
              {/* Attach button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!!streaming || pendingAttachments.length >= 5}
                className="flex items-center gap-1.5 text-white/30 hover:text-white/70 transition-colors text-xs disabled:opacity-20 disabled:pointer-events-none"
                title="Attach image"
              >
                <PaperclipIcon size={14} />
                <span className="hidden sm:block">Image</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />

              <div className="flex items-center gap-2">
                {/* Char count hint (only when long) */}
                {input.length > 500 && (
                  <span className="text-[10px] text-white/20">
                    {input.length}
                  </span>
                )}

                {/* Send / Stop */}
                {streaming ? (
                  <button
                    onClick={handleCancel}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-900/40 text-red-400 hover:bg-red-900/60 hover:text-red-300 transition-colors text-xs"
                  >
                    <StopIcon size={12} />
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 text-white hover:bg-blue-500 transition-colors text-xs disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <SendIcon size={12} />
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Keyboard hint */}
          <div className="text-center text-[10px] text-white/15 mt-1.5">
            Enter to send · Shift+Enter for newline · Paste or drag images to attach
          </div>
        </div>
      </div>
    </div>
  );
}