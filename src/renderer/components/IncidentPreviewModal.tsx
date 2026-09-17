import React, { useEffect, useState } from "react";
import type { ForgeIncident } from "@shared/types.js";

interface Props {
  onClose: () => void;
}

type Tab = "list" | "detail";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20",
  high:     "text-[#f97316] bg-[#f97316]/10 border-[#f97316]/20",
  medium:   "text-[#eab308] bg-[#eab308]/10 border-[#eab308]/20",
  low:      "text-[#6366f1] bg-[#6366f1]/10 border-[#6366f1]/20",
};

function severityBadge(sev: string): string {
  return SEVERITY_COLOR[sev] ?? "text-[#7a7a85] bg-[#1a1a1e] border-[#262629]";
}

function relTime(ts: number): string {
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

export default function IncidentPreviewModal({ onClose }: Props): React.ReactElement {
  const [tab, setTab] = useState<Tab>("list");
  const [incidents, setIncidents] = useState<ForgeIncident[]>([]);
  const [selected, setSelected] = useState<ForgeIncident | null>(null);
  const [loading, setLoading] = useState(true);
  const [sharePayload, setSharePayload] = useState<Record<string, unknown> | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(false);

  // Load incidents + sharing setting on mount
  useEffect(() => {
    void Promise.all([
      window.forgeApi.reliability.listIncidents(),
      window.forgeApi.settings.getSettings(),
    ]).then(([incs, settings]) => {
      setIncidents(incs);
      setSharingEnabled(settings.incidentSharingEnabled);
      setLoading(false);
    });
  }, []);

  // Subscribe to new incidents pushed from main process
  useEffect(() => {
    return window.forgeApi.reliability.onIncidentRecorded((inc) => {
      setIncidents((prev) => {
        const idx = prev.findIndex((i) => i.id === inc.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = inc;
          return next;
        }
        return [inc, ...prev];
      });
    });
  }, []);

  const handleClose = (): void => {
    onClose();
  };

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) handleClose();
  };

  const handleSelect = (inc: ForgeIncident): void => {
    setSelected(inc);
    setSharePayload(null);
    setCopied(false);
    setTab("detail");
  };

  const handleBack = (): void => {
    setTab("list");
    setSelected(null);
    setSharePayload(null);
    setCopied(false);
  };

  const handleGetSharePayload = async (): Promise<void> => {
    if (!selected || !sharingEnabled) return;
    setShareLoading(true);
    const payload = await window.forgeApi.reliability.getSharePayload(selected.id);
    setSharePayload(payload);
    setShareLoading(false);
  };

  const handleCopy = async (): Promise<void> => {
    if (!sharePayload) return;
    await navigator.clipboard.writeText(JSON.stringify(sharePayload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClear = async (): Promise<void> => {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    await window.forgeApi.reliability.clearIncidents();
    setIncidents([]);
    setClearConfirm(false);
    setSelected(null);
    setTab("list");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="flex w-full max-w-2xl flex-col rounded-2xl border border-[#262629] bg-[#0d0d0f] shadow-2xl"
           style={{ maxHeight: "80vh" }}>

        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[#1a1a1e] px-5 py-4">
          <div className="flex items-center gap-3">
            {tab === "detail" && (
              <button
                onClick={handleBack}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[#7a7a85] transition-colors hover:bg-[#1a1a1e] hover:text-[#e8e8ec]"
              >
                <BackIcon />
              </button>
            )}
            <h2 className="text-sm font-semibold text-[#e8e8ec]">
              {tab === "list" ? "Reliability Incidents" : (selected ? `${selected.invariantId}` : "Incident Detail")}
            </h2>
            {tab === "list" && incidents.length > 0 && (
              <span className="rounded-full border border-[#262629] bg-[#141416] px-2 py-0.5 text-[10px] text-[#7a7a85]">
                {incidents.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {tab === "list" && incidents.length > 0 && (
              <button
                onClick={() => void handleClear()}
                className={`text-xs transition-colors ${
                  clearConfirm
                    ? "text-[#ef4444] hover:text-[#f87171]"
                    : "text-[#7a7a85] hover:text-[#e8e8ec]"
                }`}
              >
                {clearConfirm ? "Confirm clear" : "Clear all"}
              </button>
            )}
            <button
              onClick={handleClose}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[#7a7a85] transition-colors hover:bg-[#1a1a1e] hover:text-[#e8e8ec]"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-40 items-center justify-center">
              <span className="text-xs text-[#7a7a85]">Loading incidents…</span>
            </div>
          ) : tab === "list" ? (
            <IncidentList incidents={incidents} onSelect={handleSelect} />
          ) : selected ? (
            <IncidentDetail
              incident={selected}
              sharingEnabled={sharingEnabled}
              sharePayload={sharePayload}
              shareLoading={shareLoading}
              copied={copied}
              onGetPayload={() => void handleGetSharePayload()}
              onCopy={() => void handleCopy()}
            />
          ) : null}
        </div>

        {/* Footer */}
        {!sharingEnabled && tab === "detail" && (
          <div className="flex-shrink-0 border-t border-[#1a1a1e] bg-[#0d0d0f] px-5 py-3">
            <p className="text-[10px] text-[#3a3a42]">
              Incident sharing is off. Enable it in{" "}
              <span className="text-[#6366f1]">Settings → Privacy</span> to generate
              a sanitized share payload.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Incident List ─────────────────────────────────────────────────────────────

function IncidentList({
  incidents,
  onSelect,
}: {
  incidents: ForgeIncident[];
  onSelect: (inc: ForgeIncident) => void;
}): React.ReactElement {
  if (incidents.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2">
        <ShieldIcon />
        <p className="text-xs text-[#7a7a85]">No incidents recorded</p>
        <p className="text-[10px] text-[#3a3a42]">The reliability subsystem is healthy.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-[#1a1a1e]">
      {incidents.map((inc) => (
        <button
          key={inc.id}
          onClick={() => onSelect(inc)}
          className="flex w-full flex-col gap-1.5 px-5 py-3.5 text-left transition-colors hover:bg-[#141416]"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="flex-1 truncate text-xs font-medium text-[#e8e8ec]">
              {inc.invariantId.replace(/_/g, " ")}
            </span>
            <span
              className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${severityBadge(inc.severity)}`}
            >
              {inc.severity}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-[#7a7a85]">{inc.invariantId}</span>
            <span className="text-[10px] text-[#3a3a42]">
              {inc.occurrenceCount}× · {relTime(inc.lastSeen)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Incident Detail ───────────────────────────────────────────────────────────

function IncidentDetail({
  incident: inc,
  sharingEnabled,
  sharePayload,
  shareLoading,
  copied,
  onGetPayload,
  onCopy,
}: {
  incident: ForgeIncident;
  sharingEnabled: boolean;
  sharePayload: Record<string, unknown> | null;
  shareLoading: boolean;
  copied: boolean;
  onGetPayload: () => void;
  onCopy: () => void;
}): React.ReactElement {
  return (
    <div className="space-y-4 p-5">
      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${severityBadge(inc.severity)}`}
        >
          {inc.severity}
        </span>
        <span className="rounded-full border border-[#262629] bg-[#141416] px-2 py-0.5 font-mono text-[10px] text-[#7a7a85]">
          {inc.category}
        </span>
        <span className="text-[10px] text-[#3a3a42]">
          First: {new Date(inc.firstSeen).toLocaleString()}
        </span>
        <span className="text-[10px] text-[#3a3a42]">
          Last: {relTime(inc.lastSeen)}
        </span>
        <span className="text-[10px] text-[#3a3a42]">×{inc.occurrenceCount}</span>
      </div>

      {/* Description */}
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[#7a7a85]">
          Description
        </p>
        <p className="text-xs leading-relaxed text-[#c8c8d0]">{inc.category} — {inc.failureCode}</p>
      </div>

      {/* Invariant + fingerprint */}
      <div className="space-y-2 rounded-lg border border-[#1a1a1e] bg-[#141416] p-3">
        <FieldRow label="Invariant" value={inc.invariantId} mono />
        <FieldRow label="Fingerprint" value={inc.fingerprint} mono />
        <FieldRow label="Failure Code" value={inc.failureCode ?? "—"} mono />
        <FieldRow label="Version" value={inc.forgeVersion} />
      </div>

      {/* Observed state */}
      {inc.observedState && Object.keys(inc.observedState).length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[#7a7a85]">
            Observed State (sanitized)
          </p>
          <pre className="max-h-32 overflow-auto rounded-lg border border-[#1a1a1e] bg-[#141416] p-3 font-mono text-[10px] text-[#c8c8d0]">
            {JSON.stringify(inc.observedState, null, 2)}
          </pre>
        </div>
      )}

      {/* Sharing */}
      <div className="space-y-2 pt-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[#7a7a85]">
          Share Incident
        </p>

        {!sharingEnabled ? (
          <p className="text-[10px] text-[#3a3a42]">
            Enable sharing in Settings → Privacy to generate a sanitized payload.
          </p>
        ) : !sharePayload ? (
          <button
            onClick={onGetPayload}
            disabled={shareLoading}
            className="flex h-8 items-center gap-2 rounded-lg border border-[#262629] bg-[#141416] px-3 text-xs font-medium text-[#e8e8ec] transition-colors hover:border-[#3a3a42] hover:bg-[#1a1a1e] disabled:opacity-40"
          >
            {shareLoading ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border border-[#7a7a85] border-t-transparent" />
                Building payload…
              </>
            ) : (
              <>
                <ShareIcon />
                Get share payload
              </>
            )}
          </button>
        ) : (
          <div className="space-y-2">
            <pre className="max-h-48 overflow-auto rounded-lg border border-[#262629] bg-[#141416] p-3 font-mono text-[10px] text-[#c8c8d0]">
              {JSON.stringify(sharePayload, null, 2)}
            </pre>
            <button
              onClick={onCopy}
              className="flex h-8 items-center gap-2 rounded-lg border border-[#262629] bg-[#141416] px-3 text-xs font-medium text-[#e8e8ec] transition-colors hover:border-[#3a3a42] hover:bg-[#1a1a1e]"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied!" : "Copy to clipboard"}
            </button>
            <p className="text-[10px] text-[#3a3a42]">
              Secrets and absolute paths have been redacted. Review before sharing.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FieldRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex-shrink-0 text-[10px] text-[#7a7a85]">{label}</span>
      <span
        className={`truncate text-right text-[10px] text-[#c8c8d0] ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

// ── Icons (SVG, no emoji) ─────────────────────────────────────────────────────

function BackIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ShieldIcon(): React.ReactElement {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3a3a42"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function ShareIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

function CopyIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}