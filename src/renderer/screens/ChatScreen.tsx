import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import type {
  Conversation,
  ChatMessage,
  Attachment,
  AttachmentInput,
  QueueItem,
  ConvQueueState,
  AgentProfile,
  ConvRuntimeState,
  TaskRuntimeSnapshot,
  ForgeTaskStep,
} from "../../shared/types.js";

// Chat sub-components
import { FileChip } from "../chat/components/FileChip.js";
import { ContextChips } from "../project/ContextChips.js";
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
  InboxIcon,
  TrashIcon,
  PencilIcon,
} from "../chat/icons.js";
import type { PendingAttachment, StreamingState, ReplyTarget } from "../chat/types.js";
import { blobUrlCache, draftStore } from "../chat/types.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 340;
const DEFAULT_SIDEBAR_WIDTH = 224;
const LONG_MSG_THRESHOLD = 4000;

// ── QueuePanel ─────────────────────────────────────────────────────────────

interface QueuePanelProps {
  convId: string;
  queueState: ConvQueueState | null;
  isStreaming: boolean;
  onResume: () => void;
  onRetry: (itemId: string) => void;
  onSkip: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onEdit: (item: QueueItem) => void;
}

function QueuePanel({
  convId: _convId,
  queueState,
  isStreaming,
  onResume,
  onRetry,
  onSkip,
  onRemove,
  onEdit,
}: QueuePanelProps) {
  if (!queueState) return null;

  // ACTIVE: currently processing (owned by StreamingBubble, just its queue entry)
  // WAITING: truly queued, waiting behind active
  // The active/processing item must NOT be counted as "queued" in the label
  const waitingItems = queueState.items.filter(
    (i) => i.status === "queued" || i.status === "paused"
  );
  const failed = queueState.items.filter((i) => i.status === "failed");

  if (waitingItems.length === 0 && failed.length === 0 && !queueState.paused && !isStreaming) return null;
  // Also skip if ONLY streaming with no waiting/failed items — StreamingBubble covers that
  if (isStreaming && waitingItems.length === 0 && failed.length === 0 && !queueState.paused) return null;

  return (
    <div className="mx-4 mb-2 max-w-[800px] mx-auto">
      <div className="bg-[#1a1a27] border border-white/8 rounded-xl overflow-hidden">
        {/* Header — only shown when there are waiting/paused/failed items */}
        {(waitingItems.length > 0 || failed.length > 0 || queueState.paused) && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
          <div
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              isStreaming
                ? "bg-blue-400 animate-pulse"
                : queueState.paused
                ? "bg-amber-400"
                : "bg-emerald-400"
            }`}
          />
          <span className="text-xs text-white/50 flex-1">
            {queueState.paused && !isStreaming
              ? "Queue paused"
              : `${waitingItems.length} message${waitingItems.length !== 1 ? "s" : ""} queued`}
          </span>
          {queueState.paused && !isStreaming && (
            <button
              onClick={onResume}
              className="text-[11px] px-2 py-0.5 rounded-md bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
            >
              Resume
            </button>
          )}
        </div>
        )}

        {/* Failed items */}
        {failed.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-2 px-3 py-2 border-b border-white/5 bg-red-900/10"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-red-400/70 mb-0.5">Failed — use Retry or Skip to continue</div>
              <div className="text-xs text-white/60 truncate">{item.content.slice(0, 80)}</div>
              {/* lastError suppressed here — the error message is already shown in the chat above */}
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <button
                onClick={() => onRetry(item.id)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors"
              >
                Retry
              </button>
              <button
                onClick={() => onSkip(item.id)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors"
              >
                Skip
              </button>
            </div>
          </div>
        ))}

        {/* Queued items — excludes the currently-processing item */}
        {waitingItems
          .map((item) => (
            <div
              key={item.id}
              className="flex items-start gap-2 px-3 py-2 border-b border-white/5 last:border-b-0"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-white/30 mb-0.5">
                  {item.status === "paused" ? "Paused" : "Queued"}
                </div>
                <div className="text-xs text-white/60 truncate">
                  {item.content.slice(0, 80)}
                  {item.content.length > 80 ? "…" : ""}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => onEdit(item)}
                  className="w-6 h-6 flex items-center justify-center rounded bg-white/5 text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
                  title="Edit message"
                >
                  <PencilIcon size={10} />
                </button>
                <button
                  onClick={() => onRemove(item.id)}
                  className="w-6 h-6 flex items-center justify-center rounded bg-white/5 text-white/30 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                  title="Remove from queue"
                >
                  <TrashIcon size={10} />
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

// ── TaskStatusPanel ───────────────────────────────────────────────────────

interface TaskStatusPanelProps {
  snapshot: TaskRuntimeSnapshot | null;
  convId: string;
  onPause: () => void;
  onResume: (taskId: string) => void;
  onCancel: (taskId: string) => void;
}

function stepStatusIcon(status: ForgeTaskStep["status"]): string {
  switch (status) {
    case "completed":    return "●";
    case "running":      return "◎";
    case "failed":       return "✕";
    case "blocked":      return "⊘";
    case "skipped":      return "→";
    case "interrupted":  return "⏸";
    case "cancelled":    return "–";
    default:             return "○";
  }
}

function stepStatusColor(status: ForgeTaskStep["status"]): string {
  switch (status) {
    case "completed":    return "text-emerald-400";
    case "running":      return "text-blue-400";
    case "failed":       return "text-red-400";
    case "blocked":      return "text-amber-400";
    case "skipped":      return "text-white/30";
    case "interrupted":  return "text-amber-300";
    case "cancelled":    return "text-white/20";
    default:             return "text-white/30";
  }
}

function taskStatusLabel(status: string): string {
  switch (status) {
    case "planning":  return "Planning";
    case "running":   return "Running";
    case "verifying": return "Verifying";
    case "paused":    return "Paused";
    case "completed": return "Completed";
    case "failed":    return "Failed";
    case "cancelled": return "Cancelled";
    default:          return status;
  }
}

function taskStatusDot(status: string): string {
  switch (status) {
    case "planning":
    case "running":
    case "verifying": return "bg-blue-400 animate-pulse";
    case "paused":    return "bg-amber-400";
    case "completed": return "bg-emerald-400";
    case "failed":    return "bg-red-400";
    case "cancelled": return "bg-white/20";
    default:          return "bg-white/30";
  }
}

function TaskStatusPanel({ snapshot, convId: _convId, onPause, onResume, onCancel }: TaskStatusPanelProps) {
  // Hooks must come before any early returns
  const isTerminalInit = snapshot
    ? ["completed", "failed", "cancelled"].includes(snapshot.task.status)
    : false;
  // Terminal tasks start collapsed — click header to expand
  const [collapsed, setCollapsed] = React.useState(isTerminalInit);

  if (!snapshot) return null;

  const { task, plan } = snapshot;
  const isActive = ["planning", "running", "verifying"].includes(task.status);
  const isPaused = task.status === "paused";
  const isTerminal = ["completed", "failed", "cancelled"].includes(task.status);

  const completedCount = plan.steps.filter(s => s.status === "completed" || s.status === "skipped").length;
  const totalCount = plan.steps.length;
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  if (collapsed) {
    return (
      <div
        className="mb-1 rounded-xl border border-white/8 bg-white/3 overflow-hidden cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setCollapsed(false)}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${taskStatusDot(task.status)}`} />
          <span className="text-xs text-white/50 flex-1 truncate">{task.goal.slice(0, 80)}</span>
          <span className={`text-xs font-medium ${
            task.status === "completed" ? "text-emerald-400" :
            task.status === "failed" ? "text-red-400" : "text-white/30"
          }`}>{taskStatusLabel(task.status)}</span>
          <span className="text-xs text-white/30 ml-1">▸</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-1 rounded-xl border border-white/8 bg-white/3 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${taskStatusDot(task.status)}`} />
        <span className="text-xs font-medium text-white/80 flex-1 min-w-0 truncate">
          {task.goal}
        </span>
        <span className="text-xs text-white/40 flex-shrink-0">{taskStatusLabel(task.status)}</span>
        {/* Controls */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {isTerminal && (
            <button
              onClick={() => setCollapsed(true)}
              className="text-xs px-1.5 py-0.5 rounded text-white/25 hover:text-white/50 transition-colors"
              title="Collapse"
            >
              ▾
            </button>
          )}
          {isActive && (
            <button
              onClick={onPause}
              className="text-xs px-2 py-0.5 rounded bg-white/8 hover:bg-white/12 text-white/60 hover:text-white/90 transition-colors"
            >
              Pause
            </button>
          )}
          {isPaused && (
            <button
              onClick={() => onResume(task.id)}
              className="text-xs px-2 py-0.5 rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 hover:text-blue-200 transition-colors"
            >
              Resume
            </button>
          )}
          {!isTerminal && (
            <button
              onClick={() => onCancel(task.id)}
              className="text-xs px-2 py-0.5 rounded bg-white/5 hover:bg-red-500/20 text-white/40 hover:text-red-300 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="flex-1 h-0.5 bg-white/8 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  task.status === "completed" ? "bg-emerald-400" :
                  task.status === "failed" ? "bg-red-400" : "bg-blue-400"
                }`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-xs text-white/30 flex-shrink-0">{completedCount}/{totalCount}</span>
          </div>

          {/* Step list */}
          <div className="flex flex-col gap-0.5">
            {plan.steps.map((step) => (
              <div key={step.id} className="flex items-center gap-1.5">
                <span className={`text-xs font-mono flex-shrink-0 ${stepStatusColor(step.status)}`}>
                  {stepStatusIcon(step.status)}
                </span>
                <span className={`text-xs truncate ${
                  step.status === "running" ? "text-white/80" :
                  step.status === "completed" || step.status === "skipped" ? "text-white/40" :
                  step.status === "failed" ? "text-red-300" :
                  "text-white/50"
                }`}>
                  {step.title}
                </span>
                {step.status === "running" && (
                  <span className="flex-shrink-0 w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ChatScreen ─────────────────────────────────────────────────────────────

interface ChatScreenProps {
  onOpenSettings: () => void;
  /**
   * When provided: scopes the sidebar and all conversation operations to this project.
   * When undefined/null: Global Chat mode (conversations with no projectId).
   */
  projectId?: string | null;
  /** Staged project-file context refs to attach with next message (V0.2) */
  stagedContextRefs?: Array<{
    projectId: string;
    relativePath: string;
    lineStart?: number;
    lineEnd?: number;
  }>;
  /** Staged context chips for display in composer (V0.2) */
  stagedContextChips?: import("../../shared/types.js").ContextChip[];
  /** Remove one staged chip by id (V0.2) */
  onRemoveContextChip?: (chipId: string) => void;
  /** Called after message is sent so parent can clear staged context (V0.2) */
  onClearContext?: () => void;
}

export default function ChatScreen({
  onOpenSettings,
  projectId = null,
  stagedContextRefs,
  stagedContextChips,
  onRemoveContextChip,
  onClearContext,
}: ChatScreenProps) {
  // projectId=null → Global Chat (conversations where projectId is null/undefined)
  // projectId=string → Project Chat (conversations scoped to that project)
  // ── Sidebar ────────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("forge:sidebarOpen") !== "false"; } catch { return true; }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return parseInt(localStorage.getItem("forge:sidebarWidth") ?? "", 10) || DEFAULT_SIDEBAR_WIDTH; } catch { return DEFAULT_SIDEBAR_WIDTH; }
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
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
  // Map<streamId, convId> so we can route chunks/end events
  const streamConvMap = useRef<Map<string, string>>(new Map());

  const setStreaming = useCallback((value: StreamingState | null, convId: string) => {
    if (value !== null) {
      setStreamingMap((prev) => ({ ...prev, [convId]: value }));
    } else {
      setStreamingMap((prev) => { const n = { ...prev }; delete n[convId]; return n; });
    }
  }, []);

  // ── Queue state (keyed by conversationId) ─────────────────────────────
  const [queueMap, setQueueMap] = useState<Record<string, ConvQueueState>>({});
  const activeQueueState = activeConvId ? (queueMap[activeConvId] ?? null) : null;

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

  // ── Editing queue item ──────────────────────────────────────────────────
  const [editingQueueItemId, setEditingQueueItemId] = useState<string | null>(null);

  // ── Lightbox ───────────────────────────────────────────────────────────
  const [lightboxAtt, setLightboxAtt] = useState<Attachment | null>(null);

  // ── Delete confirm ─────────────────────────────────────────────────────
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── waiting_for_human — per-conversation map (V17 fix: was single string, caused cross-conv contamination)
  // conversationId → requestId of the currently-waiting run (run-scoped)
  const [waitingForHumanMap, setWaitingForHumanMap] = useState<Record<string, string | true>>({}); 

  // ── Draft conversation id ──────────────────────────────────────────────
  const draftConvId = useRef<string>(randomId());

  // ── Agent profiles ─────────────────────────────────────────────────────
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const profileDropdownRef = useRef<HTMLDivElement>(null);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? profiles[0] ?? null,
    [profiles, selectedProfileId]
  );
  const agentName = activeProfile?.name ?? "AI Agent";
  const modelName = activeProfile?.model ?? "";

  // ── Task runtime ────────────────────────────────────────────────────────
  // taskHistoryMap: convId → sorted array of snapshots (all tasks, newest last)
  const [taskHistoryMap, setTaskHistoryMap] = useState<Record<string, TaskRuntimeSnapshot[]>>({});

  // ── Sidebar resize ─────────────────────────────────────────────────────
  const resizingRef = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

  // ══════════════════════════════════════════════════════════════════════
  // Effects
  // ══════════════════════════════════════════════════════════════════════

  // Load profiles
  const loadProfiles = useCallback(async () => {
    const ps = await window.forgeApi.listProfiles();
    setProfiles(ps);
    return ps;
  }, []);

  useEffect(() => {
    loadProfiles().then((ps) => {
      const defaultP = ps.find((p) => p.isDefault) ?? ps[0];
      if (defaultP) setSelectedProfileId(defaultP.id);
    });
  }, [loadProfiles]);

  // Close profile dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (profileDropdownRef.current && !profileDropdownRef.current.contains(e.target as Node)) {
        setShowProfileDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // When active conversation changes, sync its preferred profile
  useEffect(() => {
    if (!activeConvId) return;
    window.forgeApi.getConversation(activeConvId).then((conv) => {
      if (conv?.defaultAgentProfileId) {
        setSelectedProfileId(conv.defaultAgentProfileId);
      } else {
        setProfiles((ps) => {
          const defaultP = ps.find((p) => p.isDefault) ?? ps[0];
          if (defaultP) setSelectedProfileId(defaultP.id);
          return ps;
        });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId]);

  // Load all tasks for the active conversation on switch (gated on feature flag)
  useEffect(() => {
    if (!activeConvId) return;
    const enabled = window.__forgeTasksEnabled ?? false;
    if (!enabled) return;
    // Load ALL tasks for this conv (including completed) for history display
    window.forgeApi.tasks.listByConv(activeConvId).then((tasks) => {
      if (!tasks || tasks.length === 0) return;
      // For each task, get the full snapshot (task + plan)
      Promise.all(
        tasks.map((t: { id: string }) =>
          window.forgeApi.tasks.getTask(t.id).then(
            // IPC returns {task, plan} — wrap to TaskRuntimeSnapshot shape
            (raw: { task: import("../../shared/types.js").ForgeTask; plan: import("../../shared/types.js").ForgeTaskPlan } | null): TaskRuntimeSnapshot | null =>
              raw ? { task: raw.task, plan: raw.plan, revision: 0 } : null
          )
        )
      ).then((snaps: (TaskRuntimeSnapshot | null)[]) => {
        const valid = snaps.filter((s): s is TaskRuntimeSnapshot => s !== null);
        if (valid.length === 0) return;
        valid.sort((a, b) => a.task.createdAt - b.task.createdAt);
        setTaskHistoryMap((prev) => ({ ...prev, [activeConvId]: valid }));
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId]);

  // Subscribe to task events (all convs) — gated on feature flag
  useEffect(() => {
    const enabled = window.__forgeTasksEnabled ?? false;
    if (!enabled) return;

    const upsertSnapshot = (snap: TaskRuntimeSnapshot) => {
      const convId = snap.task.conversationId;
      setTaskHistoryMap((prev) => {
        const existing = prev[convId] ?? [];
        const idx = existing.findIndex((s) => s.task.id === snap.task.id);
        let updated: TaskRuntimeSnapshot[];
        if (idx >= 0) {
          updated = [...existing];
          updated[idx] = snap;
        } else {
          updated = [...existing, snap];
        }
        // Keep sorted by createdAt ascending
        updated.sort((a, b) => a.task.createdAt - b.task.createdAt);
        return { ...prev, [convId]: updated };
      });
    };

    const unsub1 = window.forgeApi.tasks.onTaskCreated(upsertSnapshot);
    const unsub2 = window.forgeApi.tasks.onTaskUpdated(upsertSnapshot);
    const unsub3 = window.forgeApi.tasks.onTaskTerminal(upsertSnapshot); // keep in history
    const unsub4 = window.forgeApi.tasks.onTaskReplanned(upsertSnapshot);
    const unsub5 = window.forgeApi.tasks.onStepUpdated(({ snapshot }) => upsertSnapshot(snapshot));
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); };
  }, []);

  // Load conversations — scoped by projectId (null = global, string = project)
  const loadConversations = useCallback(async () => {
    const convs = await window.forgeApi.listConversations(showArchived, projectId);
    setConversations(convs);
    return convs;
  }, [showArchived, projectId]);

  // Stable ref so IPC subscriptions never re-register just because showArchived/projectId changed
  const loadConversationsRef = useRef(loadConversations);
  useEffect(() => { loadConversationsRef.current = loadConversations; }, [loadConversations]);

  useEffect(() => { void loadConversations(); }, [showArchived, loadConversations, projectId]);

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
    // Also fetch queue state for this conversation
    window.forgeApi.getQueue(activeConvId).then((q) => {
      if (q.items.length > 0 || q.paused) {
        setQueueMap((prev) => ({
          ...prev,
          [activeConvId]: { conversationId: activeConvId, ...q },
        }));
      }
    });
  }, [activeConvId]);

  // ── Runtime state hydration ─────────────────────────────────────────────
  // When returning to a conversation that has an active AgentRun, reconstruct
  // the transient streaming UI from the authoritative main-process registry.
  //
  // Subscribe-first pattern: IPC listeners are registered at component mount
  // (the effect below). Hydration queries happen here AFTER listeners are up,
  // so we can never miss a STREAM_END that races the hydration response.
  // If the run completes between our query and the subscription being active,
  // the STREAM_END event will still fire and clear streaming state correctly.
  const lastHydratedConvRef = useRef<string | null>(null);
  const lastHydratedRevisionRef = useRef<number>(-1);

  useEffect(() => {
    if (!activeConvId) return;

    // Reset hydration tracking for the new conversation
    lastHydratedConvRef.current = activeConvId;
    lastHydratedRevisionRef.current = -1;

    // Query authoritative runtime state
    void window.forgeApi.getRuntimeState(activeConvId).then((state: ConvRuntimeState | null) => {
      // Guard: user may have switched away before promise resolved
      if (lastHydratedConvRef.current !== activeConvId) return;
      if (!state) {
        // No active run — clear any stale streaming state for this conv
        // (handles: run completed while renderer was unmounted)
        setStreamingMap((prev) => {
          const cur = prev[activeConvId];
          if (!cur) return prev;
          // Only clear if this was a hydrated ghost, not a real live subscription
          const n = { ...prev };
          delete n[activeConvId];
          return n;
        });
        return;
      }

      // Guard against overwriting newer local state (event arrived before hydration)
      const existingRevision = lastHydratedRevisionRef.current;
      if (existingRevision >= state.revision) return;
      lastHydratedRevisionRef.current = state.revision;

      // Register streamId↔convId mapping so future chunk/tool/end events work
      streamConvMap.current.set(state.streamId, activeConvId);

      // Reconstruct streaming state — text may be empty (tools still running)
      setStreaming(
        { streamId: state.streamId, text: "", conversationId: activeConvId },
        activeConvId
      );
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId]);

  // Persist sidebar prefs
  useEffect(() => {
    try { localStorage.setItem("forge:sidebarOpen", String(sidebarOpen)); } catch { /**/ }
  }, [sidebarOpen]);

  useEffect(() => {
    try { localStorage.setItem("forge:sidebarWidth", String(sidebarWidth)); } catch { /**/ }
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
    const unsubStart = window.forgeApi.onStreamStart(({ streamId, userMessage, conversation }) => {
      const convId = conversation?.id ?? userMessage?.conversationId;
      if (!convId) return;
      streamConvMap.current.set(streamId, convId);
      // Bump revision so a stale hydration response doesn't overwrite this live event
      if (convId === lastHydratedConvRef.current) {
        lastHydratedRevisionRef.current = Number.MAX_SAFE_INTEGER;
      }
      // If this conversation was waiting for human, clear the banner on resume
      setWaitingForHumanMap((prev) => {
        if (!prev[convId]) return prev;
        const next = { ...prev };
        delete next[convId];
        return next;
      });
      setStreaming({ streamId, text: "", conversationId: convId }, convId);
      if (conversation) {
        setConversations((prev) => {
          const exists = prev.find((c) => c.id === conversation.id);
          if (!exists) return [conversation, ...prev];
          return prev.map((c) => (c.id === conversation.id ? conversation : c));
        });
      }
    });

    const unsubChunk = window.forgeApi.onStreamChunk(({ streamId, chunk }) => {
      const convId = streamConvMap.current.get(streamId);
      if (!convId) return;
      setStreamingMap((prev) => {
        const cur = prev[convId];
        if (!cur || cur.streamId !== streamId) return prev;
        return { ...prev, [convId]: { ...cur, text: cur.text + chunk } };
      });
    });

    const unsubEnd = window.forgeApi.onStreamEnd(({ streamId, message, cancelled, conversation }) => {
      const convId = streamConvMap.current.get(streamId);
      streamConvMap.current.delete(streamId);
      if (!convId) return;
      setStreaming(null, convId);
      if (message) {
        if (convId === activeConvIdRef.current) {
          setMessages((prev) => {
            // avoid duplicate if already appended
            if (prev.find((m) => m.id === message.id)) return prev;
            return [...prev, message];
          });
        }
      }
      if (conversation) {
        setConversations((prev) => {
          const exists = prev.find((c) => c.id === conversation.id);
          if (!exists) return [conversation, ...prev];
          return prev.map((c) => (c.id === conversation.id ? conversation : c));
        });
      }
      if (!cancelled) void loadConversationsRef.current();
    });

    const unsubErr = window.forgeApi.onStreamError(({ streamId, message }) => {
      const convId = streamConvMap.current.get(streamId);
      streamConvMap.current.delete(streamId);
      if (!convId) return;
      setStreaming(null, convId);
      if (convId === activeConvIdRef.current) {
        setMessages((prev) => {
          if (prev.find((m) => m.id === message.id)) return prev;
          return [...prev, message];
        });
      }
    });

    const unsubQueue = window.forgeApi.onQueueState((state) => {
      setQueueMap((prev) => ({ ...prev, [state.conversationId]: state }));
      // When queue completes a message, reload messages for active conv
      const hasCompletedNew = state.items.some((i) => i.status === "completed");
      if (hasCompletedNew && state.conversationId === activeConvIdRef.current) {
        // Messages are updated via stream end — no need to reload here
      }
    });

    const unsubWaiting = window.forgeApi.browser.onWaitingForHuman(({ conversationId, requestId }) => {
      // Store the requestId so Return Control can be run-scoped
      setWaitingForHumanMap((prev) => ({ ...prev, [conversationId]: requestId ?? true }));
    });

    return () => {
      unsubStart();
      unsubChunk();
      unsubEnd();
      unsubErr();
      unsubQueue();
      unsubWaiting();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setStreaming]);

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
    setEditingQueueItemId(null);
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
      setEditingQueueItemId(null);
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
  // Queue actions
  // ══════════════════════════════════════════════════════════════════════

  const handleQueueResume = useCallback(() => {
    if (!activeConvId) return;
    void window.forgeApi.resumeQueue(activeConvId);
  }, [activeConvId]);

  const handleQueueRetry = useCallback((itemId: string) => {
    if (!activeConvId) return;
    void window.forgeApi.resumeQueue(activeConvId, "retry", itemId);
  }, [activeConvId]);

  const handleQueueSkip = useCallback((itemId: string) => {
    if (!activeConvId) return;
    void window.forgeApi.resumeQueue(activeConvId, "skip", itemId);
  }, [activeConvId]);

  const handleQueueRemove = useCallback((itemId: string) => {
    if (!activeConvId) return;
    void window.forgeApi.removeQueueItem(activeConvId, itemId);
    // Also remove the optimistic message from view
    setMessages((prev) => {
      const qs = queueMap[activeConvId];
      if (!qs) return prev;
      const item = qs.items.find((i) => i.id === itemId);
      if (!item) return prev;
      return prev.filter((m) => m.id !== item.messageId);
    });
  }, [activeConvId, queueMap]);

  const handleQueueEdit = useCallback((item: QueueItem) => {
    setInput(item.content);
    setEditingQueueItemId(item.id);
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, []);

  // ── Task action handlers ───────────────────────────────────────────────
  const handleTaskPause = useCallback(() => {
    if (!activeConvId) return;
    void window.forgeApi.tasks.pause(activeConvId);
  }, [activeConvId]);

  const handleTaskResume = useCallback((taskId: string) => {
    void window.forgeApi.tasks.resume(taskId);
  }, []);

  const handleTaskCancel = useCallback((taskId: string) => {
    void window.forgeApi.tasks.cancel(taskId);
  }, []);

  const handleEditQueueItemSubmit = useCallback(async () => {
    if (!activeConvId || !editingQueueItemId || !input.trim()) return;
    const ok = await window.forgeApi.editQueueItem(activeConvId, editingQueueItemId, input.trim());
    if (ok) {
      // Update displayed message immediately
      setMessages((prev) => {
        const qs = queueMap[activeConvId];
        const item = qs?.items.find((i) => i.id === editingQueueItemId);
        if (!item) return prev;
        return prev.map((m) =>
          m.id === item.messageId ? { ...m, content: input.trim() } : m
        );
      });
    }
    setEditingQueueItemId(null);
    setInput("");
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, [activeConvId, editingQueueItemId, input, queueMap]);

  // ══════════════════════════════════════════════════════════════════════
  // Send / Cancel / Retry / Edit / Quote
  // ══════════════════════════════════════════════════════════════════════

  // Queue allows sending even while streaming
  const canSend =
    (input.trim() !== "" || pendingAttachments.some((a) => a.savedId)) &&
    !pendingAttachments.some((a) => a.uploading);

  const handleSend = useCallback(async () => {
    // If we're editing a queue item, submit the edit instead
    if (editingQueueItemId) {
      await handleEditQueueItemSubmit();
      return;
    }

    if (!canSend) return;
    let content = input.trim();
    const convId = activeConvId ?? draftConvId.current;
    const attachmentIds = pendingAttachments.filter((a) => a.savedId).map((a) => a.savedId!);

    // Auto-file: if message exceeds threshold, upload excess as a .txt
    if (content.length > LONG_MSG_THRESHOLD) {
      const fullText = content;
      const preview = content.slice(0, 120).replace(/\n/g, " ");
      content = `[Long message — see attached file for full text]\n\nPreview: ${preview}…`;
      const blob = new Blob([fullText], { type: "text/plain" });
      const file = new File([blob], "message.txt", { type: "text/plain" });
      const previewUrl = URL.createObjectURL(blob);
      const pending: PendingAttachment = {
        id: randomId(), file, previewUrl, mimeType: "text/plain", uploading: true,
      };
      setPendingAttachments((prev) => [...prev, pending]);
      const b64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (evt) => resolve(((evt.target?.result as string).split(",")[1]) ?? "");
        reader.readAsDataURL(file);
      });
      const res = await window.forgeApi.saveAttachment(convId, {
        data: b64, mimeType: "text/plain", filename: "message.txt", size: blob.size,
      });
      if (res.ok) {
        blobUrlCache.set(res.attachment.id, previewUrl);
        attachmentIds.push(res.attachment.id);
        setPendingAttachments((prev) =>
          prev.map((p) => p.id === pending.id ? { ...p, uploading: false, savedId: res.attachment.id } : p)
        );
      } else {
        setPendingAttachments((prev) => prev.filter((p) => p.id !== pending.id));
        URL.revokeObjectURL(previewUrl);
        content = fullText; // fallback
      }
    }

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

    // Optimistic user message in UI
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

    // Set active conversation immediately for new drafts
    if (!activeConvId) {
      setActiveConvId(convId);
      draftConvId.current = randomId();
    }

    const res = await window.forgeApi.sendMessage({
      conversationId: convId,
      content,
      ...(attachmentIds.length > 0 && { attachmentIds }),
      ...(reply && { replyToMessageId: reply.messageId }),
      ...(selectedProfileId && { targetAgentProfileId: selectedProfileId }),
      // For new conversations in project context: stamp the projectId
      // Ignored by main if conv already exists (its own projectId wins)
      ...(projectId != null && { projectId }),
      // V0.2: attach file context snapshots if any are staged
      ...(stagedContextRefs && stagedContextRefs.length > 0 && { stagedContextRefs }),
    });

    // Clear staged context after send
    if (stagedContextRefs && stagedContextRefs.length > 0) {
      onClearContext?.();
    }

    if (res.error) {
      // Remove optimistic, show error
      setMessages((prev) => {
        const filtered = prev.filter((m) => m.id !== optimisticId);
        return [...filtered, {
          id: randomId(), conversationId: convId, role: "error" as const,
          content: res.error!, createdAt: Date.now(), isError: true,
        }];
      });
      return;
    }

    // Replace optimistic with persisted user message
    if (res.userMessage) {
      const persisted = res.userMessage;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId
            ? {
                ...persisted,
                ...(pendingAttsSnapshot.length > 0 && { attachments: pendingAttsSnapshot }),
                ...(reply && { replyToMessageId: reply.messageId }),
              }
            : m
        )
      );
    }

    // Update conversation in sidebar
    if (res.conversation) {
      setConversations((prev) => {
        const exists = prev.find((c) => c.id === res.conversation!.id);
        if (!exists) return [res.conversation!, ...prev];
        return prev.map((c) => (c.id === res.conversation!.id ? res.conversation! : c));
      });
    }
  }, [
    editingQueueItemId,
    handleEditQueueItemSubmit,
    canSend,
    input,
    activeConvId,
    pendingAttachments,
    replyTarget,
    selectedProfileId,
    projectId,
    stagedContextRefs,
    onClearContext,
  ]);

  const handleCancel = useCallback(async () => {
    if (!activeConvId) return;
    await window.forgeApi.cancelStream(activeConvId);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [activeConvId]);

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
    if (e.key === "Escape") {
      if (editingQueueItemId) { setEditingQueueItemId(null); setInput(""); return; }
      if (replyTarget) { e.preventDefault(); setReplyTarget(null); }
    }
  };

  const deleteConvTitle = deleteConfirmId
    ? (conversations.find((c) => c.id === deleteConfirmId)?.title ?? "")
    : "";

  // Send button label
  const sendLabel = editingQueueItemId ? "Update" : "Send";
  const sendDisabled = editingQueueItemId ? !input.trim() : !canSend;

  // ══════════════════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════════════════

  return (
    <div
      className="flex h-full w-full bg-[#0f0f17] text-white overflow-hidden"
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
                onClick={() => setShowArchived((v) => !v)}
                className={`flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
                  showArchived ? "text-amber-400 bg-amber-400/10" : "text-white/30 hover:text-white hover:bg-white/8"
                }`}
                title={showArchived ? "Hide archived" : "Show archived"}
              >
                <InboxIcon size={14} />
              </button>
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

          {/* Agent profile selector */}
          <div className="flex items-center gap-2 flex-1 min-w-0" ref={profileDropdownRef}>
            {profiles.length <= 1 ? (
              <div className="flex items-center gap-2 min-w-0">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  activeProfile?.lastConnectionStatus === "connected" ? "bg-emerald-500" :
                  activeProfile?.lastConnectionStatus === "error" ? "bg-red-500" :
                  "bg-white/20"
                }`} />
                <span className="text-sm font-medium text-white/80 truncate">{agentName}</span>
                {modelName && <span className="text-xs text-white/25 truncate hidden sm:block">{modelName}</span>}
              </div>
            ) : (
              <div className="relative">
                <button
                  onClick={() => setShowProfileDropdown((v) => !v)}
                  className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/8 transition-colors group"
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    activeProfile?.lastConnectionStatus === "connected" ? "bg-emerald-500" :
                    activeProfile?.lastConnectionStatus === "error" ? "bg-red-500" :
                    "bg-white/20"
                  }`} />
                  <span className="text-sm font-medium text-white/80">{agentName}</span>
                  {modelName && <span className="text-xs text-white/25 hidden sm:block">{modelName}</span>}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/25 group-hover:text-white/50 flex-shrink-0 ml-0.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {showProfileDropdown && (
                  <div className="absolute top-full left-0 mt-1 z-50 min-w-[220px] bg-[#1a1a27] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                    <div className="px-3 pt-2.5 pb-1">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-white/30">Switch Agent</p>
                    </div>
                    {profiles.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setSelectedProfileId(p.id);
                          setShowProfileDropdown(false);
                          if (activeConvId) {
                            void window.forgeApi.updateConversation(activeConvId, { defaultAgentProfileId: p.id });
                          }
                        }}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/8 transition-colors ${
                          p.id === selectedProfileId ? "bg-white/5" : ""
                        }`}
                      >
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-0.5 ${
                          p.lastConnectionStatus === "connected" ? "bg-emerald-500" :
                          p.lastConnectionStatus === "error" ? "bg-red-500" :
                          "bg-white/15"
                        }`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-white/80 truncate">{p.name}</span>
                            {p.isDefault && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 font-medium flex-shrink-0">default</span>
                            )}
                          </div>
                          <span className="text-[11px] text-white/30 truncate block">{p.model}</span>
                        </div>
                        {p.id === selectedProfileId && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-violet-400 flex-shrink-0">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    ))}
                    <div className="border-t border-white/5 px-3 py-2">
                      <button
                        onClick={() => { setShowProfileDropdown(false); onOpenSettings(); }}
                        className="text-xs text-white/30 hover:text-white/60 transition-colors"
                      >
                        Manage agents…
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
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
                <div className="w-14 h-14 rounded-2xl bg-white/4 border border-white/8 flex items-center justify-center">
                  <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                    <rect x="6" y="6" width="20" height="20" rx="4" stroke="currentColor" strokeWidth="1.5" className="text-white/20" />
                    <path d="M11 12h10M11 16h7M11 20v-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/30" />
                  </svg>
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
            {streaming && <StreamingBubble text={streaming.text} streamId={streaming.streamId} />}

            {/* waiting_for_human banner — agent paused for browser intervention */}
            {!streaming && activeConvId && waitingForHumanMap[activeConvId] && (
              <div className="group flex flex-col gap-0 py-3 px-1">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-4 h-4 rounded flex items-center justify-center bg-amber-500/20 flex-shrink-0">
                    <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                      <path d="M6 1v5M6 9.5v.5" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                  <span className="text-[11px] text-amber-400/80 font-medium">Human intervention required</span>
                </div>
                <p className="text-xs text-white/50 mb-3 ml-6">The agent is waiting for you to complete an action in the browser (e.g. CAPTCHA, MFA, login). When done, click Return Control to resume.</p>
                <button
                  onClick={async () => {
                    if (activeConvId) {
                      const rid = waitingForHumanMap[activeConvId];
                      const requestId = typeof rid === 'string' ? rid : undefined;
                      await window.forgeApi.browser.returnBrowserControl(activeConvId, requestId);
                      setWaitingForHumanMap((prev) => {
                        const next = { ...prev };
                        delete next[activeConvId];
                        return next;
                      });
                    }
                  }}
                  className="ml-6 px-3 py-1.5 text-xs font-medium rounded border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50 transition-all w-fit"
                >
                  Return Control
                </button>
              </div>
            )}

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

        {/* ── Queue Panel ───────────────────────────────────────────── */}
        <div className="flex-shrink-0 px-4 pt-1">
          <div className="max-w-[800px] mx-auto">
            <QueuePanel
              convId={activeConvId ?? ""}
              queueState={activeQueueState}
              isStreaming={!!streaming}
              onResume={handleQueueResume}
              onRetry={handleQueueRetry}
              onSkip={handleQueueSkip}
              onRemove={handleQueueRemove}
              onEdit={handleQueueEdit}
            />
          </div>
        </div>

        {/* ── Task History Panel ────────────────────────────────────── */}
        {activeConvId && taskHistoryMap[activeConvId] && taskHistoryMap[activeConvId]!.length > 0 && (
          <div className="flex-shrink-0 px-4 pt-1">
            <div className="max-w-[800px] mx-auto space-y-1">
              {taskHistoryMap[activeConvId]!.map((snap) => (
                <TaskStatusPanel
                  key={snap.task.id}
                  snapshot={snap}
                  convId={activeConvId}
                  onPause={handleTaskPause}
                  onResume={handleTaskResume}
                  onCancel={handleTaskCancel}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Composer ─────────────────────────────────────────────── */}
        <div className="flex-shrink-0 px-4 pb-4 pt-1">
          <div className="max-w-[800px] mx-auto">
            {/* Edit queue item banner */}
            {editingQueueItemId && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-amber-900/20 border border-amber-400/20 rounded-xl text-xs">
                <PencilIcon size={11} />
                <span className="text-amber-300/80 flex-1">Editing queued message</span>
                <button
                  onClick={() => { setEditingQueueItemId(null); setInput(""); }}
                  className="text-amber-400/50 hover:text-amber-300 ml-1"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Reply banner */}
            {replyTarget && !editingQueueItemId && (
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
                {!editingQueueItemId && (
                  <>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={pendingAttachments.length >= 10}
                      title="Attach file"
                      className="flex-shrink-0 mb-1 w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/5 rounded-lg transition-colors disabled:opacity-20 disabled:pointer-events-none"
                    >
                      <PaperclipIcon size={16} />
                    </button>
                    <input ref={fileInputRef} type="file" accept="*/*" multiple className="hidden" onChange={handleFileChange} />
                  </>
                )}

                {/* Textarea */}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    editingQueueItemId
                      ? "Edit message…"
                      : streaming
                      ? "Queue next message…"
                      : "Message…"
                  }
                  rows={1}
                  autoFocus
                  className="flex-1 bg-transparent resize-none text-sm text-white placeholder-white/25 outline-none leading-relaxed min-h-[28px]"
                  style={{ maxHeight: "140px" }}
                />

                {/* Stop / Send / Update */}
                {streaming && !editingQueueItemId ? (
                  <div className="flex gap-1 flex-shrink-0 mb-1">
                    <button
                      onClick={handleCancel}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-900/40 text-red-400 hover:bg-red-900/60 hover:text-red-300 transition-colors text-xs"
                    >
                      <StopIcon size={11} />
                      Stop
                    </button>
                    <button
                      onClick={() => { void handleSend(); }}
                      disabled={!canSend}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600/60 text-white hover:bg-blue-500/70 transition-colors text-xs disabled:opacity-30 disabled:pointer-events-none"
                      title="Queue next message"
                    >
                      <SendIcon size={11} />
                      Queue
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { void handleSend(); }}
                    disabled={sendDisabled}
                    className="flex-shrink-0 mb-1 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors text-xs disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <SendIcon size={11} />
                    {sendLabel}
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

              {/* Context chips (V0.2 — project file context) */}
              {stagedContextChips && stagedContextChips.length > 0 && (
                <ContextChips
                  chips={stagedContextChips}
                  onRemove={onRemoveContextChip ?? (() => undefined)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}