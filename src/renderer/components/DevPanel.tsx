/**
 * V17 — Dev Panel
 *
 * Read-only diagnostic overlay accessible via Cmd+Shift+D in development builds.
 * Sections: Overview · Runs · Queue · Browser · Incidents · Logs · Export
 */
import React, { useState, useEffect, useCallback } from "react";

// ── Types (mirrored from dev-state.ts) ────────────────────────────────────

interface DevRunSummary {
  requestId: string;
  agentRunId: string;
  conversationId: string;
  state: string;
  startedAt: number;
  durationMs: number;
  toolStepCount: number;
  waitingForHuman: boolean;
  approvalPending: boolean;
}

interface DevQueueSummary {
  conversationId: string;
  queuedCount: number;
  processingCount: number;
  failedCount: number;
  paused: boolean;
}

interface DevBrowserSummary {
  windowOpen: boolean;
  windowHealthy: boolean;
  tabCount: number;
  activeAgentControls: number;
  conversationBindings: number;
  pendingApprovals: number;
}

interface DevIncidentSummary {
  id: string;
  invariantId: string;
  category: string;
  failureCode: string;
  timestamp: number;
  fingerprint: string;
}

interface HangWarning {
  requestId: string;
  durationMs: number;
  lastToolMs: number | null;
}

interface DevSnapshot {
  capturedAt: number;
  appVersion: string;
  activeRuns: DevRunSummary[];
  queueSummary: DevQueueSummary[];
  browser: DevBrowserSummary;
  recentIncidents: DevIncidentSummary[];
  logStats: { total: number; errors: number; warnings: number; fatals: number };
  hangWarnings: HangWarning[];
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Badge({ text, color }: { text: string; color: "green" | "blue" | "amber" | "red" | "gray" }) {
  const map = {
    green: "bg-emerald-500/20 text-emerald-400",
    blue: "bg-blue-500/20 text-blue-400",
    amber: "bg-amber-500/20 text-amber-400",
    red: "bg-red-500/20 text-red-400",
    gray: "bg-white/10 text-white/40",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${map[color]}`}>{text}</span>
  );
}

function stateBadgeColor(state: string): "green" | "blue" | "amber" | "red" | "gray" {
  if (state === "completed") return "green";
  if (state === "processing_turn" || state === "executing_tools" || state === "continuing") return "blue";
  if (state === "waiting_for_human") return "amber";
  if (state === "failed" || state === "cancelled") return "red";
  return "gray";
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs py-0.5">
      <span className="text-white/40 w-40 flex-shrink-0">{label}</span>
      <span className="text-white/80 font-mono truncate">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[11px] text-white/30 uppercase tracking-wider mb-2 px-1">{title}</div>
      <div className="bg-white/4 border border-white/8 rounded-lg p-3 space-y-0.5">
        {children}
      </div>
    </div>
  );
}

// ── Panels ─────────────────────────────────────────────────────────────────

function OverviewPanel({ snapshot }: { snapshot: DevSnapshot }) {
  return (
    <div>
      <Section title="App">
        <Row label="Version" value={snapshot.appVersion} />
        <Row label="Snapshot taken" value={new Date(snapshot.capturedAt).toLocaleTimeString()} />
        <Row label="Active runs" value={snapshot.activeRuns.length} />
        <Row label="Hang warnings" value={
          snapshot.hangWarnings.length > 0
            ? <Badge text={String(snapshot.hangWarnings.length)} color="amber" />
            : "none"
        } />
      </Section>

      <Section title="Logs">
        <Row label="Total entries" value={snapshot.logStats.total} />
        <Row label="Errors" value={
          snapshot.logStats.errors > 0
            ? <Badge text={String(snapshot.logStats.errors)} color="red" />
            : "0"
        } />
        <Row label="Warnings" value={
          snapshot.logStats.warnings > 0
            ? <Badge text={String(snapshot.logStats.warnings)} color="amber" />
            : "0"
        } />
        <Row label="Fatals" value={
          snapshot.logStats.fatals > 0
            ? <Badge text={String(snapshot.logStats.fatals)} color="red" />
            : "0"
        } />
      </Section>

      <Section title="Browser">
        <Row label="Window open" value={snapshot.browser.windowOpen ? "yes" : "no"} />
        <Row label="Window healthy" value={
          snapshot.browser.windowOpen
            ? (snapshot.browser.windowHealthy
              ? <Badge text="healthy" color="green" />
              : <Badge text="DESYNC" color="red" />)
            : "—"
        } />
        <Row label="Tab views" value={snapshot.browser.tabCount} />
        <Row label="Agent controls" value={snapshot.browser.activeAgentControls} />
        <Row label="Pending approvals" value={
          snapshot.browser.pendingApprovals > 0
            ? <Badge text={String(snapshot.browser.pendingApprovals)} color="amber" />
            : "0"
        } />
      </Section>
    </div>
  );
}

function RunsPanel({ snapshot }: { snapshot: DevSnapshot }) {
  if (snapshot.activeRuns.length === 0) {
    return <div className="text-xs text-white/30 text-center py-8">No active runs</div>;
  }
  return (
    <div className="space-y-3">
      {snapshot.activeRuns.map((run) => (
        <div key={run.requestId} className="bg-white/4 border border-white/8 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <Badge text={run.state} color={stateBadgeColor(run.state)} />
            {run.waitingForHuman && <Badge text="waiting for human" color="amber" />}
            {run.approvalPending && <Badge text="approval pending" color="amber" />}
          </div>
          <Row label="requestId" value={run.requestId.slice(0, 8) + "…"} />
          <Row label="agentRunId" value={run.agentRunId.slice(0, 8) + "…"} />
          <Row label="conversationId" value={run.conversationId.slice(0, 8) + "…"} />
          <Row label="Duration" value={`${(run.durationMs / 1000).toFixed(1)}s`} />
          <Row label="Tool steps" value={run.toolStepCount} />
        </div>
      ))}
      {snapshot.hangWarnings.length > 0 && (
        <div className="border border-amber-500/20 bg-amber-500/5 rounded-lg p-3">
          <div className="text-[11px] text-amber-400 mb-1">Hang Warnings</div>
          {snapshot.hangWarnings.map((w) => (
            <div key={w.requestId} className="text-xs text-white/50">
              {w.requestId.slice(0, 8)} — {(w.durationMs / 1000).toFixed(0)}s elapsed, last tool: {
                w.lastToolMs ? `${Math.floor((Date.now() - w.lastToolMs) / 1000)}s ago` : "none"
              }
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QueuePanel({ snapshot }: { snapshot: DevSnapshot }) {
  if (snapshot.queueSummary.length === 0) {
    return <div className="text-xs text-white/30 text-center py-8">No active queues</div>;
  }
  return (
    <div className="space-y-2">
      {snapshot.queueSummary.map((q) => (
        <div key={q.conversationId} className="bg-white/4 border border-white/8 rounded-lg p-3">
          <Row label="conversationId" value={q.conversationId.slice(0, 8) + "…"} />
          <Row label="Queued" value={q.queuedCount} />
          <Row label="Processing" value={q.processingCount} />
          <Row label="Failed" value={
            q.failedCount > 0 ? <Badge text={String(q.failedCount)} color="red" /> : "0"
          } />
          <Row label="Paused" value={q.paused ? <Badge text="paused" color="amber" /> : "no"} />
        </div>
      ))}
    </div>
  );
}

function BrowserPanel({ snapshot }: { snapshot: DevSnapshot }) {
  const b = snapshot.browser;
  return (
    <Section title="Browser Runtime State">
      <Row label="Window open" value={b.windowOpen ? "yes" : "no"} />
      <Row label="Window healthy" value={
        b.windowOpen
          ? (b.windowHealthy ? <Badge text="healthy" color="green" /> : <Badge text="DESYNC" color="red" />)
          : "—"
      } />
      <Row label="Tab views (live)" value={b.tabCount} />
      <Row label="Agent controls" value={b.activeAgentControls} />
      <Row label="Conv bindings" value={b.conversationBindings} />
      <Row label="Pending approvals" value={
        b.pendingApprovals > 0
          ? <Badge text={String(b.pendingApprovals)} color="amber" />
          : "0"
      } />
    </Section>
  );
}

function IncidentsPanel({ snapshot }: { snapshot: DevSnapshot }) {
  if (snapshot.recentIncidents.length === 0) {
    return <div className="text-xs text-white/30 text-center py-8">No incidents recorded</div>;
  }
  return (
    <div className="space-y-2">
      {[...snapshot.recentIncidents].reverse().map((inc) => (
        <div key={inc.id} className="bg-red-900/10 border border-red-500/15 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Badge text={inc.category} color="red" />
            <Badge text={inc.failureCode} color="gray" />
          </div>
          <Row label="invariantId" value={inc.invariantId} />
          <Row label="fingerprint" value={inc.fingerprint.slice(0, 12) + "…"} />
          <Row label="time" value={new Date(inc.timestamp).toLocaleTimeString()} />
        </div>
      ))}
    </div>
  );
}

function PermissionChecksPanel() {
  const [checks, setChecks] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.forgeApi.permissions.getChecks(200);
      setChecks(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = (checks as Array<{
    id: string;
    capabilityId: string;
    decision: string;
    source: string;
    reason: string;
    checkedAt?: number;
    durationMs?: number;
  }>).filter((c) =>
    !filter ||
    c.capabilityId.toLowerCase().includes(filter.toLowerCase()) ||
    c.decision.toLowerCase().includes(filter.toLowerCase()) ||
    c.source.toLowerCase().includes(filter.toLowerCase())
  ).slice().reverse();

  return (
    <div>
      <div className="mb-2 flex gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by capability, decision, source…"
          className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/80 placeholder:text-white/30 outline-none focus:border-white/20"
        />
        <button
          onClick={() => void load()}
          disabled={loading}
          className="px-2 py-1 text-xs bg-white/8 text-white/60 rounded hover:bg-white/12 transition-colors disabled:opacity-40"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      <div className="space-y-0.5 max-h-96 overflow-y-auto font-mono">
        {filtered.map((c, i) => (
          <div key={c.id ?? i} className={`text-[10px] px-2 py-1 rounded flex gap-2 items-center ${
            c.decision === "DENY"
              ? "bg-red-900/20 text-red-300/80"
              : c.decision === "ASK"
              ? "bg-amber-900/10 text-amber-300/70"
              : "bg-white/3 text-white/50"
          }`}>
            <span className="text-white/20 flex-shrink-0 w-16 text-right">
              {c.checkedAt ? new Date(c.checkedAt).toLocaleTimeString() : ""}
            </span>
            <span className={`flex-shrink-0 w-12 font-semibold ${
              c.decision === "DENY" ? "text-red-400" : c.decision === "ASK" ? "text-amber-400" : "text-emerald-400"
            }`}>
              {c.decision}
            </span>
            <span className="flex-shrink-0 text-white/30 w-14 truncate">{c.source}</span>
            <span className="truncate text-white/70">{c.capabilityId}</span>
            <span className="text-white/25 truncate">{c.reason}</span>
            {c.durationMs !== undefined && (
              <span className="flex-shrink-0 text-white/20">{c.durationMs}ms</span>
            )}
          </div>
        ))}
        {filtered.length === 0 && !loading && (
          <div className="text-xs text-white/30 text-center py-4">No permission checks recorded</div>
        )}
      </div>
      {checks.length > 0 && (
        <div className="mt-2 text-[10px] text-white/20 text-right">
          {checks.length} total checks · {filtered.length} shown
        </div>
      )}
    </div>
  );
}

function LogsPanel() {
  const [entries, setEntries] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.forgeApi.devPanel.getSnapshot();
      void data; // we fetch logs separately
      const logs = await window.forgeApi.telemetry.getEvents({ limit: 200, ...(filter ? { search: filter } : {}) });
      setEntries(logs);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div className="mb-2 flex gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search events…"
          className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/80 placeholder:text-white/30 outline-none focus:border-white/20"
        />
        <button
          onClick={() => void load()}
          disabled={loading}
          className="px-2 py-1 text-xs bg-white/8 text-white/60 rounded hover:bg-white/12 transition-colors disabled:opacity-40"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      <div className="space-y-0.5 max-h-96 overflow-y-auto font-mono">
        {(entries as Array<{ id?: number; level?: string; category?: string; event?: string; timestamp?: number }>)
          .map((e, i) => (
          <div key={e.id ?? i} className={`text-[10px] px-2 py-0.5 rounded flex gap-2 ${
            e.level === "error" || e.level === "fatal"
              ? "bg-red-900/20 text-red-300/80"
              : e.level === "warn"
              ? "bg-amber-900/10 text-amber-300/70"
              : "text-white/40"
          }`}>
            <span className="text-white/20 flex-shrink-0">{e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ""}</span>
            <span className="flex-shrink-0 uppercase">{e.level}</span>
            <span className="text-white/30 flex-shrink-0">{e.category}</span>
            <span className="text-white/70 truncate">{e.event}</span>
          </div>
        ))}
        {entries.length === 0 && !loading && (
          <div className="text-xs text-white/30 text-center py-4">No log entries</div>
        )}
      </div>
    </div>
  );
}

// ── Types for Tasks panel ─────────────────────────────────────────────────

interface DevTaskStep {
  id: string;
  title: string;
  type: string;
  status: string;
  attemptCount: number;
  dependencies: string[];
  error?: string;
}

interface DevTaskPlan {
  version: number;
  steps: DevTaskStep[];
  reasonForRevision?: string;
}

interface DevTask {
  id: string;
  goal: string;
  status: string;
  conversationId: string;
  planVersion: number;
  currentStepId?: string;
  createdAt: number;
  updatedAt: number;
  failure?: { code: string; message: string };
}

function stepStatusBadge(status: string): string {
  switch (status) {
    case "completed": return "text-emerald-400";
    case "running":   return "text-blue-400";
    case "failed":    return "text-red-400";
    case "blocked":   return "text-amber-400";
    case "skipped":   return "text-white/30";
    default:          return "text-white/40";
  }
}

function TasksPanel() {
  const [tasks, setTasks] = useState<DevTask[]>([]);
  const [plans, setPlans] = useState<Record<string, DevTaskPlan>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Get active conversations and load tasks for each
      const convs = await window.forgeApi.listConversations(false, null);
      const allTasks: DevTask[] = [];
      const allPlans: Record<string, DevTaskPlan> = {};
      await Promise.all(
        convs.slice(0, 20).map(async (conv) => {
          const convTasks = await window.forgeApi.tasks.listByConv(conv.id);
          for (const t of convTasks) {
            allTasks.push(t as DevTask);
            const detail = await window.forgeApi.tasks.getTask(t.id);
            if (detail) allPlans[t.id] = detail.plan as unknown as DevTaskPlan;
          }
        })
      );
      allTasks.sort((a, b) => b.updatedAt - a.updatedAt);
      setTasks(allTasks);
      setPlans(allPlans);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "running": case "planning": case "verifying": return "text-blue-400";
      case "paused":    return "text-amber-400";
      case "completed": return "text-emerald-400";
      case "failed":    return "text-red-400";
      case "cancelled": return "text-white/30";
      default:          return "text-white/50";
    }
  };

  if (loading) {
    return <div className="p-4 text-xs text-white/40">Loading tasks…</div>;
  }

  if (tasks.length === 0) {
    return <div className="p-4 text-xs text-white/40">No tasks found. Task Runtime is enabled by default — send a project request to create one.</div>;
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-white/50">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
        <button
          onClick={() => void load()}
          className="text-xs px-2 py-0.5 rounded bg-white/8 hover:bg-white/12 text-white/50 hover:text-white/80 transition-colors"
        >
          Refresh
        </button>
      </div>

      {tasks.map((task) => {
        const plan = plans[task.id];
        const isOpen = expanded.has(task.id);
        const completedSteps = plan?.steps.filter(s => s.status === "completed" || s.status === "skipped").length ?? 0;
        const totalSteps = plan?.steps.length ?? 0;

        return (
          <div key={task.id} className="border border-white/8 rounded-lg overflow-hidden">
            {/* Task header */}
            <button
              onClick={() => toggleExpand(task.id)}
              className="w-full flex items-start gap-2 px-3 py-2 hover:bg-white/3 transition-colors text-left"
            >
              <span className="text-xs mt-0.5 text-white/30">{isOpen ? "▾" : "▸"}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-xs font-medium flex-shrink-0 ${statusColor(task.status)}`}>
                    {task.status}
                  </span>
                  <span className="text-xs text-white/70 truncate">{task.goal}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-white/30">{task.id.slice(0, 8)}</span>
                  {totalSteps > 0 && (
                    <span className="text-xs text-white/30">{completedSteps}/{totalSteps} steps</span>
                  )}
                  {plan?.version && plan.version > 1 && (
                    <span className="text-xs text-amber-400/60">v{plan.version}</span>
                  )}
                </div>
              </div>
            </button>

            {/* Expanded plan view */}
            {isOpen && plan && (
              <div className="border-t border-white/5 px-3 py-2 bg-white/2">
                <div className="text-xs text-white/30 mb-1.5">
                  Plan v{plan.version}{plan.reasonForRevision ? ` — ${plan.reasonForRevision}` : ""}
                </div>
                <div className="flex flex-col gap-1">
                  {plan.steps.map((step, idx) => (
                    <div key={step.id} className="flex items-start gap-2">
                      <span className="text-xs text-white/20 w-4 flex-shrink-0 mt-px">{idx + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-xs font-mono flex-shrink-0 ${stepStatusBadge(step.status)}`}>
                            {step.status}
                          </span>
                          <span className="text-xs text-white/70 truncate">{step.title}</span>
                          {step.attemptCount > 1 && (
                            <span className="text-xs text-amber-400/60 flex-shrink-0">×{step.attemptCount}</span>
                          )}
                        </div>
                        {step.error && (
                          <div className="text-xs text-red-300/70 mt-0.5 truncate">{step.error}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {task.failure && (
                  <div className="mt-2 text-xs text-red-300/70">
                    Failure: {task.failure.code} — {task.failure.message}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ExportPanel() {
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const doExport = async () => {
    setExporting(true);
    try {
      const bundle = await window.forgeApi.devPanel.exportBundle();
      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `forge-diagnostics-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExported(true);
      setTimeout(() => setExported(false), 3000);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <p className="text-xs text-white/50 mb-4">
        Export a sanitized diagnostic bundle (redacted logs, incidents, snapshot) as JSON.
        No secrets or API keys are included.
      </p>
      <button
        onClick={() => void doExport()}
        disabled={exporting}
        className="px-4 py-2 bg-blue-600/20 text-blue-400 border border-blue-500/30 rounded-lg text-sm font-medium hover:bg-blue-600/30 transition-colors disabled:opacity-40"
      >
        {exporting ? "Exporting…" : exported ? "Downloaded!" : "Export Diagnostic Bundle"}
      </button>
    </div>
  );
}

// ── Main DevPanel ──────────────────────────────────────────────────────────

type Tab = "overview" | "runs" | "queue" | "browser" | "incidents" | "permissions" | "logs" | "tasks" | "export";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Runs" },
  { id: "queue", label: "Queue" },
  { id: "browser", label: "Browser" },
  { id: "incidents", label: "Incidents" },
  { id: "permissions", label: "Perm Checks" },
  { id: "logs", label: "Logs" },
  { id: "tasks", label: "Tasks" },
  { id: "export", label: "Export" },
];

interface DevPanelProps {
  onClose: () => void;
}

export function DevPanel({ onClose }: DevPanelProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [snapshot, setSnapshot] = useState<DevSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await window.forgeApi.devPanel.getSnapshot() as DevSnapshot;
      setSnapshot(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-end justify-end p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#0e0e18] border border-white/10 rounded-2xl w-[480px] max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-sm font-semibold text-white/80">Dev Panel</span>
            {snapshot && (
              <span className="text-[10px] text-white/30 font-mono">v{snapshot.appVersion}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="text-[11px] text-white/40 hover:text-white/70 transition-colors disabled:opacity-40"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              onClick={onClose}
              className="w-5 h-5 rounded flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/8 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-white/8 px-3 overflow-x-auto flex-shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
                tab === t.id
                  ? "text-white/90 border-b border-white/60 -mb-px"
                  : "text-white/35 hover:text-white/60"
              }`}
            >
              {t.label}
              {t.id === "incidents" && snapshot && snapshot.recentIncidents.length > 0 && (
                <span className="ml-1 px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[9px]">
                  {snapshot.recentIncidents.length}
                </span>
              )}
              {t.id === "runs" && snapshot && snapshot.hangWarnings.length > 0 && (
                <span className="ml-1 px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[9px]">!</span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {!snapshot && loading && (
            <div className="text-xs text-white/30 text-center py-8">Loading…</div>
          )}
          {snapshot && (
            <>
              {tab === "overview" && <OverviewPanel snapshot={snapshot} />}
              {tab === "runs" && <RunsPanel snapshot={snapshot} />}
              {tab === "queue" && <QueuePanel snapshot={snapshot} />}
              {tab === "browser" && <BrowserPanel snapshot={snapshot} />}
              {tab === "incidents" && <IncidentsPanel snapshot={snapshot} />}
              {tab === "logs" && <LogsPanel />}
              {tab === "permissions" && <PermissionChecksPanel />}
              {tab === "tasks" && <TasksPanel />}
              {tab === "export" && <ExportPanel />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}