/**
 * PermissionApprovalModal — shown when the main process sends a permission ASK request.
 * The user can approve once, for session, for project, always, or deny.
 * Wired into App.tsx via window.forgeApi.onApprovalRequest.
 */
import React, { useEffect, useCallback } from "react";
import type { PermissionApprovalRequest, PermissionApprovalAction } from "../../shared/types.js";

// ── Icons ────────────────────────────────────────────────────────────────

function ShieldIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path
        d="M10 2L3 5v5c0 4 3.5 7 7 8 3.5-1 7-4 7-8V5L10 2z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
      <path d="M7 10l2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ── Capability category helpers ──────────────────────────────────────────

function capabilityCategory(capabilityId: string): string {
  if (capabilityId.startsWith("browser.")) return "Browser";
  if (capabilityId.startsWith("terminal.")) return "Terminal";
  if (capabilityId.startsWith("git.")) return "Git";
  if (capabilityId.startsWith("filesystem.")) return "Filesystem";
  return "System";
}

function categoryColor(category: string): string {
  switch (category) {
    case "Browser":    return "text-blue-400 bg-blue-400/10 border-blue-400/20";
    case "Terminal":   return "text-amber-400 bg-amber-400/10 border-amber-400/20";
    case "Git":        return "text-purple-400 bg-purple-400/10 border-purple-400/20";
    case "Filesystem": return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
    default:           return "text-white/50 bg-white/5 border-white/10";
  }
}

// ── Component ────────────────────────────────────────────────────────────

interface PermissionApprovalModalProps {
  request: PermissionApprovalRequest;
  onRespond: (action: PermissionApprovalAction) => void;
  /** Total number of pending approvals including this one */
  queueLength?: number;
}

export function PermissionApprovalModal({
  request,
  onRespond,
  queueLength = 1,
}: PermissionApprovalModalProps): React.ReactElement {
  const category = capabilityCategory(request.capabilityId);
  const colorCls = categoryColor(category);

  const handleDeny = useCallback(() => onRespond("deny"), [onRespond]);

  // Close on Escape = deny
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleDeny();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleDeny]);

  return (
    <div
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) handleDeny(); }}
    >
      <div className="w-full max-w-sm mx-4 rounded-2xl border border-[#262629] bg-[#0d0d0f] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#1a1a1e]">
          <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center text-amber-400">
            <ShieldIcon size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[#e8e8ec]">Permission Required</h2>
              {queueLength > 1 && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  {queueLength} pending
                </span>
              )}
            </div>
            <p className="text-[11px] text-[#7a7a85] mt-0.5">The agent is requesting access</p>
          </div>
          <button
            onClick={handleDeny}
            className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-md text-[#7a7a85] transition-colors hover:bg-[#1a1a1e] hover:text-[#e8e8ec]"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {/* Capability badge + name */}
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${colorCls}`}>
              {category}
            </span>
            <span className="text-sm font-medium text-[#e8e8ec]">{request.capabilityName}</span>
          </div>

          {/* Reason */}
          <div className="rounded-xl bg-[#141416] border border-[#1e1e24] px-3 py-2.5">
            <p className="text-xs text-[#9a9ab0] leading-relaxed">{request.reason}</p>
          </div>

          {/* Capability ID in monospace for transparency */}
          <p className="text-[10px] text-[#3a3a42] font-mono">{request.capabilityId}</p>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 space-y-2">
          {/* Primary actions */}
          <div className="flex gap-2">
            <button
              onClick={() => onRespond("allow_once")}
              className="flex-1 px-3 py-2 text-xs font-medium rounded-xl bg-[#6366f1]/20 text-[#6366f1] hover:bg-[#6366f1]/30 border border-[#6366f1]/30 transition-colors"
            >
              Allow Once
            </button>
            <button
              onClick={() => onRespond("allow_session")}
              className="flex-1 px-3 py-2 text-xs font-medium rounded-xl bg-white/5 text-white/70 hover:bg-white/8 border border-white/8 transition-colors"
            >
              Allow for Session
            </button>
          </div>

          {/* Persistent actions */}
          <div className="flex gap-2">
            {request.projectId && (
              <button
                onClick={() => onRespond("allow_project")}
                className="flex-1 px-3 py-2 text-xs font-medium rounded-xl bg-white/3 text-white/50 hover:bg-white/6 border border-white/6 transition-colors"
              >
                Allow for Project
              </button>
            )}
            <button
              onClick={() => onRespond("always_allow")}
              className="flex-1 px-3 py-2 text-xs font-medium rounded-xl bg-white/3 text-white/50 hover:bg-white/6 border border-white/6 transition-colors"
            >
              Always Allow
            </button>
          </div>

          {/* Deny */}
          <button
            onClick={handleDeny}
            className="w-full px-3 py-2 text-xs font-medium rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
