/**
 * CommandCard.tsx — Displays a single CommandExecution with status,
 * output metadata, and approve/reject/cancel actions.
 */
import React, { useState } from "react";
import type { CommandExecution, CommandRiskClass } from "../../shared/types.js";

interface Props {
  cmd: CommandExecution;
  onApprove?: (commandId: string, mode: "once" | "trust") => void;
  onReject?: (commandId: string) => void;
  onCancel?: (commandId: string) => void;
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="animate-spin">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 7" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 150ms" }}>
      <path d="M3.5 2.5l3 2.5-3 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusDot({ state }: { state: CommandExecution["state"] }) {
  if (state === "running") return <SpinnerIcon />;
  const colorMap: Partial<Record<CommandExecution["state"], string>> = {
    succeeded: "#34d399",
    failed: "#f87171",
    timed_out: "#fb923c",
    cancelled: "rgba(255,255,255,0.2)",
    blocked: "#ef4444",
    queued: "#60a5fa",
    proposed: "rgba(255,255,255,0.3)",
    awaiting_approval: "#fbbf24",
  };
  const fill = colorMap[state] ?? "rgba(255,255,255,0.2)";
  return (
    <svg width="7" height="7" viewBox="0 0 7 7">
      <circle cx="3.5" cy="3.5" r="3.5" fill={fill} />
    </svg>
  );
}

function statusLabel(state: CommandExecution["state"]): string {
  const map: Record<CommandExecution["state"], string> = {
    proposed: "Proposed",
    awaiting_approval: "Approval needed",
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    timed_out: "Timed out",
    blocked: "Blocked",
  };
  return map[state] ?? state;
}

/** Map CommandRiskClass to a colour-coded badge style */
function riskStyle(rc: CommandRiskClass): { bg: string; color: string } {
  switch (rc) {
    case "destructive":
    case "shell_interpreter":
    case "source_write_bypass":
    case "remote_execution":
      return { bg: "rgba(239,68,68,0.12)", color: "#f87171" };
    case "mutation":
    case "package_install":
    case "network":
    case "git":
      return { bg: "rgba(251,191,36,0.12)", color: "#fbbf24" };
    case "verification":
    case "read_only":
    case "project_script":
      return { bg: "rgba(52,211,153,0.12)", color: "#34d399" };
    default:
      return { bg: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.3)" };
  }
}

/** Human-readable label for risk class */
function riskLabel(rc: CommandRiskClass): string {
  return rc.replace(/_/g, " ");
}

export function CommandCard({ cmd, onApprove, onReject, onCancel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [trustMode, setTrustMode] = useState<"once" | "trust">("once");

  const isTerminal = ["succeeded", "failed", "timed_out", "cancelled", "blocked"].includes(cmd.state);
  const isRunning = cmd.state === "running";
  const needsApproval = cmd.state === "awaiting_approval";

  const durationStr =
    cmd.durationMs !== undefined
      ? cmd.durationMs < 1000
        ? `${cmd.durationMs}ms`
        : `${(cmd.durationMs / 1000).toFixed(1)}s`
      : null;

  const riskClass = cmd.policyDecision.riskClass;
  const { bg: riskBg, color: riskColor } = riskStyle(riskClass);

  const borderColor = needsApproval
    ? "rgba(251,191,36,0.3)"
    : isRunning
    ? "rgba(96,165,250,0.2)"
    : isTerminal && cmd.state === "failed"
    ? "rgba(248,113,113,0.15)"
    : "rgba(255,255,255,0.08)";

  const bgColor = needsApproval
    ? "rgba(251,191,36,0.04)"
    : isRunning
    ? "rgba(96,165,250,0.04)"
    : "rgba(255,255,255,0.02)";

  return (
    <div
      style={{
        borderRadius: 8,
        border: `1px solid ${borderColor}`,
        background: bgColor,
        fontSize: 12,
        transition: "border-color 200ms",
      }}
    >
      {/* Header row */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", userSelect: "none" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <StatusDot state={cmd.state} />

        <span
          style={{ fontFamily: "monospace", color: "rgba(255,255,255,0.7)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}
          title={cmd.displayCommand}
        >
          {cmd.displayCommand}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {durationStr && (
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>{durationStr}</span>
          )}
          {cmd.exitCode !== undefined && cmd.exitCode !== null && (
            <span
              style={{
                fontSize: 10,
                fontFamily: "monospace",
                padding: "1px 5px",
                borderRadius: 4,
                background: cmd.exitCode === 0 ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)",
                color: cmd.exitCode === 0 ? "#34d399" : "#f87171",
              }}
            >
              exit {cmd.exitCode}
            </span>
          )}
          <span style={{ fontSize: 10, color: needsApproval ? "#fbbf24" : "rgba(255,255,255,0.3)" }}>
            {statusLabel(cmd.state)}
          </span>
          <ChevronIcon open={expanded} />
        </div>
      </div>

      {/* Approval actions */}
      {needsApproval && (
        <div style={{ padding: "0 12px 10px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "rgba(251,191,36,0.7)", marginRight: 4 }}>Allow?</span>

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "rgba(255,255,255,0.5)", cursor: "pointer" }}>
            <input type="radio" name={"trust-" + cmd.id} value="once" checked={trustMode === "once"} onChange={() => setTrustMode("once")} />
            Once
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "rgba(255,255,255,0.5)", cursor: "pointer" }}>
            <input type="radio" name={"trust-" + cmd.id} value="trust" checked={trustMode === "trust"} onChange={() => setTrustMode("trust")} />
            Always trust
          </label>

          <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <button
              onClick={(e) => { e.stopPropagation(); onReject?.(cmd.id); }}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", background: "transparent", color: "rgba(248,113,113,0.7)", fontSize: 11, cursor: "pointer" }}
            >
              <XIcon /> Reject
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onApprove?.(cmd.id, trustMode); }}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 6, border: "none", background: "rgba(16,185,129,0.6)", color: "white", fontSize: 11, fontWeight: 500, cursor: "pointer" }}
            >
              <CheckIcon /> Approve
            </button>
          </div>
        </div>
      )}

      {/* Running cancel button */}
      {isRunning && (
        <div style={{ padding: "0 12px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "rgba(96,165,250,0.5)", fontStyle: "italic" }}>In progress…</span>
          <button
            onClick={(e) => { e.stopPropagation(); onCancel?.(cmd.id); }}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 4, border: "none", background: "transparent", color: "rgba(255,255,255,0.3)", fontSize: 10, cursor: "pointer" }}
          >
            <StopIcon /> Cancel
          </button>
        </div>
      )}

      {/* Agent source label */}
      {cmd.source === "agent" && !needsApproval && cmd.spec.purpose && (
        <div style={{ padding: "0 12px 6px" }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>{cmd.spec.purpose}</span>
        </div>
      )}

      {/* Expanded output metadata */}
      {expanded && cmd.outputMetadata && (
        <div style={{ padding: "8px 12px 12px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", fontStyle: "italic", marginTop: 4 }}>
            {cmd.outputMetadata.totalBytesReceived} bytes received
            {cmd.outputMetadata.truncated ? " (output truncated)" : ""}
            {" · "}stdout {cmd.outputMetadata.stdoutBytes}B · stderr {cmd.outputMetadata.stderrBytes}B
          </p>
        </div>
      )}

      {/* Expanded risk / source row */}
      {expanded && (
        <div style={{ padding: "6px 12px 8px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: 8 }}>
          {cmd.spec.purpose && cmd.source !== "agent" && (
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", fontStyle: "italic" }}>{cmd.spec.purpose}</span>
          )}
          <span style={{ fontSize: 10, fontFamily: "monospace", padding: "1px 6px", borderRadius: 4, background: riskBg, color: riskColor }}>
            {riskLabel(riskClass)}
          </span>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginLeft: "auto" }}>
            {cmd.source === "agent" ? "agent" : "user"}
          </span>
        </div>
      )}
    </div>
  );
}