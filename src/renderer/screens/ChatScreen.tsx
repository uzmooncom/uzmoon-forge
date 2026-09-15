import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { AgentConfig, ChatMessage } from "@shared/types.js";
import SettingsModal from "../components/SettingsModal.js";

interface Props {
  configId: string;
  onReconfigure: () => void;
}

interface StreamingState {
  streamId: string;
  content: string;
}

export default function ChatScreen({
  configId,
  onReconfigure,
}: Props): React.ReactElement {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "connecting" | "error"
  >("connecting");

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load config and history
  useEffect(() => {
    void (async () => {
      const [cfg, history] = await Promise.all([
        window.forgeApi.getConfig(configId),
        window.forgeApi.getHistory(),
      ]);
      setConfig(cfg);
      setMessages(history);
      setConnectionStatus("connected");
    })();
  }, [configId]);

  // Subscribe to stream events
  useEffect(() => {
    const unsubChunk = window.forgeApi.onStreamChunk(({ streamId, chunk }) => {
      setStreaming((prev) => {
        if (prev?.streamId !== streamId) return prev;
        return { streamId, content: prev.content + chunk };
      });
    });

    const unsubEnd = window.forgeApi.onStreamEnd(({ streamId, message, cancelled }) => {
      if (cancelled) {
        setStreaming(null);
        setIsSending(false);
        setActiveStreamId(null);
        return;
      }
      if (message) {
        setMessages((prev) => {
          // Remove any existing placeholder then append final
          const filtered = prev.filter((m) => m.id !== `stream-${streamId}`);
          return [...filtered, message];
        });
      }
      setStreaming(null);
      setIsSending(false);
      setActiveStreamId(null);
    });

    const unsubErr = window.forgeApi.onStreamError(({ message }) => {
      setMessages((prev) => [...prev, message]);
      setStreaming(null);
      setIsSending(false);
      setActiveStreamId(null);
    });

    return () => {
      unsubChunk();
      unsubEnd();
      unsubErr();
    };
  }, []);

  // Auto-scroll to bottom
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming?.content]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content || isSending) return;

    setInput("");
    setIsSending(true);

    // Optimistically show user message
    const tempUserMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    const result = await window.forgeApi.sendMessage({ content });

    if (result.error && !result.streamId) {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempUserMsg.id),
        result.userMessage ?? tempUserMsg,
        {
          id: `err-${Date.now()}`,
          role: "error",
          content: result.error ?? "Request failed.",
          createdAt: Date.now(),
        },
      ]);
      setIsSending(false);
      return;
    }

    // Replace temp message with persisted one
    if (result.userMessage) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempUserMsg.id ? result.userMessage : m
        )
      );
    }

    setActiveStreamId(result.streamId);
    setStreaming({ streamId: result.streamId, content: "" });
  }, [input, isSending]);

  const handleCancel = useCallback(async () => {
    if (activeStreamId) {
      await window.forgeApi.cancelStream(activeStreamId);
    }
  }, [activeStreamId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const allMessages: Array<ChatMessage | { id: string; role: "streaming"; content: string }> =
    streaming
      ? [
          ...messages,
          {
            id: `stream-${streaming.streamId}`,
            role: "streaming" as const,
            content: streaming.content,
          },
        ]
      : messages;

  return (
    <div className="flex h-full flex-col bg-[#0d0d0f]">
      {/* Top bar */}
      <TopBar
        config={config}
        connectionStatus={connectionStatus}
        onSettings={() => setShowSettings(true)}
      />

      {/* Messages */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {allMessages.length === 0 ? (
          <EmptyState agentName={config?.name ?? "…"} />
        ) : (
          <div className="mx-auto w-full max-w-3xl px-6 py-6 space-y-1">
            {allMessages.map((msg) => (
              <MessageRow key={msg.id} message={msg} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 border-t border-[#1a1a1e] bg-[#0d0d0f] px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-3 rounded-xl border border-[#262629] bg-[#141416] px-4 py-3 focus-within:border-[#6366f1]/50 transition-colors">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message…"
              rows={1}
              disabled={isSending}
              className="flex-1 bg-transparent text-sm text-[#e8e8ec] placeholder-[#3a3a42] focus:outline-none disabled:opacity-50"
              style={{ minHeight: "24px", maxHeight: "180px" }}
            />
            <button
              onClick={() =>
                isSending ? void handleCancel() : void handleSend()
              }
              disabled={!isSending && input.trim() === ""}
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                isSending
                  ? "bg-[#f87171]/10 text-[#f87171] hover:bg-[#f87171]/20"
                  : "bg-[#6366f1] text-white hover:bg-[#7578f3]"
              }`}
              title={isSending ? "Stop" : "Send (Enter)"}
            >
              {isSending ? <StopIcon /> : <SendIcon />}
            </button>
          </div>
          <p className="mt-2 text-center text-[10px] text-[#3a3a42]">
            Enter to send · Shift+Enter for newline
          </p>
        </div>
      </div>

      {/* Settings modal */}
      {showSettings && config && (
        <SettingsModal
          config={config}
          onClose={() => setShowSettings(false)}
          onReconfigure={onReconfigure}
          onSave={async (updated) => {
            await window.forgeApi.saveConfig(updated);
            setConfig(updated);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}

// ── TopBar ──────────────────────────────────────────────────────────────────

function TopBar({
  config,
  connectionStatus,
  onSettings,
}: {
  config: AgentConfig | null;
  connectionStatus: "connected" | "connecting" | "error";
  onSettings: () => void;
}): React.ReactElement {
  const dotColor =
    connectionStatus === "connected"
      ? "#34d399"
      : connectionStatus === "connecting"
      ? "#fbbf24"
      : "#f87171";

  return (
    <div className="drag-region flex h-12 flex-shrink-0 items-center border-b border-[#1a1a1e] bg-[#0d0d0f] px-4">
      {/* macOS window controls space */}
      <div className="w-16 flex-shrink-0" />

      {/* Center: brand + agent */}
      <div className="flex flex-1 items-center justify-center gap-3">
        <span className="text-xs font-medium text-[#3a3a42]">
          Uzmoon Forge
        </span>
        <span className="text-[#262629]">·</span>
        <div className="flex items-center gap-1.5">
          <svg width="6" height="6" viewBox="0 0 8 8" fill="none">
            <circle cx="4" cy="4" r="3" fill={dotColor} />
          </svg>
          <span className="text-xs font-medium text-[#e8e8ec]">
            {config?.name ?? "…"}
          </span>
          {config?.model && (
            <span className="text-[10px] text-[#3a3a42]">
              {config.model}
            </span>
          )}
        </div>
      </div>

      {/* Settings button */}
      <div className="no-drag w-16 flex-shrink-0 flex items-center justify-end">
        <button
          onClick={onSettings}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#7a7a85] transition-colors hover:bg-[#1a1a1e] hover:text-[#e8e8ec]"
          title="Settings"
        >
          <GearIcon />
        </button>
      </div>
    </div>
  );
}

// ── EmptyState ──────────────────────────────────────────────────────────────

function EmptyState({ agentName }: { agentName: string }): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-16">
      <p className="text-sm text-[#3a3a42]">
        Start a conversation with{" "}
        <span className="text-[#7a7a85]">{agentName}</span>
      </p>
    </div>
  );
}

// ── MessageRow ──────────────────────────────────────────────────────────────

type DisplayMessage =
  | ChatMessage
  | { id: string; role: "streaming"; content: string };

function MessageRow({ message }: { message: DisplayMessage }): React.ReactElement {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  const isStreaming = message.role === "streaming";
  const isAssistant = message.role === "assistant" || isStreaming;

  if (isUser) {
    return (
      <div className="flex justify-end py-1.5">
        <div className="max-w-[75%] rounded-2xl bg-[#6366f1]/15 px-4 py-2.5 text-sm text-[#e8e8ec]">
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex justify-start py-1.5">
        <div className="max-w-[75%] rounded-2xl border border-[#f87171]/20 bg-[#f87171]/5 px-4 py-2.5 text-sm text-[#f87171]">
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        </div>
      </div>
    );
  }

  if (isAssistant) {
    return (
      <div className="flex justify-start py-1.5">
        <div className="prose-forge max-w-none w-full text-sm text-[#e8e8ec]">
          {isStreaming && message.content === "" ? (
            <StreamingCursor />
          ) : (
            <MarkdownContent content={message.content} />
          )}
          {isStreaming && message.content !== "" && (
            <StreamingCursor inline />
          )}
        </div>
      </div>
    );
  }

  return <></>;
}

// ── MarkdownContent ─────────────────────────────────────────────────────────

function MarkdownContent({ content }: { content: string }): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        p: ({ children }) => (
          <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>
        ),
        h1: ({ children }) => (
          <h1 className="mb-3 mt-4 text-lg font-semibold text-[#e8e8ec]">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-2 mt-4 text-base font-semibold text-[#e8e8ec]">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-2 mt-3 text-sm font-semibold text-[#e8e8ec]">
            {children}
          </h3>
        ),
        ul: ({ children }) => (
          <ul className="mb-3 list-disc pl-5 space-y-1">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-3 list-decimal pl-5 space-y-1">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-2 border-[#6366f1]/40 pl-3 text-[#7a7a85]">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-[#6366f1] underline underline-offset-2 hover:text-[#7578f3]"
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-[#e8e8ec]">{children}</strong>
        ),
        em: ({ children }) => (
          <em className="italic text-[#b8b8c4]">{children}</em>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.includes("language-");
          if (!isBlock) {
            return (
              <code className="rounded bg-[#1a1a1e] px-1.5 py-0.5 font-mono text-[0.8em] text-[#c4b5fd]">
                {children}
              </code>
            );
          }
          return (
            <code className={`${className ?? ""} text-[0.8em]`}>
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <CodeBlock>{children}</CodeBlock>
        ),
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto rounded-lg border border-[#262629]">
            <table className="w-full text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border-b border-[#262629] bg-[#141416] px-3 py-2 text-left font-medium text-[#7a7a85]">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border-b border-[#1a1a1e] px-3 py-2 text-[#e8e8ec]">
            {children}
          </td>
        ),
        hr: () => <hr className="my-4 border-[#262629]" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ── CodeBlock ────────────────────────────────────────────────────────────────

function CodeBlock({ children }: { children: React.ReactNode }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const getTextContent = (node: React.ReactNode): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(getTextContent).join("");
    if (React.isValidElement(node)) {
      const el = node as React.ReactElement<{ children?: React.ReactNode }>;
      return getTextContent(el.props.children);
    }
    return "";
  };

  const handleCopy = async (): Promise<void> => {
    const text = getTextContent(children);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-[#262629] bg-[#141416]">
      <button
        onClick={() => void handleCopy()}
        className="absolute right-3 top-3 flex h-7 items-center gap-1.5 rounded-md border border-[#262629] bg-[#1a1a1e] px-2.5 text-[10px] font-medium text-[#7a7a85] opacity-0 transition-all group-hover:opacity-100 hover:border-[#3a3a42] hover:text-[#e8e8ec]"
      >
        {copied ? (
          <>
            <CheckIcon />
            Copied
          </>
        ) : (
          <>
            <CopyIcon />
            Copy
          </>
        )}
      </button>
      <pre className="overflow-x-auto p-4 font-mono text-[0.8em] leading-relaxed text-[#e8e8ec]">
        {children}
      </pre>
    </div>
  );
}

// ── StreamingCursor ─────────────────────────────────────────────────────────

function StreamingCursor({ inline }: { inline?: boolean }): React.ReactElement {
  return inline ? (
    <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-[#6366f1]" />
  ) : (
    <span className="flex items-center gap-2 text-[#7a7a85] text-sm">
      <span className="flex gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#7a7a85] [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#7a7a85] [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#7a7a85] [animation-delay:300ms]" />
      </span>
    </span>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

function SendIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function StopIcon(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <rect width="10" height="10" rx="2" />
    </svg>
  );
}

function GearIcon(): React.ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CopyIcon(): React.ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}