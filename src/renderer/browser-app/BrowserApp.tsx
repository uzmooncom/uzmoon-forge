/**
 * BrowserApp — renderer for the standalone Forge Browser native window.
 *
 * This is a full port of BrowserWorkspace (previously embedded inside the
 * main Forge window) adapted for the standalone window context:
 * - No "back to Forge" button (it's a separate OS window)
 * - Titlebar drag region with macOS traffic light space
 * - hiddenInset titlebar style (space reserved by main process BrowserWindow)
 * - Keyboard shortcuts: Cmd+T, Cmd+W, Cmd+R, Cmd+L, Cmd+Shift+N
 * - VIEW POSITIONING: ResizeObserver → RESIZE_VIEW IPC at 60fps cap
 *
 * WebContentsView is rendered by Electron in a native layer; this React chrome
 * sits on top. The transparent overlay tracks the correct area and reports
 * bounds via IPC so the native view is positioned correctly in this window.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserProfile,
  BrowserSession,
  BrowserTab,
  BrowserRuntimeState,
  BrowserAgentControl,
  BrowserPendingApproval,
} from "@shared/types.js";
import { BookmarksPanel } from "./BookmarksPanel.js";
import { HistoryPanel } from "./HistoryPanel.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ForwardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReloadIcon({ loading }: { loading?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      style={loading ? { animation: "spin 0.8s linear infinite" } : undefined}
    >
      <path
        d="M13.5 8A5.5 5.5 0 112.5 5.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M2.5 2v3.5H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlobeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 1.5C5.5 4 5.5 10 7 12.5M7 1.5C8.5 4 8.5 10 7 12.5M1.5 7h11" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="2" y="5.5" width="8" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.5V4a2 2 0 014 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="4.5" r="2.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 11.5c0-2.5 2.2-4 5-4s5 1.5 5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="4.5" r="2.5" stroke="#10b981" strokeWidth="1.2" />
      <path d="M2 11.5c0-2.5 2.2-4 5-4s5 1.5 5 4" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ── TabBar ─────────────────────────────────────────────────────────────────

interface TabBarProps {
  tabs: BrowserTab[];
  activeTabId: string | null;
  agentTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

function TabBar({ tabs, activeTabId, agentTabId, onSelectTab, onCloseTab, onNewTab }: TabBarProps) {
  return (
    <div className="flex items-center gap-0.5 h-9 px-2 overflow-x-auto" style={{ minWidth: 0 }}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isAgentControlled = tab.id === agentTabId;
        const title = tab.title || tab.url || "New Tab";
        const shortTitle = title.length > 28 ? title.slice(0, 28) + "…" : title;
        return (
          <div
            key={tab.id}
            className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg cursor-pointer flex-shrink-0 transition-all select-none ${
              isActive
                ? "bg-white/10 text-white"
                : "text-white/40 hover:text-white/70 hover:bg-white/5"
            }`}
            style={{ maxWidth: 200, minWidth: 80 }}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.loadState === "loading" && (
              <div className="w-3 h-3 border border-current border-t-transparent rounded-full flex-shrink-0"
                style={{ animation: "spin 0.8s linear infinite" }} />
            )}
            {isAgentControlled && tab.loadState !== "loading" && (
              <div className="w-2 h-2 rounded-full bg-[#6366f1] flex-shrink-0" title="Agent is controlling this tab" />
            )}
            <span className="text-xs truncate">{shortTitle}</span>
            <button
              className="flex-shrink-0 hover:text-white/90 p-0.5 rounded"
              style={{ opacity: isActive ? 0.5 : 0 }}
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = isActive ? "0.5" : "0"; }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      <button
        className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/5 rounded-lg transition-all"
        onClick={onNewTab}
        title="New tab (Cmd+T)"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

// ── AddressBar ─────────────────────────────────────────────────────────────

interface AddressBarProps {
  url: string;
  loading: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
}

function AddressBar({ url, loading, inputRef, onNavigate, onBack, onForward, onReload, onStop }: AddressBarProps) {
  const [draft, setDraft] = useState(url);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(url);
  }, [url, focused]);

  const isSecure = url.startsWith("https://");
  const displayUrl = focused ? draft : url;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let nav = draft.trim();
    if (!nav) return;
    if (!nav.includes("://") && !nav.startsWith("//")) {
      if (nav.includes(".") && !nav.includes(" ")) {
        nav = "https://" + nav;
      } else {
        nav = "https://www.google.com/search?q=" + encodeURIComponent(nav);
      }
    }
    onNavigate(nav);
    (inputRef.current as HTMLInputElement | null)?.blur();
  };

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5">
      <button
        className="w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/5 rounded-lg transition-all"
        onClick={onBack}
        title="Back"
      >
        <BackIcon />
      </button>
      <button
        className="w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/5 rounded-lg transition-all"
        onClick={onForward}
        title="Forward"
      >
        <ForwardIcon />
      </button>

      <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-1.5 h-8 bg-white/5 border border-white/8 rounded-lg px-2.5 focus-within:border-[#6366f1]/40 focus-within:bg-white/8 transition-all">
        <span className="flex-shrink-0 text-white/30">
          {isSecure ? <LockIcon /> : <GlobeIcon />}
        </span>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={displayUrl}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            setFocused(true);
            setDraft(url);
            setTimeout(() => e.target.select(), 0);
          }}
          onBlur={() => setFocused(false)}
          className="flex-1 bg-transparent text-xs text-white/80 outline-none placeholder-white/25"
          placeholder="Search or enter address…"
          spellCheck={false}
        />
      </form>

      <button
        className="w-7 h-7 flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/5 rounded-lg transition-all"
        onClick={loading ? onStop : onReload}
        title={loading ? "Stop" : "Reload (Cmd+R)"}
      >
        <ReloadIcon loading={loading} />
      </button>
    </div>
  );
}

// ── AgentControlBar ────────────────────────────────────────────────────────

// ── Approval Dialog ────────────────────────────────────────────────────────

const RISK_META: Record<string, { label: string; color: string; icon: string }> = {
  READ:           { label: "Read page",       color: "text-blue-400",   icon: "👁" },
  NAVIGATION:     { label: "Navigate",        color: "text-green-400",  icon: "→" },
  INTERACTION:    { label: "Click / type",    color: "text-yellow-400", icon: "🖱" },
  FORM_SUBMISSION:{ label: "Submit form",     color: "text-orange-400", icon: "📤" },
  DOWNLOAD:       { label: "Download file",   color: "text-orange-400", icon: "⬇" },
  UPLOAD:         { label: "Upload file",     color: "text-orange-400", icon: "⬆" },
  AUTHENTICATION: { label: "Log in",          color: "text-red-400",    icon: "🔑" },
  ACCOUNT_CHANGE: { label: "Account change",  color: "text-red-400",    icon: "⚠" },
  DESTRUCTIVE:    { label: "Destructive action", color: "text-red-500", icon: "🗑" },
};

function ApprovalDialog({ approval, onApprove, onReject }: {
  approval: BrowserPendingApproval;
  onApprove: () => void;
  onReject: () => void;
}) {
  const meta = RISK_META[approval.risk] ?? { label: approval.risk, color: "text-white/50", icon: "?" };
  let hostname = approval.url;
  try { hostname = new URL(approval.url).hostname; } catch { /* noop */ }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }}>
      <div className="bg-[#18181b] border border-white/10 rounded-2xl shadow-2xl w-[420px] max-w-[90vw] overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-white/5">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-sm font-semibold ${meta.color}`}>{meta.icon} {meta.label}</span>
          </div>
          <p className="text-xs text-white/40">
            Agent wants to perform an action on <span className="text-white/70 font-medium">{hostname}</span>
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <div>
            <p className="text-xs text-white/40 uppercase tracking-wide mb-1">Action</p>
            <p className="text-sm text-white/80 leading-snug">{approval.action}</p>
          </div>
          {approval.agentPurpose && (
            <div>
              <p className="text-xs text-white/40 uppercase tracking-wide mb-1">Purpose</p>
              <p className="text-sm text-white/60 leading-snug italic">{approval.agentPurpose}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-white/40 uppercase tracking-wide mb-1">URL</p>
            <p className="text-xs text-white/50 font-mono break-all leading-snug">{approval.url}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 flex gap-3">
          <button
            className="flex-1 px-4 py-2 rounded-xl text-sm font-medium bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-all"
            onClick={onReject}
          >
            Deny
          </button>
          <button
            className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
              ["DESTRUCTIVE", "ACCOUNT_CHANGE", "AUTHENTICATION"].includes(approval.risk)
                ? "bg-red-500/20 hover:bg-red-500/30 text-red-400 hover:text-red-300"
                : "bg-[#6366f1]/20 hover:bg-[#6366f1]/30 text-[#6366f1] hover:text-[#818cf8]"
            }`}
            onClick={onApprove}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

interface AgentControlBarProps {
  control: BrowserAgentControl;
  activeTab: BrowserTab | null;
  onTakeControl: () => void;
  onReturnToAgent: () => void;
}

function AgentControlBar({ control, activeTab, onTakeControl }: AgentControlBarProps) {
  const isControllingActiveTab = control.tabId === activeTab?.id;
  const siteLabel = activeTab?.url
    ? (() => { try { return new URL(activeTab.url).hostname; } catch { return activeTab.url; } })()
    : "Browser";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-t border-white/5 bg-[#6366f1]/5">
      <div className="flex items-center gap-1.5 text-xs text-[#6366f1]">
        <AgentIcon />
        <span className="font-medium">Agent in control</span>
        {isControllingActiveTab && siteLabel && (
          <span className="text-white/30">· {siteLabel}</span>
        )}
      </div>
      <div className="flex-1" />
      <button
        className="text-xs text-white/40 hover:text-white/70 px-2 py-1 hover:bg-white/5 rounded-lg transition-all"
        onClick={onTakeControl}
      >
        Take control
      </button>
    </div>
  );
}

interface UserControlBarProps {
  onReturnToAgent: () => void;
}

function UserControlBar({ onReturnToAgent }: UserControlBarProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-t border-white/5">
      <div className="flex items-center gap-1.5 text-xs text-emerald-400">
        <UserIcon />
        <span>You have control</span>
      </div>
      <div className="flex-1" />
      <button
        className="text-xs text-[#6366f1]/70 hover:text-[#6366f1] px-2 py-1 hover:bg-[#6366f1]/10 rounded-lg transition-all"
        onClick={onReturnToAgent}
      >
        Return to agent
      </button>
    </div>
  );
}

// ── ProfileSelector ────────────────────────────────────────────────────────

interface ProfileSelectorProps {
  profiles: BrowserProfile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, mode: "persistent" | "private") => void;
}

function ProfileSelector({ profiles, selectedId, onSelect, onCreate }: ProfileSelectorProps) {
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMode, setNewMode] = useState<"persistent" | "private">("persistent");

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    onCreate(newName.trim(), newMode);
    setNewName("");
    setShowNew(false);
  };

  return (
    <div className="p-4 h-full flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium text-white/70 mb-2">Browser Profiles</h2>
        <div className="flex flex-col gap-1">
          {profiles.map((p) => (
            <button
              key={p.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-all ${
                p.id === selectedId
                  ? "bg-[#6366f1]/15 text-white"
                  : "text-white/50 hover:text-white/80 hover:bg-white/5"
              }`}
              onClick={() => onSelect(p.id)}
            >
              <span className="flex-1">{p.name}</span>
              <span className="text-xs text-white/25">{p.persistenceMode === "private" ? "Private" : "Persistent"}</span>
            </button>
          ))}
          {profiles.length === 0 && (
            <p className="text-xs text-white/25 px-2">No profiles yet. Create one to start browsing.</p>
          )}
        </div>
      </div>

      {showNew ? (
        <form onSubmit={handleCreate} className="flex flex-col gap-2">
          <input
            type="text"
            placeholder="Profile name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:border-[#6366f1]/40"
          />
          <select
            value={newMode}
            onChange={(e) => setNewMode(e.target.value as "persistent" | "private")}
            className="bg-[#09090d] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/70 outline-none"
          >
            <option value="persistent">Persistent (saves cookies/session)</option>
            <option value="private">Private (in-memory only)</option>
          </select>
          <div className="flex gap-2">
            <button type="submit" className="flex-1 bg-[#6366f1] text-white text-xs px-3 py-1.5 rounded-lg hover:bg-[#5254cc] transition-all">
              Create
            </button>
            <button type="button" className="text-white/40 text-xs px-3 py-1.5 rounded-lg hover:bg-white/5 transition-all"
              onClick={() => setShowNew(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 px-2 py-1.5 hover:bg-white/5 rounded-lg transition-all"
          onClick={() => setShowNew(true)}
        >
          <PlusIcon />
          <span>New profile</span>
        </button>
      )}
    </div>
  );
}

// ── SessionPanel ───────────────────────────────────────────────────────────

interface SessionPanelProps {
  sessions: BrowserSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onCloseSession: (id: string) => void;
}

function SessionPanel({ sessions, activeSessionId, onSelectSession, onCreateSession, onCloseSession }: SessionPanelProps) {
  return (
    <div className="border-b border-white/5 px-3 py-2">
      <div className="flex items-center gap-1 flex-wrap">
        {sessions.map((s) => (
          <div key={s.id} className="flex items-center gap-0.5">
            <button
              className={`text-xs px-2.5 py-1 rounded-lg transition-all ${
                s.id === activeSessionId
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white/70 hover:bg-white/5"
              }`}
              onClick={() => onSelectSession(s.id)}
            >
              {s.name ?? "Session"}
            </button>
            <button
              className="text-white/20 hover:text-white/50 p-0.5 rounded"
              onClick={() => onCloseSession(s.id)}
              title="Close session"
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <button
          className="text-xs text-white/25 hover:text-white/60 px-1.5 py-1 hover:bg-white/5 rounded-lg transition-all flex items-center gap-1"
          onClick={onCreateSession}
        >
          <PlusIcon />
          <span>New session</span>
        </button>
      </div>
    </div>
  );
}

// ── BrowserViewOverlay ─────────────────────────────────────────────────────
// The actual browser content is rendered by Electron's WebContentsView in
// a native layer below the renderer. We render a transparent overlay that
// tracks the correct bounds via ResizeObserver and sends resize IPC calls.

interface BrowserViewOverlayProps {
  sessionId: string | null;
  activeTabId: string | null;
}

function BrowserViewOverlay({ sessionId, activeTabId }: BrowserViewOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const updateBounds = useCallback(() => {
    const el = ref.current;
    if (!el || !activeTabId) return;
    const rect = el.getBoundingClientRect();
    void window.forgeApi.browser.resizeView({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, [activeTabId]);

  // Throttle to rAF
  const scheduleUpdate = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updateBounds();
    });
  }, [updateBounds]);

  useEffect(() => {
    if (!activeTabId) return;
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(el);
    scheduleUpdate();
    return () => {
      observer.disconnect();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [activeTabId, scheduleUpdate]);

  useEffect(() => {
    if (activeTabId) {
      void window.forgeApi.browser.showView(activeTabId);
    } else if (sessionId) {
      void window.forgeApi.browser.hideView();
    }
  }, [activeTabId, sessionId]);

  return (
    <div
      ref={ref}
      className="flex-1 min-h-0"
      style={{ background: "transparent", position: "relative" }}
    >
      {!activeTabId && (
        <div className="flex items-center justify-center h-full text-white/20 text-sm">
          No active tab
        </div>
      )}
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────────────────────

function EmptyState({ onCreateSession }: { onCreateSession: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-white/30">
      <GlobeIcon size={32} />
      <div className="text-center">
        <p className="text-sm font-medium text-white/50">No browser session open</p>
        <p className="text-xs mt-1">Create a session to start browsing</p>
      </div>
      <button
        className="text-xs bg-[#6366f1] text-white px-4 py-2 rounded-lg hover:bg-[#5254cc] transition-all"
        onClick={onCreateSession}
      >
        Create session
      </button>
    </div>
  );
}

// ── BrowserApp ─────────────────────────────────────────────────────────────

export default function BrowserApp() {
  const [runtimeState, setRuntimeState] = useState<BrowserRuntimeState | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [agentControl, setAgentControl] = useState<BrowserAgentControl | null>(null);
  const [pendingApproval, setPendingApproval] = useState<BrowserPendingApproval | null>(null);
  const [showProfilePanel, setShowProfilePanel] = useState(false);
  const [sidePanel, setSidePanel] = useState<"bookmarks" | "history" | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);

  // Subscribe to runtime state push events
  useEffect(() => {
    const unsub = window.forgeApi.browser.onRuntimeStatePush((state) => {
      setRuntimeState(state);
    });
    const unsubSession = window.forgeApi.browser.onSessionUpdated((_s) => {
      void window.forgeApi.browser.getRuntimeState().then(setRuntimeState);
    });
    const unsubTab = window.forgeApi.browser.onTabUpdated((_t) => {
      void window.forgeApi.browser.getRuntimeState().then(setRuntimeState);
    });
    const unsubControl = window.forgeApi.browser.onAgentControlChanged((control) => {
      setAgentControl(control);
    });

    const unsubApproval = window.forgeApi.browser.onApprovalRequested((approval) => {
      setPendingApproval(approval);
    });

    // Initial load
    void window.forgeApi.browser.getRuntimeState().then(setRuntimeState);

    return () => {
      unsub();
      unsubSession();
      unsubTab();
      unsubControl();
      unsubApproval();
    };
  }, []);

  // Keep active session/tab in sync with runtime state
  useEffect(() => {
    if (!runtimeState) return;
    if (runtimeState.activeSessionId && runtimeState.activeSessionId !== activeSessionId) {
      setActiveSessionId(runtimeState.activeSessionId);
    }
    const sess = runtimeState.sessions.find((s) => s.id === activeSessionId);
    if (sess?.activeTabId && sess.activeTabId !== activeTabId) {
      setActiveTabId(sess.activeTabId);
    }
  }, [runtimeState, activeSessionId, activeTabId]);

  // Listen for REQUEST_SHOW_BROWSER (agent wants to activate a session/tab)
  useEffect(() => {
    const unsub = window.forgeApi.browser.onRequestShowBrowser((payload) => {
      if (payload.sessionId) {
        setActiveSessionId(payload.sessionId);
        void window.forgeApi.browser.activateSession(payload.sessionId);
      }
      if (payload.tabId) {
        setActiveTabId(payload.tabId);
        void window.forgeApi.browser.activateTab(payload.tabId);
      }
    });
    return () => unsub();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "t") {
        e.preventDefault();
        void handleNewTab();
      } else if (meta && e.key === "w") {
        e.preventDefault();
        if (activeTabId) void window.forgeApi.browser.closeTab(activeTabId);
      } else if (meta && e.key === "r") {
        e.preventDefault();
        if (activeTabId) void window.forgeApi.browser.reload(activeTabId);
      } else if (meta && e.key === "l") {
        e.preventDefault();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const profiles = useMemo(() => runtimeState?.profiles ?? [], [runtimeState]);
  const sessions = useMemo(() => runtimeState?.sessions.filter((s) => s.lifecycle === "active") ?? [], [runtimeState]);
  const allTabs = useMemo(() => runtimeState?.tabs ?? [], [runtimeState]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const sessionTabs = allTabs.filter((t) => t.sessionId === activeSessionId);
  const activeTab = allTabs.find((t) => t.id === activeTabId) ?? null;
  const agentTabId = agentControl?.tabId ?? null;

  const handleCreateProfile = useCallback(async (name: string, mode: "persistent" | "private") => {
    const profile = await window.forgeApi.browser.createProfile({ name, persistenceMode: mode });
    setSelectedProfileId(profile.id);
    const session = await window.forgeApi.browser.createSession(profile.id, { name: "Session 1" });
    setActiveSessionId(session.id);
    const tab = await window.forgeApi.browser.newTab(session.id);
    setActiveTabId(tab.id);
    setShowProfilePanel(false);
  }, []);

  const handleCreateSession = useCallback(async () => {
    const profileId = selectedProfileId ?? profiles[0]?.id;
    if (!profileId) {
      setShowProfilePanel(true);
      return;
    }
    const session = await window.forgeApi.browser.createSession(profileId, {});
    setActiveSessionId(session.id);
    const tab = await window.forgeApi.browser.newTab(session.id);
    setActiveTabId(tab.id);
  }, [selectedProfileId, profiles]);

  const handleNewTab = useCallback(async () => {
    if (!activeSessionId) return;
    const tab = await window.forgeApi.browser.newTab(activeSessionId);
    setActiveTabId(tab.id);
    await window.forgeApi.browser.activateTab(tab.id);
  }, [activeSessionId]);

  const handleCloseTab = useCallback(async (tabId: string) => {
    await window.forgeApi.browser.closeTab(tabId);
  }, []);

  const handleSelectTab = useCallback(async (tabId: string) => {
    setActiveTabId(tabId);
    await window.forgeApi.browser.activateTab(tabId);
  }, []);

  const handleNavigate = useCallback(async (url: string) => {
    if (!activeTabId) return;
    await window.forgeApi.browser.navigate(activeTabId, url);
  }, [activeTabId]);

  const handleBack = useCallback(() => {
    if (activeTabId) void window.forgeApi.browser.back(activeTabId);
  }, [activeTabId]);

  const handleForward = useCallback(() => {
    if (activeTabId) void window.forgeApi.browser.forward(activeTabId);
  }, [activeTabId]);

  const handleReload = useCallback(() => {
    if (activeTabId) void window.forgeApi.browser.reload(activeTabId);
  }, [activeTabId]);

  const handleStop = useCallback(() => {
    if (activeTabId) void window.forgeApi.browser.stop(activeTabId);
  }, [activeTabId]);

  const handleSelectSession = useCallback(async (id: string) => {
    setActiveSessionId(id);
    await window.forgeApi.browser.activateSession(id);
    const sess = sessions.find((s) => s.id === id);
    if (sess?.activeTabId) setActiveTabId(sess.activeTabId);
  }, [sessions]);

  const handleCloseSession = useCallback(async (id: string) => {
    await window.forgeApi.browser.closeSession(id);
    if (id === activeSessionId) {
      const remaining = sessions.filter((s) => s.id !== id);
      setActiveSessionId(remaining[0]?.id ?? null);
      setActiveTabId(null);
    }
  }, [activeSessionId, sessions]);

  const handleTakeControl = useCallback(async () => {
    if (!activeSessionId) return;
    await window.forgeApi.browser.userTakeControl(activeSessionId);
    setAgentControl(null);
  }, [activeSessionId]);

  const handleReturnToAgent = useCallback(async () => {
    if (!activeSessionId) return;
    await window.forgeApi.browser.returnToAgent();
  }, [activeSessionId]);

  const hasSession = sessions.length > 0 && activeSession !== null;

  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return;
    setPendingApproval(null);
    await window.forgeApi.browser.approveAction(pendingApproval.id);
  }, [pendingApproval]);

  const handleReject = useCallback(async () => {
    if (!pendingApproval) return;
    setPendingApproval(null);
    await window.forgeApi.browser.rejectAction(pendingApproval.id);
  }, [pendingApproval]);

  return (
    <div className="flex flex-col h-full bg-[#0d0d0f]">
      {/* Titlebar drag region — space for macOS traffic lights (hiddenInset) */}
      <div className="drag-region flex-shrink-0" style={{ height: 36 }}>
        <div className="flex items-center h-full px-4">
          <span
            className="text-xs text-white/30 font-medium select-none"
            style={{ paddingLeft: 72 }}
          >
            Forge Browser
          </span>
          <div className="flex-1" />
          {/* Sidebar toggles */}
          <div className="flex items-center gap-1 no-drag">
            <button
              className={`p-1.5 rounded-lg transition-colors ${
                sidePanel === "bookmarks"
                  ? "bg-[#6366f1]/20 text-[#6366f1]"
                  : "text-white/25 hover:text-white/60 hover:bg-white/5"
              }`}
              onClick={() => setSidePanel((p) => p === "bookmarks" ? null : "bookmarks")}
              title="Bookmarks"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 2h8a1 1 0 011 1v9l-5-2.5L2 12V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className={`p-1.5 rounded-lg transition-colors ${
                sidePanel === "history"
                  ? "bg-[#6366f1]/20 text-[#6366f1]"
                  : "text-white/25 hover:text-white/60 hover:bg-white/5"
              }`}
              onClick={() => setSidePanel((p) => p === "history" ? null : "history")}
              title="History"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M7 4.5V7l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {showProfilePanel ? (
        <div className="flex-1 flex overflow-hidden">
          <div className="w-64 border-r border-white/5 overflow-y-auto">
            <ProfileSelector
              profiles={profiles}
              selectedId={selectedProfileId}
              onSelect={(id) => { setSelectedProfileId(id); setShowProfilePanel(false); }}
              onCreate={handleCreateProfile}
            />
          </div>
          <div className="flex-1 flex items-center justify-center text-white/20 text-sm">
            Select or create a profile to start browsing
          </div>
        </div>
      ) : !hasSession ? (
        <EmptyState onCreateSession={handleCreateSession} />
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Session strip */}
          {sessions.length > 0 && (
            <SessionPanel
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              onCreateSession={handleCreateSession}
              onCloseSession={handleCloseSession}
            />
          )}

          {/* Tab bar */}
          <div className="border-b border-white/5">
            <TabBar
              tabs={sessionTabs}
              activeTabId={activeTabId}
              agentTabId={agentTabId}
              onSelectTab={handleSelectTab}
              onCloseTab={handleCloseTab}
              onNewTab={handleNewTab}
            />
          </div>

          {/* Address bar */}
          <div className="border-b border-white/5">
            <AddressBar
              url={activeTab?.url ?? ""}
              loading={activeTab?.loadState === "loading"}
              inputRef={addressInputRef}
              onNavigate={handleNavigate}
              onBack={handleBack}
              onForward={handleForward}
              onReload={handleReload}
              onStop={handleStop}
            />
          </div>

          {/* Browser view area + sidebar */}
          <div className="flex-1 flex overflow-hidden">
            <BrowserViewOverlay
              sessionId={activeSessionId}
              activeTabId={activeTabId}
            />

            {/* Side panel (bookmarks / history) */}
            {sidePanel && (
              <div className="w-72 border-l border-white/5 flex flex-col overflow-hidden bg-[#0d0d0f]">
                {sidePanel === "bookmarks" ? (
                  <BookmarksPanel
                    profileId={activeSession?.profileId ?? null}
                    onNavigate={(url) => { void handleNavigate(url); setSidePanel(null); }}
                  />
                ) : (
                  <HistoryPanel
                    profileId={activeSession?.profileId ?? null}
                    onNavigate={(url) => { void handleNavigate(url); setSidePanel(null); }}
                  />
                )}
              </div>
            )}
          </div>

          {/* Agent / user control bar */}
          {activeSession && agentControl ? (
            <AgentControlBar
              control={agentControl}
              activeTab={activeTab}
              onTakeControl={handleTakeControl}
              onReturnToAgent={handleReturnToAgent}
            />
          ) : activeSession ? (
            <UserControlBar onReturnToAgent={handleReturnToAgent} />
          ) : null}
        </div>
      )}

      {/* Approval dialog overlay */}
      {pendingApproval && (
        <ApprovalDialog
          approval={pendingApproval}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </div>
  );
}