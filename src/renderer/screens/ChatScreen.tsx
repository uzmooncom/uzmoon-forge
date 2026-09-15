import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import type { Conversation, ChatMessage, Attachment, AttachmentInput } from "../../shared/types.js";

// Chat sub-components
import { FileChip } from "../chat/components/FileChip.js";
import { Lightbox } from "../chat/components/Lightbox.js";
import { DeleteConfirmDialog } from "../chat/components/DeleteConfirmDialog.js";
import { MessageBubble } from "../chat/components/MessageBubble.js";
import { StreamingBubble } from "../chat/components/StreamingBubble.js";
import { ConversationItem } from "../chat/components/ConversationItem.js";

// Helpers, types, icons
import {
  randomId,
  groupConversationsByDate,
} from "../chat/helpers.js";
import {
  PlusIcon,
  SendIcon,
  StopIcon,
  PaperclipIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ArrowDownIcon,
  SettingsIcon,
  SearchIcon,
} from "../chat/icons.js";
import type { PendingAttachment, StreamingState, ReplyTarget } from "../chat/types.js";
import { blobUrlCache, draftStore } from "../chat/types.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 340;
const DEFAULT_SIDEBAR_WIDTH = 224;

// ── ChatScreen ─────────────────────────────────────────────────────────────

interface ChatScreenProps {
  onOpenSettings: () => void;
}

export default function ChatScreen({ onOpenSettings }: ChatScreenProps) {
  // ── Sidebar ────────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("forge:sidebarOpen") !== "false"; } catch { return true; }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return parseInt(localStorage.getItem("forge:sidebarWidth") ?? "", 10) || DEFAULT_SIDEBAR_WIDTH; } catch { return DEFAULT_SIDEBAR_WIDTH; }
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── Conversations ──────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);

  // ── Messages ───────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // ── Streaming (keyed by conversationId) ───────────────────────────────
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

  // ── Scroll ─────────────────────────────────────────────────────────────
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottom = useRef(true);

  // ── Composer ───────────────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Lightbox ───────────────────────────────────────────────────────────
  const [lightboxAtt, setLightboxAtt] = useState<Attachment | null>(null);

  // ── Delete confirm ─────────────────────────────────────────────────────
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── Draft conversation id ──────────────────────────────────────────────
  const draftConvId = useRef<string>(randomId());

  // ── Agent info ─────────────────────────────────────────────────────────
  const [agentName, setAgentName] = useState("AI Agent");
  const [modelName, setModelName] = useState("");

  // ── Sidebar resize ─────────────────────────────────────────────────────
  const resizingRef = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

  // ══════════════════════════════════════════════════════════════════════
  // Effects
  // ══════════════════════════════════════════════════════════════════════

  // Load agent info
  useEffect(() => {
    window.forgeApi.getAppState().then(async (state) => {
      if (state.agentConfigId) {
        const cfg = await window.forgeApi.getConfig(state.agentConfigId);
        if (cfg) { setAgentName(cfg.name); setModelName(cfg.model); }
      }
    });
  }, []);

  // Load conversations once
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

  // Load messages when conversation changes
  useEffect(() => {
    if (!activeConvId) { setMessages([]); return; }
    window.forgeApi.getConversationMessages(activeConvId).then(setMessages);
  }, [activeConvId]);

  // Persist sidebar prefs
  useEffect(() => {
    try { localStorage.setItem("forge:sidebarOpen", String(sidebarOpen)); } catch { /* */ }
  }, [sidebarOpen]);

  useEffect(() => {
    try { localStorage.setItem("forge:sidebarWidth", String(sidebarWidth)); } catch { /* */ }
  }, [sidebarWidth]);

  // Auto-scroll
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

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // Stream subscriptions
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
      if (convId) setStreamingMap((prev) => { const n = { ...prev }; delete n[convId]; return n; });
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
      if (!cancelled) void loadConversations();
    });

    const unsubErr = window.forgeApi.onStreamError(({ streamId, message }) => {
      if (activeStreamId.current !== streamId) return;
      const convId = activeStreamConvId.current;
      activeStreamId.current = null;
      activeStreamConvId.current = null;
      if (convId) setStreamingMap((prev) => { const n = { ...prev }; delete n[convId]; return n; });
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

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleNewConversation();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setShowSearch((v) => !v);
        setTimeout(() => searchRef.current?.focus(), 50);
        return;
      }
      if (e.key === "Escape" && replyTarget) {
        e.preventDefault();
        setReplyTarget(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTarget]);

  // ══════════════════════════════════════════════════════════════════════
  // Sidebar resize
  // ══════════════════════════════════════════════════════════════════════

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [sidebarWidth]
  );

  // ══════════════════════════════════════════════════════════════════════
  // Conversation actions
  // ══════════════════════════════════════════════════════════════════════

  const handleNewConversation = useCallback(() => {
    if (activeConvId && input.trim()) draftStore.set(activeConvId, { input });
    draftConvId.current = randomId();
    setActiveConvId(null);
    setMessages([]);
    setInput("");
    setPendingAttachments([]);
    setReplyTarget(null);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [activeConvId, input]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      if (activeConvId && activeConvId !== id && input.trim()) draftStore.set(activeConvId, { input });
      setActiveConvId(id);
      const saved = draftStore.get(id);
      setInput(saved?.input ?? "");
      setPendingAttachments([]);
      setReplyTarget(null);
      setTimeout(() => textareaRef.current?.focus(), 50);
    },
    [activeConvId, input]
  );

  const handleRename = useCallback(async (id: string, title: string) => {
    await window.forgeApi.updateConversation(id, { title });
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  const handleDeleteRequest = useCallback((id: string) => { setDeleteConfirmId(id); }, []);

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

  const handlePin = useCallback(
    async (id: string) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return;
      if (conv.pinnedAt) {
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
        const pinnedAt = Date.now();
        await window.forgeApi.updateConversation(id, { pinnedAt });
        setConversations((prev) => prev.map((c): Conversation => (c.id === id ? { ...c, pinnedAt } : c)));
      }
    },
    [conversations]
  );

  const handleArchive = useCallback(
    async (id: string) => {
      await window.forgeApi.updateConversation(id, { archivedAt: Date.now() });
      const updated = await loadConversations();
      if (activeConvId === id) {
        if (updated.length > 0) setActiveConvId(updated[0]!.id);
        else handleNewConversation();
      }
    },
    [activeConvId, loadConversations, handleNewConversation]
  );

  const handleExport = useCallback(
    async (id: string) => {
      const conv = conversations.find((c) => c.id === id);
      const markdown = await window.forgeApi.exportConversation(id);
      const blob = new Blob([markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(conv?.title ?? "conversation").replace(/[^a-z0-9]/gi, "-")}.md`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [conversations]
  );

  // Filtered + grouped conversations for sidebar
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupConversationsByDate(conversations);
    const q = searchQuery.toLowerCase();
    const filtered = conversations.filter((c) => c.title.toLowerCase().includes(q));
    return [{ label: "Results", items: filtered }];
  }, [conversations, searchQuery]);

  // ══════════════════════════════════════════════════════════════════════
  // Attachment handling
  // ══════════════════════════════════════════════════════════════════════

  const addFiles = useCallback(
    async (files: File[]) => {
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
    },
    [activeConvId, pendingAttachments.length]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) { addFiles(Array.from(e.target.files)); e.target.value = ""; }
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const fileItems = Array.from(e.clipboardData.items).filter((i) => i.kind === "file");
      if (fileItems.length > 0) {
        e.preventDefault();
        addFiles(fileItems.map((i) => i.getAsFile()).filter((f): f is File => f !== null));
      }
    },
    [addFiles]
  );

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

  // ══════════════════════════════════════════════════════════════════════
  // Send / Cancel / Retry / Edit / Quote
  // ══════════════════════════════════════════════════════════════════════

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
    draftStore.delete(convId);
    textareaRef.current?.focus();

    const optimisticId = randomId();
    const optimisticUserMsg: ChatMessage = {
      id: optimisticId,
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
      setMessages((prev) => prev.map((m) => m.id === optimisticId ? persistedUser : m));
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
          const filtered = prev.filter((m) => m.id !== optimisticId);
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

  const handleCancel = useCallback(async () => {
    const sid = activeStreamId.current;
    if (!sid) return;
    const convId = activeStreamConvId.current;
    activeStreamId.current = null;
    activeStreamConvId.current = null;
    if (convId) setStreamingMap((prev) => { const n = { ...prev }; delete n[convId]; return n; });
    await window.forgeApi.cancelStream(sid);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  const handleRetry = useCallback(async (_msg: ChatMessage) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser || !activeConvId) return;
    setInput(lastUser.content);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [messages, activeConvId]);

  const handleEdit = useCallback((msg: ChatMessage) => {
    setInput(msg.content);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 30);
  }, []);

  const handleQuote = useCallback((msg: ChatMessage) => {
    setReplyTarget({ messageId: msg.id, role: msg.role, content: msg.content });
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, []);

  const handleCopy = useCallback((text: string) => {
    window.forgeApi.copyText(text).catch(() => {});
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
    if (e.key === "Escape" && replyTarget) { e.preventDefault(); setReplyTarget(null); }
  };

  const deleteConvTitle = deleteConfirmId
    ? (conversations.find((c) => c.id === deleteConfirmId)?.title ?? "")
    : "";

  // ══════════════════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════════════════

  return (
    <div
      className="flex h-screen w-screen bg-[#0f0f17] text-white overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {lightboxAtt && <Lightbox att={lightboxAtt} onClose={() => setLightboxAtt(null)} />}
      {deleteConfirmId && (
        <DeleteConfirmDialog
          title={deleteConvTitle}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <div
        className={`flex-shrink-0 flex flex-col bg-[#13131e] border-r border-white/5 relative transition-[width] duration-200 ${sidebarOpen ? "" : "w-0 overflow-hidden"}`}
        style={sidebarOpen ? { width: sidebarWidth } : undefined}
      >
        {sidebarOpen && (
          <>
            {/* Header */}
            <div className="flex items-center gap-1 px-2 pt-3 pb-1 h-[44px] flex-shrink-0">
              <button
                onClick={() => { setShowSearch((v) => !v); setTimeout(() => searchRef.current?.focus(), 50); }}
                className={`flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${showSearch ? "text-white bg-white/10" : "text-white/30 hover:text-white hover:bg-white/8"}`}
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

            {/* Search */}
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
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Top bar */}
        <div className="flex items-center px-3 border-b border-white/5 gap-2 flex-shrink-0 h-[44px]">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="w-7 h-7 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 rounded-lg transition-colors"
          >
            {sidebarOpen ? <ChevronLeftIcon size={15} /> : <ChevronRightIcon size={15} />}
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
            <span className="text-sm font-medium text-white/80 truncate">{agentName}</span>
            {modelName && <span className="text-xs text-white/25 truncate hidden sm:block">{modelName}</span>}
          </div>
          <button
            onClick={onOpenSettings}
            className="w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/8 rounded-lg transition-colors"
          >
            <SettingsIcon size={15} />
          </button>
        </div>

        {/* Messages — centered column */}
        <div ref={scrollAreaRef} onScroll={handleScroll} className="flex-1 overflow-y-auto scroll-smooth">
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
                  <div className="text-white/35 text-sm mt-3">Start a conversation · Paste or drag files to attach</div>
                  <div className="text-white/20 text-xs mt-2">⌘N new chat · ⌘F search · Shift+Enter new line</div>
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

        {/* Jump-to-bottom */}
        {showScrollBtn && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-28 right-6 w-8 h-8 rounded-full bg-[#1e1e2e] border border-white/10 shadow-xl flex items-center justify-center text-white/50 hover:text-white hover:border-white/20 transition-all z-10"
          >
            <ArrowDownIcon size={14} />
          </button>
        )}

        {/* ── Composer ─────────────────────────────────────────────── */}
        <div className="flex-shrink-0 px-4 pb-4 pt-2">
          <div className="max-w-[800px] mx-auto">
            {/* Reply banner */}
            {replyTarget && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-white/5 border border-white/8 rounded-xl text-xs">
                <span className="text-white/40">↩ Replying to</span>
                <span className={`font-medium ${replyTarget.role === "user" ? "text-blue-300" : "text-violet-300"}`}>
                  {replyTarget.role === "user" ? "You" : "Agent"}
                </span>
                <span className="text-white/30 truncate flex-1">
                  {replyTarget.content.slice(0, 80)}{replyTarget.content.length > 80 ? "…" : ""}
                </span>
                <button onClick={() => setReplyTarget(null)} className="text-white/30 hover:text-white ml-1">✕</button>
              </div>
            )}

            <div className="relative bg-[#1a1a27] border border-white/8 rounded-2xl focus-within:border-white/15 transition-colors">
              <div className="flex items-end px-3 pt-2.5 pb-1 gap-2">
                {/* Attach */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={pendingAttachments.length >= 10}
                  title="Attach file"
                  className="flex-shrink-0 mb-1 w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/5 rounded-lg transition-colors disabled:opacity-20 disabled:pointer-events-none"
                >
                  <PaperclipIcon size={16} />
                </button>
                <input ref={fileInputRef} type="file" accept="*/*" multiple className="hidden" onChange={handleFileChange} />

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
                    onClick={() => { void handleSend(); }}
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
                    <FileChip key={att.id} att={att} onRemove={() => removeAttachment(att.id)} />
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