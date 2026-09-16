/**
 * DiffReviewModal.tsx — review and apply AI-proposed file edits.
 *
 * Shows per-file diffs, allows selecting which to apply, runs preflight,
 * and applies with explicit confirmation.
 */
import React, { useState, useEffect, useCallback } from "react";
import type { EditProposal, FileEdit, PreflightResult } from "../../shared/types.js";
import { DiffView } from "./DiffView.js";

// ── Icons ───────────────────────────────────────────────────────────────────

function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FileIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 2h7l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 2L14 13H2L8 2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 7v3M8 11.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ── FileEditStatusBadge ──────────────────────────────────────────────────────

function FileEditStatusBadge({ status }: { status: FileEdit["status"] }) {
  const map: Record<FileEdit["status"], { label: string; className: string }> = {
    ready: { label: "Ready", className: "bg-green-900/50 text-green-300/80 border-green-700/30" },
    needs_context: { label: "Needs context", className: "bg-amber-900/50 text-amber-300/80 border-amber-700/30" },
    ambiguous_context: { label: "Ambiguous", className: "bg-amber-900/50 text-amber-300/80 border-amber-700/30" },
    stale: { label: "Stale", className: "bg-orange-900/50 text-orange-300/80 border-orange-700/30" },
    applied: { label: "Applied", className: "bg-blue-900/50 text-blue-300/80 border-blue-700/30" },
    rejected: { label: "Rejected", className: "bg-gray-800/60 text-gray-400/70 border-gray-700/30" },
    failed: { label: "Failed", className: "bg-red-900/50 text-red-300/80 border-red-700/30" },
    missing: { label: "Missing", className: "bg-red-900/50 text-red-300/80 border-red-700/30" },
  };
  const cfg = map[status];
  if (!cfg) return null;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function canSelectEdit(fe: FileEdit): boolean {
  // A file is selectable only when it is in ready state AND has a base snapshot.
  // These must both be true for a valid diff and safe apply.
  return fe.status === "ready" && !!(fe as unknown as Record<string, unknown>)["baseSnapshotId"];
}

// ── Main Component ───────────────────────────────────────────────────────────

export interface DiffReviewModalProps {
  proposal: EditProposal;
  onClose: () => void;
  onProposalUpdate?: (proposal: EditProposal) => void;
}

interface FileEditDiffState {
  loading: boolean;
  proposedContent: string | null;
  baseContent: string | null;
  error: string | null;
}

export function DiffReviewModal({ proposal, onClose, onProposalUpdate }: DiffReviewModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const fe of proposal.fileEdits as FileEdit[]) {
      if (canSelectEdit(fe)) s.add(fe.id);
    }
    return s;
  });
  const [activeFileId, setActiveFileId] = useState<string | null>(
    proposal.fileEdits[0]?.id ?? null
  );
  const [diffStates, setDiffStates] = useState<Record<string, FileEditDiffState>>({});
  const [preflightResults, setPreflightResults] = useState<PreflightResult[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  // Subscribe to proposal updates
  useEffect(() => {
    const unsub = window.forgeApi.fileEditing.onProposalUpdate((updated) => {
      if (updated.id === proposal.id && onProposalUpdate) {
        onProposalUpdate(updated);
      }
    });
    return unsub;
  }, [proposal.id, onProposalUpdate]);

  // Load diff content when active file changes
  useEffect(() => {
    if (!activeFileId) return;
    const fe = proposal.fileEdits.find((f) => f.id === activeFileId);
    if (!fe) return;
    if (diffStates[activeFileId]) return; // already loaded

    setDiffStates((prev) => ({
      ...prev,
      [activeFileId]: { loading: true, proposedContent: null, baseContent: null, error: null },
    }));

    void (async (feCapture: FileEdit, capturedFileId: string) => {
      // Load both proposed and base content from main process in a single IPC call.
      // The handler reads the base from the captured snapshot (ContextRef).
      const result = await window.forgeApi.fileEditing.readProposalTarget(proposal.id, feCapture.id);
      if (!result.ok) {
        setDiffStates((prev) => ({
          ...prev,
          [capturedFileId]: {
            loading: false,
            proposedContent: null,
            baseContent: null,
            error: result.error,
          },
        }));
        return;
      }

      setDiffStates((prev) => ({
        ...prev,
        [capturedFileId]: {
          loading: false,
          proposedContent: result.proposedContent,
          baseContent: result.baseContent,
          error: null,
        },
      }));
    })(fe, activeFileId);
  }, [activeFileId, proposal.id, proposal.fileEdits, diffStates]);

  const handleToggleSelect = useCallback((feId: string) => {
    const fe = (proposal.fileEdits as FileEdit[]).find((f: FileEdit) => f.id === feId);
    if (!fe || !canSelectEdit(fe)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(feId)) next.delete(feId);
      else next.add(feId);
      return next;
    });
    setPreflightResults(null);
    setApplyError(null);
  }, [proposal.fileEdits]);

  const handlePreflight = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const results = await window.forgeApi.fileEditing.preflightCheck(
      proposal.id,
      Array.from(selectedIds)
    );
    setPreflightResults(results);
  }, [proposal.id, selectedIds]);

  const handleApply = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setApplying(true);
    setApplyError(null);
    setPreflightResults(null);

    const result = await window.forgeApi.fileEditing.applySelected(
      proposal.id,
      Array.from(selectedIds)
    );

    setApplying(false);

    if (result.preflightFailures && result.preflightFailures.length > 0) {
      setPreflightResults(result.preflightFailures);
      setApplyError("Some files failed pre-apply checks. No changes were written.");
      return;
    }

    if (!result.ok) {
      setApplyError(result.error ?? "Apply failed");
      return;
    }

    setApplySuccess(true);
  }, [proposal.id, selectedIds]);

  const handleRejectAll = useCallback(async () => {
    setRejecting(true);
    await window.forgeApi.fileEditing.rejectProposal(proposal.id);
    setRejecting(false);
    onClose();
  }, [proposal.id, onClose]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const activeFe = (proposal.fileEdits as FileEdit[]).find((f: FileEdit) => f.id === activeFileId);
  const diffState = activeFileId ? diffStates[activeFileId] : null;
  const readyCount = (proposal.fileEdits as FileEdit[]).filter((f: FileEdit) => canSelectEdit(f)).length;
  const selectedReadyCount = Array.from(selectedIds).filter((id) =>
    (proposal.fileEdits as FileEdit[]).find((f: FileEdit) => f.id === id && canSelectEdit(f))
  ).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative flex flex-col bg-[#13141a] border border-white/10 rounded-xl shadow-2xl w-[88vw] max-w-5xl max-h-[88vh] min-h-[400px] overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-white/8">
          <div className="flex flex-col gap-0.5 min-w-0 pr-4">
            <h2 className="text-[13px] font-semibold text-white/90 leading-tight">
              Review Proposed Changes
            </h2>
            <p className="text-[11px] text-white/45 line-clamp-2">{proposal.summary}</p>
            {proposal.explanation && (
              <p className="text-[11px] text-white/35 mt-0.5 line-clamp-2">{proposal.explanation}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1.5 rounded text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors mt-0.5"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* File list sidebar */}
          <div className="w-52 shrink-0 flex flex-col border-r border-white/8 overflow-y-auto">
            <div className="px-3 pt-3 pb-1.5 text-[10px] text-white/30 uppercase tracking-wider">
              Files ({proposal.fileEdits.length})
            </div>
            {(proposal.fileEdits as FileEdit[]).map((fe: FileEdit) => {
              const isActive = fe.id === activeFileId;
              const isSelected = selectedIds.has(fe.id);
              const selectable = canSelectEdit(fe);
              return (
                <button
                  key={fe.id}
                  onClick={() => setActiveFileId(fe.id)}
                  className={`flex items-start gap-2 px-3 py-2 text-left transition-colors border-l-2 ${
                    isActive
                      ? "bg-white/6 border-blue-500/60"
                      : "border-transparent hover:bg-white/3"
                  }`}
                >
                  {/* Checkbox */}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleSelect(fe.id); }}
                    className={`shrink-0 mt-0.5 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                      selectable
                        ? isSelected
                          ? "bg-blue-500 border-blue-400"
                          : "border-white/25 hover:border-white/50"
                        : "border-white/10 opacity-40 cursor-not-allowed"
                    }`}
                    disabled={!selectable}
                    aria-label={`${isSelected ? "Deselect" : "Select"} ${fe.relativePath}`}
                  >
                    {isSelected && selectable && <CheckIcon size={10} />}
                  </button>

                  <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-1 text-white/30">
                      <FileIcon size={10} />
                    </div>
                    <span
                      className="text-[11px] text-white/70 truncate w-full"
                      style={{ fontFamily: "ui-monospace, monospace" }}
                      title={fe.relativePath}
                    >
                      {fe.relativePath.split("/").pop()}
                    </span>
                    <span className="text-[10px] text-white/30 truncate" title={fe.relativePath}>
                      {fe.relativePath.includes("/")
                        ? fe.relativePath.slice(0, fe.relativePath.lastIndexOf("/"))
                        : ""}
                    </span>
                    <FileEditStatusBadge status={fe.status} />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Diff panel */}
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* File edit detail header */}
            {activeFe && (
              <div className="flex items-center justify-between px-4 py-2 border-b border-white/8 bg-white/2">
                <span
                  className="text-[12px] text-white/60 truncate"
                  style={{ fontFamily: "ui-monospace, monospace" }}
                >
                  {activeFe.relativePath}
                </span>
                <FileEditStatusBadge status={activeFe.status} />
              </div>
            )}

            {/* Status messages */}
            {activeFe && activeFe.failureReason && (
              <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-900/20 border-b border-amber-700/20 text-[11px] text-amber-300/80">
                <WarningIcon size={12} />
                <span>{activeFe.failureReason}</span>
              </div>
            )}

            {/* Diff content */}
            <div className="flex-1 overflow-auto p-4">
              {!activeFileId && (
                <div className="flex items-center justify-center h-full text-white/25 text-sm">
                  Select a file to review
                </div>
              )}
              {activeFileId && diffState?.loading && (
                <div className="flex items-center justify-center h-full text-white/25 text-sm">
                  Loading diff...
                </div>
              )}
              {activeFileId && diffState?.error && (
                <div className="flex items-center justify-center h-full text-red-400/60 text-sm">
                  {diffState.error}
                </div>
              )}
              {activeFileId && diffState && !diffState.loading && !diffState.error &&
               diffState.proposedContent !== null && diffState.baseContent !== null && (
                <DiffView
                  baseContent={diffState.baseContent}
                  proposedContent={diffState.proposedContent}
                  filePath={activeFe?.relativePath}
                  maxLines={undefined}
                />
              )}
            </div>
          </div>
        </div>

        {/* Preflight results */}
        {preflightResults && preflightResults.some((r) => !r.ok) && (
          <div className="px-5 py-2.5 bg-red-900/20 border-t border-red-700/20">
            <p className="text-[11px] text-red-300/80 font-medium mb-1">Pre-apply checks failed:</p>
            {preflightResults.filter((r) => !r.ok).map((r) => (
              <div key={r.fileEditId} className="flex items-start gap-1.5 text-[11px] text-red-300/70">
                <WarningIcon size={11} />
                <span><span style={{ fontFamily: "ui-monospace, monospace" }}>{r.relativePath}</span>: {r.reason}</span>
              </div>
            ))}
          </div>
        )}

        {/* Apply error */}
        {applyError && (
          <div className="px-5 py-2 bg-red-900/20 border-t border-red-700/20 text-[11px] text-red-300/80">
            {applyError}
          </div>
        )}

        {/* Success */}
        {applySuccess && (
          <div className="px-5 py-2 bg-green-900/20 border-t border-green-700/20 text-[11px] text-green-300/80">
            Changes applied successfully.
          </div>
        )}

        {/* Footer actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-white/8 bg-white/2">
          <div className="flex items-center gap-2">
            <button
              onClick={handleRejectAll}
              disabled={rejecting || applying}
              className="text-[12px] px-3 py-1.5 rounded text-red-400/70 hover:text-red-300 hover:bg-red-900/20 border border-red-700/20 hover:border-red-600/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {rejecting ? "Rejecting..." : "Reject All"}
            </button>
            <button
              onClick={handlePreflight}
              disabled={selectedReadyCount === 0 || applying}
              className="text-[12px] px-3 py-1.5 rounded text-white/50 hover:text-white/80 hover:bg-white/5 border border-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Run Preflight
            </button>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] text-white/30">
              {selectedReadyCount} of {readyCount} file{readyCount !== 1 ? "s" : ""} selected
            </span>
            {applySuccess ? (
              <button
                onClick={onClose}
                className="text-[12px] px-4 py-1.5 rounded bg-white/10 text-white/70 hover:bg-white/15 transition-colors"
              >
                Close
              </button>
            ) : (
              <button
                onClick={handleApply}
                disabled={selectedReadyCount === 0 || applying || rejecting}
                className="text-[12px] px-4 py-1.5 rounded bg-blue-600/80 hover:bg-blue-500/80 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {applying ? "Applying..." : `Apply ${selectedReadyCount > 0 ? `${selectedReadyCount} ` : ""}File${selectedReadyCount !== 1 ? "s" : ""}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}