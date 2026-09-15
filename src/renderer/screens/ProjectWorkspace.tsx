import React, { useEffect, useState } from "react";
import type { Project, DirectoryStatus } from "../../shared/types.js";
import ChatScreen from "./ChatScreen.js";

// ── Icons ──────────────────────────────────────────────────────────────────

function ChevronLeftIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 3.5A1 1 0 012.5 2.5h3.793a1 1 0 01.707.293L7.707 3.5H13.5a1 1 0 011 1v7.5a1 1 0 01-1 1h-11a1 1 0 01-1-1V3.5z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
      />
    </svg>
  );
}

function WarningIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 2L14.5 13.5H1.5L8 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 7v3M8 11.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ── ProjectWorkspace ────────────────────────────────────────────────────────

interface ProjectWorkspaceProps {
  project: Project;
  onBack: () => void;
  onOpenSettings: () => void;
}

export default function ProjectWorkspace({ project, onBack, onOpenSettings }: ProjectWorkspaceProps) {
  const [dirStatus, setDirStatus] = useState<DirectoryStatus>("unknown");

  useEffect(() => {
    void window.forgeApi.validateProjectDir(project.id).then(setDirStatus);
  }, [project.id]);

  const shortPath = (() => {
    const parts = project.workingDirectory.replace(/\\/g, "/").split("/");
    return parts.slice(-3).join("/");
  })();

  return (
    <div className="flex flex-col h-full">
      {/* Project header bar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-[#0d0d0f]">
        <button
          onClick={onBack}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors text-[12px]"
          title="Back to Projects"
        >
          <ChevronLeftIcon size={13} />
          <span>Projects</span>
        </button>

        <div className="w-px h-3.5 bg-white/8 mx-0.5" />

        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className={dirStatus === "missing" ? "text-amber-400/60" : "text-white/30"}>
            <FolderIcon size={13} />
          </span>
          <span className="text-[12px] font-medium text-white/70 truncate">{project.name}</span>
          {dirStatus === "missing" && (
            <span className="flex items-center gap-1 text-[11px] text-amber-400/60 ml-1">
              <WarningIcon size={11} />
              <span>Folder unavailable</span>
            </span>
          )}
          {dirStatus === "ok" && (
            <span className="text-[11px] text-white/20 truncate hidden sm:inline" title={project.workingDirectory}>
              {shortPath}
            </span>
          )}
        </div>
      </div>

      {/* Chat — fully reused, scoped to this project */}
      <div className="flex-1 min-h-0">
        <ChatScreen
          projectId={project.id}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  );
}