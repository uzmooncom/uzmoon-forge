/**
 * TerminalPanel.tsx — Safe Terminal V1 panel.
 *
 * Shows recent commands for the active project, handles live approval requests,
 * and allows the user to run safe commands manually.
 */
import React, { useEffect, useState, useCallback, useRef } from "react";
import type { CommandExecution } from "../../shared/types.js";
import { CommandCard } from "./CommandCard.js";
import { SafeCommandInput } from "./SafeCommandInput.js";

interface Props {
  projectId: string;
  projectRoot: string;
  activeConversationId?: string;
  onClose?: () => void;
}

// ── Icon ──────────────────────────────────────────────────────────────────────
function TerminalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.5 5l2.5 2-2.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2 3h8M5 3V2h2v1M4 3v7h4V3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TerminalPanel({ projectId, projectRoot, activeConversationId, onClose }: Props) {
  const [commands, setCommands] = useState<CommandExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const api = window.forgeApi.commands;

  // Load initial command list
  const reload = useCallback(async () => {
    try {
      const list = await api.list(projectId);
      // Sort newest first
      list.sort((a, b) => b.createdAt - a.createdAt);
      setCommands(list);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Subscribe to live state changes
  useEffect(() => {
    const unsub = api.onStateChange((cmd) => {
      if (cmd.projectId !== projectId) return;
      setCommands((prev) => {
        const idx = prev.findIndex((c) => c.id === cmd.id);
        if (idx === -1) return [cmd, ...prev];
        const next = [...prev];
        next[idx] = cmd;
        return next;
      });
    });
    return unsub;
  }, [api, projectId]);

  // Handlers
  const handleApprove = useCallback(async (commandId: string, mode: "once" | "trust") => {
    try {
      const updated = await api.approve(commandId, mode);
      if (updated) {
        setCommands((prev) => {
          const idx = prev.findIndex((c) => c.id === commandId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
      }
    } catch { /* ignore */ }
  }, [api]);

  const handleReject = useCallback(async (commandId: string) => {
    try {
      const updated = await api.reject(commandId);
      if (updated) {
        setCommands((prev) => {
          const idx = prev.findIndex((c) => c.id === commandId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
      }
    } catch { /* ignore */ }
  }, [api]);

  const handleCancel = useCallback(async (commandId: string) => {
    try {
      const updated = await api.cancel(commandId);
      if (updated) {
        setCommands((prev) => {
          const idx = prev.findIndex((c) => c.id === commandId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
      }
    } catch { /* ignore */ }
  }, [api]);

  const handleRunUser = useCallback(async (executable: string, args: string[]) => {
    try {
      const cmd = await api.runUser({
        projectId,
        projectRoot,
        executable,
        args,
        cwdRelative: "",
        ...(activeConversationId !== undefined && { conversationId: activeConversationId }),
      });
      setCommands((prev) => [cmd, ...prev]);
      // Scroll to top to show new command
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      console.error("runUser failed:", e);
    }
  }, [api, projectId, projectRoot, activeConversationId]);

  // Pending approvals at top
  const pending = commands.filter((c) => c.state === "awaiting_approval");
  const running = commands.filter((c) => c.state === "running" || c.state === "queued");
  const terminal = commands.filter((c) =>
    ["succeeded", "failed", "timed_out", "cancelled", "blocked"].includes(c.state)
  );
  const terminalShown = showAll ? terminal : terminal.slice(0, 8);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#0b0b10",
        borderLeft: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "rgba(255,255,255,0.4)" }}>
          <TerminalIcon />
        </span>
        <span style={{ fontSize: 11, fontWeight: 500, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Terminal
        </span>
        {pending.length > 0 && (
          <span
            style={{
              fontSize: 10,
              background: "rgba(251,191,36,0.2)",
              color: "#fbbf24",
              borderRadius: 10,
              padding: "1px 6px",
              marginLeft: 4,
            }}
          >
            {pending.length} awaiting
          </span>
        )}
        <div style={{ flex: 1 }} />
        {onClose && (
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.25)",
              cursor: "pointer",
              padding: 3,
              borderRadius: 4,
            }}
            title="Close terminal panel"
          >
            <CloseIcon />
          </button>
        )}
      </div>

      {/* User input */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)", flexShrink: 0 }}>
        <SafeCommandInput
          projectId={projectId}
          onSubmit={handleRunUser}
        />
      </div>

      {/* Command list */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        {loading && (
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", padding: "12px 4px" }}>Loading…</p>
        )}

        {!loading && commands.length === 0 && (
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", padding: "12px 4px", fontStyle: "italic" }}>
            No commands yet. Run a command above or ask the Agent to run one.
          </p>
        )}

        {/* Pending approvals */}
        {pending.map((cmd) => (
          <CommandCard
            key={cmd.id}
            cmd={cmd}
            onApprove={handleApprove}
            onReject={handleReject}
            onCancel={handleCancel}
          />
        ))}

        {/* Running */}
        {running.map((cmd) => (
          <CommandCard
            key={cmd.id}
            cmd={cmd}
            onApprove={handleApprove}
            onReject={handleReject}
            onCancel={handleCancel}
          />
        ))}

        {/* Terminal (completed) */}
        {terminalShown.map((cmd) => (
          <CommandCard
            key={cmd.id}
            cmd={cmd}
            onApprove={handleApprove}
            onReject={handleReject}
            onCancel={handleCancel}
          />
        ))}

        {/* Show more */}
        {!showAll && terminal.length > 8 && (
          <button
            onClick={() => setShowAll(true)}
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 6,
              color: "rgba(255,255,255,0.35)",
              fontSize: 11,
              padding: "6px 12px",
              cursor: "pointer",
              marginTop: 2,
            }}
          >
            Show {terminal.length - 8} more…
          </button>
        )}

        {/* Clear history (when no active/pending) */}
        {terminal.length > 0 && pending.length === 0 && running.length === 0 && (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 4 }}>
            <button
              onClick={async () => {
                // Optimistic clear of terminal items
                setCommands((prev) => prev.filter((c) =>
                  !["succeeded", "failed", "timed_out", "cancelled", "blocked"].includes(c.state)
                ));
                setShowAll(false);
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.2)",
                fontSize: 10,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <TrashIcon /> Clear history
            </button>
          </div>
        )}
      </div>
    </div>
  );
}