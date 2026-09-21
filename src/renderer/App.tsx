import React, { useEffect, useState } from "react";
import type { AppState, Project, PermissionApprovalRequest, PermissionApprovalAction } from "@shared/types.js";
import WelcomeScreen from "./screens/WelcomeScreen.js";
import ConnectAgentScreen from "./screens/ConnectAgentScreen.js";
import ChatScreen from "./screens/ChatScreen.js";
import ProjectsScreen from "./screens/ProjectsScreen.js";
import ProjectWorkspace from "./screens/ProjectWorkspace.js";
import AgentProfilesModal from "./components/AgentProfilesModal.js";
import SettingsModal from "./components/SettingsModal.js";
import { DevPanel } from "./components/DevPanel.js";
import { PermissionApprovalModal } from "./components/PermissionApprovalModal.js";
// BrowserWorkspace removed — browser runs as a standalone native window

// ── Nav icons ──────────────────────────────────────────────────────────────

function ChatIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path
        d="M3 4a1 1 0 011-1h12a1 1 0 011 1v9a1 1 0 01-1 1H7l-4 3V4z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path
        d="M2 5a1 1 0 011-1h5l2 2h7a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V5z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
    </svg>
  );
}


function BrowserIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 7h16" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5" cy="5" r="0.8" fill="currentColor" />
      <circle cx="8" cy="5" r="0.8" fill="currentColor" />
    </svg>
  );
}

function SettingsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
      />
    </svg>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────

type Screen = "loading" | "welcome" | "connect" | "app";
type AppView = "chat" | "projects";

// ── MainShell ──────────────────────────────────────────────────────────────

interface MainShellProps {
  onOpenSettings: () => void;
}

function MainShell({ onOpenSettings }: MainShellProps) {
  const [view, setView] = useState<AppView>("chat");
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  // Listen for agent-requested browser navigation → open standalone browser window
  useEffect(() => {
    const unsub = window.forgeApi.browser.onRequestShowBrowser((_payload) => {
      void window.forgeApi.browser.openBrowserWindow();
    });
    return () => unsub();
  }, []);

  const handleOpenProject = (project: Project) => {
    setActiveProject(project);
    // Touch lastOpenedAt via update (fire-and-forget)
    void window.forgeApi.updateProject(project.id, { lastOpenedAt: Date.now() });
  };

  const handleBackToProjects = () => {
    setActiveProject(null);
    setView("projects");
  };

  return (
    <div className="flex h-full bg-[#0d0d0f]">
        {/* Activity rail — only visible when NOT inside a project workspace */}
        {!activeProject && (
          <div className="drag-region flex-shrink-0 w-14 flex flex-col items-center gap-1 border-r border-white/5 bg-[#09090d]">
            {/* Space for macOS traffic lights */}
            <div className="no-drag flex-shrink-0" style={{ height: 50 }} />
            {/* Global Chat */}
            <NavButton
              active={view === "chat"}
              label="Global Chat"
              onClick={() => setView("chat")}
            >
              <ChatIcon size={18} />
            </NavButton>

            {/* Projects */}
            <NavButton
              active={view === "projects"}
              label="Projects"
              onClick={() => setView("projects")}
            >
              <FolderIcon size={18} />
            </NavButton>


            {/* Browser — opens as standalone native window */}
            <NavButton
              active={false}
              label="Browser"
              onClick={() => void window.forgeApi.browser.openBrowserWindow()}
            >
              <BrowserIcon size={18} />
            </NavButton>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Settings */}
            <NavButton
              active={false}
              label="Settings"
              onClick={onOpenSettings}
            >
              <SettingsIcon size={16} />
            </NavButton>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {activeProject ? (
            <ProjectWorkspace
              key={activeProject.id}
              project={activeProject}
              onBack={handleBackToProjects}
              onOpenSettings={onOpenSettings}
            />
          ) : view === "chat" ? (
            <ChatScreen
              projectId={null}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <ProjectsScreen
              onOpenProject={handleOpenProject}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
    </div>
  );
}

interface NavButtonProps {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

function NavButton({ active, label, onClick, children }: NavButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`
        no-drag w-10 h-10 rounded-xl flex items-center justify-center transition-all
        ${active
          ? "bg-[#6366f1]/15 text-[#6366f1]"
          : "text-white/30 hover:text-white/60 hover:bg-white/5"
        }
      `}
    >
      {children}
    </button>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

export default function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("loading");
  const [appState, setAppState] = useState<AppState | null>(null);
  const [showProfilesModal, setShowProfilesModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsConfig, setSettingsConfig] = useState<import("@shared/types.js").AgentConfig | null>(null);
  const [showDevPanel, setShowDevPanel] = useState(false);
  // Permission approval queue — FIFO so concurrent requests are never dropped
  const [approvalQueue, setApprovalQueue] = useState<PermissionApprovalRequest[]>([]);
  const pendingApproval = approvalQueue[0] ?? null;

  // Permission approval IPC — subscribe for the lifetime of the App
  useEffect(() => {
    const unsubRequest = window.forgeApi.permissions.onApprovalRequest((req) => {
      setApprovalQueue((prev) => {
        // Don't enqueue a duplicate (same approvalId)
        if (prev.some((r) => r.approvalId === req.approvalId)) return prev;
        return [...prev, req];
      });
    });
    const unsubCancelled = window.forgeApi.permissions.onApprovalCancelled((approvalId) => {
      setApprovalQueue((prev) => prev.filter((r) => r.approvalId !== approvalId));
    });
    return () => { unsubRequest(); unsubCancelled(); };
  }, []);

  const handleApprovalResponse = (action: PermissionApprovalAction): void => {
    if (!pendingApproval) return;
    void window.forgeApi.permissions.approvalRespond({ approvalId: pendingApproval.approvalId, action });
    // Dequeue the current approval — the next one (if any) will show automatically
    setApprovalQueue((prev) => prev.filter((r) => r.approvalId !== pendingApproval.approvalId));
  };

  // V17: Cmd+Shift+D toggles the Dev Panel (development aid)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setShowDevPanel((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    void (async () => {
      const state = await window.forgeApi.getAppState();
      setAppState(state);

      if (state.onboardingComplete && state.agentConfigId) {
        const cfg = await window.forgeApi.getConfig(state.agentConfigId);
        const hasKey = await window.forgeApi.hasSecret(state.agentConfigId);
        if (cfg && hasKey) { setScreen("app"); return; }
        setScreen("connect"); return;
      }

      if (!state.onboardingComplete) { setScreen("welcome"); return; }
      setScreen("connect");
    })().catch(() => {
      // Startup failed — fall back to connect screen so user isn't stuck on loading
      setScreen("connect");
    });
  }, []);

  if (screen === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-[#0d0d0f]">
        <div className="h-1 w-24 overflow-hidden rounded-full bg-[#1a1a1e]">
          <div className="h-full animate-pulse rounded-full bg-[#6366f1]" />
        </div>
      </div>
    );
  }

  if (screen === "welcome") {
    return <WelcomeScreen onContinue={() => setScreen("connect")} />;
  }

  if (screen === "connect") {
    return (
      <ConnectAgentScreen
        initialConfigId={appState?.agentConfigId ?? null}
        onComplete={(newState) => { setAppState(newState); setScreen("app"); }}
      />
    );
  }

  return (
    <>
      <MainShell onOpenSettings={() => {
        if (appState?.agentConfigId) {
          void window.forgeApi.getConfig(appState.agentConfigId).then((cfg) => {
            if (cfg) { setSettingsConfig(cfg); setShowSettingsModal(true); }
            else { setShowProfilesModal(true); }
          });
        } else {
          setShowProfilesModal(true);
        }
      }} />
      {showProfilesModal && (
        <AgentProfilesModal onClose={() => setShowProfilesModal(false)} />
      )}
      {showSettingsModal && settingsConfig && (
        <SettingsModal
          config={settingsConfig}
          onClose={() => setShowSettingsModal(false)}
          onReconfigure={() => { setShowSettingsModal(false); setShowProfilesModal(true); }}
          onSave={async (updated) => {
            await window.forgeApi.saveConfig(updated);
            setSettingsConfig(updated);
          }}
        />
      )}
      {showDevPanel && (
        <DevPanel onClose={() => setShowDevPanel(false)} />
      )}
      {pendingApproval && (
        <PermissionApprovalModal
          request={pendingApproval}
          onRespond={handleApprovalResponse}
          queueLength={approvalQueue.length}
        />
      )}
    </>
  );
}