import React, { useEffect, useState, useCallback } from "react";
import type { AgentConfig, ConnectionTestResult, Protocol, CapabilityDef, CapabilityPolicy, CapabilityPolicyStore } from "@shared/types.js";

interface Props {
  config: AgentConfig;
  onClose: () => void;
  onReconfigure: () => void;
  onSave: (updated: AgentConfig) => Promise<void>;
}

type Section = "agent" | "appearance" | "permissions" | "privacy" | "about";

export default function SettingsModal({
  config,
  onClose,
  onReconfigure,
  onSave,
}: Props): React.ReactElement {
  const [section, setSection] = useState<Section>("agent");
  const [name, setName] = useState(config.name);
  const [endpoint, setEndpoint] = useState(config.endpoint);
  const [protocol, setProtocol] = useState<Protocol>(config.protocol);
  const [model, setModel] = useState(config.model);
  const [hasKey, setHasKey] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    void window.forgeApi.settings.getSettings().then((s: { incidentSharingEnabled: boolean }) => setSharingEnabled(s.incidentSharingEnabled));
  }, []);

  const handleSharingToggle = async (v: boolean): Promise<void> => {
    setSettingsLoading(true);
    try {
      await window.forgeApi.settings.setSettings({ incidentSharingEnabled: v });
      setSharingEnabled(v);
    } finally {
      setSettingsLoading(false);
    }
  };

  useEffect(() => {
    void window.forgeApi.hasSecret(config.id).then(setHasKey);
  }, [config.id]);

  // Close on backdrop click
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleSave = async (): Promise<void> => {
    setIsSaving(true);
    try {
      const updated: AgentConfig = {
        ...config,
        name: name.trim() || config.name,
        endpoint: endpoint.trim() || config.endpoint,
        protocol,
        model: model.trim() || config.model,
      };
      await onSave(updated);
    } catch {
      // IPC error — button re-enables so user can retry
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const updated: AgentConfig = {
        ...config,
        name: name.trim() || config.name,
        endpoint: endpoint.trim() || config.endpoint,
        protocol,
        model: model.trim() || config.model,
      };
      const result = await window.forgeApi.testConnection(updated);
      setTestResult(result);
    } catch {
      setTestResult({ status: "error", message: "Connection failed. Check settings and try again." });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="w-full max-w-lg rounded-2xl border border-[#262629] bg-[#0d0d0f] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#1a1a1e] px-5 py-4">
          <h2 className="text-sm font-semibold text-[#e8e8ec]">Settings</h2>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[#7a7a85] transition-colors hover:bg-[#1a1a1e] hover:text-[#e8e8ec]"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Nav + Content */}
        <div className="flex min-h-[360px]">
          {/* Sidebar nav */}
          <nav className="w-40 flex-shrink-0 border-r border-[#1a1a1e] p-3 space-y-0.5">
            {(["agent", "appearance", "permissions", "privacy", "about"] as Section[]).map((s) => (
              <button
                key={s}
                onClick={() => setSection(s)}
                className={`w-full rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${
                  section === s
                    ? "bg-[#1a1a1e] text-[#e8e8ec]"
                    : "text-[#7a7a85] hover:bg-[#141416] hover:text-[#e8e8ec]"
                }`}
              >
                {s === "agent"
                  ? "Agent Connection"
                  : s === "appearance"
                  ? "Appearance"
                  : s === "permissions"
                  ? "Permissions"
                  : s === "privacy"
                  ? "Privacy"
                  : "About"}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 p-5">
            {section === "agent" && (
              <AgentSection
                name={name}
                endpoint={endpoint}
                protocol={protocol}
                model={model}
                hasKey={hasKey}
                isTesting={isTesting}
                isSaving={isSaving}
                testResult={testResult}
                onName={setName}
                onEndpoint={setEndpoint}
                onProtocol={setProtocol}
                onModel={setModel}
                onTest={() => void handleTest()}
                onSave={() => void handleSave()}
                onReplaceKey={onReconfigure}
              />
            )}
            {section === "appearance" && <AppearanceSection />}
            {section === "permissions" && <PermissionsSection />}
            {section === "privacy" && (
              <PrivacySection
                sharingEnabled={sharingEnabled}
                loading={settingsLoading}
                onToggle={(v) => void handleSharingToggle(v)}
              />
            )}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Agent Section ───────────────────────────────────────────────────────────

function AgentSection({
  name,
  endpoint,
  protocol,
  model,
  hasKey,
  isTesting,
  isSaving,
  testResult,
  onName,
  onEndpoint,
  onProtocol,
  onModel,
  onTest,
  onSave,
  onReplaceKey,
}: {
  name: string;
  endpoint: string;
  protocol: Protocol;
  model: string;
  hasKey: boolean;
  isTesting: boolean;
  isSaving: boolean;
  testResult: ConnectionTestResult | null;
  onName: (v: string) => void;
  onEndpoint: (v: string) => void;
  onProtocol: (v: Protocol) => void;
  onModel: (v: string) => void;
  onTest: () => void;
  onSave: () => void;
  onReplaceKey: () => void;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      <SField label="Agent Name">
        <input
          type="text"
          value={name}
          onChange={(e) => onName(e.target.value)}
          className={inputCls}
        />
      </SField>

      <SField label="Endpoint">
        <input
          type="url"
          value={endpoint}
          onChange={(e) => onEndpoint(e.target.value)}
          className={inputCls}
          spellCheck={false}
        />
      </SField>

      <SField label="Protocol">
        <select
          value={protocol}
          onChange={(e) => onProtocol(e.target.value as Protocol)}
          className={`${inputCls} cursor-pointer`}
        >
          <option value="openai">OpenAI Compatible</option>
          <option value="anthropic">Anthropic Compatible</option>
        </select>
      </SField>

      <SField label="Model">
        <input
          type="text"
          value={model}
          onChange={(e) => onModel(e.target.value)}
          className={inputCls}
          spellCheck={false}
        />
      </SField>

      {/* API Key status */}
      <SField label="API Key">
        <div className="flex items-center justify-between rounded-lg border border-[#262629] bg-[#141416] px-3 py-2.5">
          <span className="font-mono text-xs text-[#7a7a85]">
            {hasKey ? "••••••••••••" : "Not configured"}
          </span>
          <span
            className={`text-[10px] font-medium ${
              hasKey ? "text-[#34d399]" : "text-[#f87171]"
            }`}
          >
            {hasKey ? "Configured" : "Missing"}
          </span>
        </div>
        <button
          onClick={onReplaceKey}
          className="mt-2 text-xs text-[#6366f1] hover:text-[#7578f3] transition-colors"
        >
          Replace API Key…
        </button>
      </SField>

      {/* Test result */}
      {testResult && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            testResult.status === "connected"
              ? "border-[#34d399]/20 bg-[#34d399]/5 text-[#34d399]"
              : "border-[#f87171]/20 bg-[#f87171]/5 text-[#f87171]"
          }`}
        >
          {testResult.message}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={onTest}
          disabled={isTesting}
          className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[#262629] bg-[#141416] text-xs font-medium text-[#e8e8ec] transition-colors hover:border-[#3a3a42] hover:bg-[#1a1a1e] disabled:opacity-40"
        >
          {isTesting ? "Testing…" : "Test Connection"}
        </button>
        <button
          onClick={onSave}
          disabled={isSaving}
          className="flex h-8 flex-1 items-center justify-center rounded-lg bg-[#6366f1] text-xs font-medium text-white transition-colors hover:bg-[#7578f3] disabled:opacity-40"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Appearance Section ──────────────────────────────────────────────────────

function AppearanceSection(): React.ReactElement {
  return (
    <div className="space-y-3">
      <p className="text-xs text-[#7a7a85]">Theme</p>
      <div className="flex items-center gap-2 rounded-lg border border-[#6366f1]/40 bg-[#6366f1]/5 px-3 py-2.5">
        <span className="h-3 w-3 rounded-full bg-[#0d0d0f] border border-[#262629]" />
        <span className="text-xs font-medium text-[#e8e8ec]">Dark</span>
        <span className="ml-auto text-[10px] text-[#6366f1]">Active</span>
      </div>
      <p className="text-[10px] text-[#3a3a42]">
        Additional themes available in a future release.
      </p>
    </div>
  );
}

// ── About Section ───────────────────────────────────────────────────────────

function AboutSection(): React.ReactElement {
  const hash = typeof __FORGE_BUILD_HASH__ !== "undefined" ? __FORGE_BUILD_HASH__ : "dev";
  const built = typeof __FORGE_BUILD_TIME__ !== "undefined"
    ? new Date(__FORGE_BUILD_TIME__).toLocaleString()
    : "unknown";
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#141416]">
          <svg width="22" height="22" viewBox="0 0 48 48" fill="none">
            <path
              d="M14 24L24 14L34 24L24 34L14 24Z"
              stroke="#6366f1"
              strokeWidth="1.5"
              strokeLinejoin="round"
              fill="none"
            />
            <circle cx="24" cy="24" r="3" fill="#6366f1" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-[#e8e8ec]">Uzmoon Forge</p>
          <p className="text-xs text-[#7a7a85]">Version 0.1.0</p>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-[#7a7a85]">
        A minimal, focused interface for connecting and chatting with custom
        AI-compatible agent endpoints.
      </p>
      <div className="rounded-lg border border-[#1a1a1e] bg-[#0a0a0c] px-3 py-2.5 space-y-1">
        <div className="flex justify-between">
          <span className="text-[10px] text-[#3a3a42]">Build</span>
          <span className="font-mono text-[10px] text-[#6366f1]">{hash}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[10px] text-[#3a3a42]">Built</span>
          <span className="text-[10px] text-[#7a7a85]">{built}</span>
        </div>
      </div>
    </div>
  );
}


// ── Privacy Section ────────────────────────────────────────────────────────

function PrivacySection({
  sharingEnabled,
  loading,
  onToggle,
}: {
  sharingEnabled: boolean;
  loading: boolean;
  onToggle: (v: boolean) => void;
}): React.ReactElement {
  return (
    <div className="space-y-5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[#7a7a85]">
        Incident Sharing
      </p>

      {/* Toggle row */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <p className="text-xs font-medium text-[#e8e8ec]">Share incident reports</p>
          <p className="mt-1 text-[10px] leading-relaxed text-[#7a7a85]">
            When enabled, you can generate a sanitized incident payload to share
            with the Uzmoon team. All secrets and absolute paths are redacted
            before sharing. <strong className="text-[#3a3a42]">Off by default.</strong>
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={sharingEnabled}
          disabled={loading}
          onClick={() => onToggle(!sharingEnabled)}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:opacity-40 ${
            sharingEnabled ? "bg-[#6366f1]" : "bg-[#262629]"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              sharingEnabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* Status indicator */}
      <div
        className={`rounded-lg border px-3 py-2.5 text-xs ${
          sharingEnabled
            ? "border-[#6366f1]/20 bg-[#6366f1]/5 text-[#6366f1]"
            : "border-[#262629] bg-[#141416] text-[#7a7a85]"
        }`}
      >
        {sharingEnabled
          ? "Incident sharing is enabled. Payload is sanitized before sharing."
          : "Incident sharing is disabled. No data will be sent or shared."}
      </div>

      <p className="text-[10px] leading-relaxed text-[#3a3a42]">
        This setting only controls whether the share payload button is available
        in the Reliability panel. No data is ever sent automatically.
      </p>
    </div>
  );
}


// ── Permissions Section ─────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  browser: "Browser",
  terminal: "Terminal",
  git: "Git",
  filesystem: "Filesystem",
  network: "Network",
  process: "Process",
  device: "Device",
  future: "Future",
};

const RISK_COLOR: Record<string, string> = {
  LOW: "text-[#34d399]",
  MEDIUM: "text-[#fbbf24]",
  HIGH: "text-[#f97316]",
  CRITICAL: "text-[#f87171]",
};

const POLICY_OPTIONS: { value: CapabilityPolicy; label: string }[] = [
  { value: "ALWAYS_ALLOW", label: "Always Allow" },
  { value: "ASK", label: "Ask Each Time" },
  { value: "DENY", label: "Always Deny" },
];

function PermissionsSection(): React.ReactElement {
  const [caps, setCaps] = useState<CapabilityDef[]>([]);
  const [store, setStore] = useState<CapabilityPolicyStore | null>(null);
  const [activePreset, setActivePreset] = useState<"SAFE" | "ASK" | "FULL_ACCESS" | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("browser");

  const reload = useCallback(async () => {
    const [capList, storeData] = await Promise.all([
      window.forgeApi.permissions.getCapabilities(),
      window.forgeApi.permissions.getStore(),
    ]);
    setCaps(capList);
    setStore(storeData);
    setActivePreset(storeData.preset ?? null);
    if (capList.length > 0 && !activeCategory) {
      const first = capList[0];
      if (first) setActiveCategory(first.category);
    }
    setLoading(false);
  }, [activeCategory]);

  useEffect(() => { void reload(); }, [reload]);

  const categories = [...new Set(caps.map((c) => c.category))];

  const getEffectivePolicy = (capId: string): CapabilityPolicy => {
    if (!store) return "ASK";
    return store.globalPolicies[capId] ?? caps.find((c) => c.id === capId)?.defaultPolicy ?? "ASK";
  };

  const handleSetPolicy = async (capId: string, policy: CapabilityPolicy): Promise<void> => {
    setSaving(capId);
    try {
      await window.forgeApi.permissions.setGlobal(capId, policy);
      await reload();
    } finally {
      setSaving(null);
    }
  };

  const handleSetPreset = async (preset: "SAFE" | "ASK" | "FULL_ACCESS"): Promise<void> => {
    setSaving("preset");
    try {
      await window.forgeApi.permissions.setPreset(preset);
      setActivePreset(preset);
      await reload();
    } finally {
      setSaving(null);
    }
  };

  const handleClearPreset = async (): Promise<void> => {
    setSaving("preset");
    try {
      await window.forgeApi.permissions.clearPreset();
      setActivePreset(null);
      await reload();
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <span className="text-xs text-[#3a3a42]">Loading capabilities…</span>
      </div>
    );
  }

  const visibleCaps = caps.filter((c) => c.category === activeCategory);

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Preset bar */}
      <div>
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[#7a7a85]">Preset</p>
        <div className="flex gap-1.5">
          {(["SAFE", "ASK", "FULL_ACCESS"] as const).map((p) => (
            <button
              key={p}
              onClick={() => void (activePreset === p ? handleClearPreset() : handleSetPreset(p))}
              disabled={saving === "preset"}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-[10px] font-medium transition-colors disabled:opacity-40 ${
                activePreset === p
                  ? "border-[#6366f1]/60 bg-[#6366f1]/10 text-[#6366f1]"
                  : "border-[#262629] bg-[#141416] text-[#7a7a85] hover:border-[#3a3a42] hover:text-[#e8e8ec]"
              }`}
            >
              {p === "FULL_ACCESS" ? "Full Access" : p === "SAFE" ? "Safe" : "Ask All"}
            </button>
          ))}
        </div>
        {activePreset && (
          <p className="mt-1.5 text-[10px] text-[#3a3a42]">
            Active preset: <span className="text-[#6366f1]">{activePreset}</span>.
            Individual overrides still apply on top.
          </p>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 flex-wrap">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
              activeCategory === cat
                ? "bg-[#1a1a1e] text-[#e8e8ec]"
                : "text-[#3a3a42] hover:text-[#7a7a85]"
            }`}
          >
            {CATEGORY_LABELS[cat] ?? cat}
          </button>
        ))}
      </div>

      {/* Capability list */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-0.5" style={{ maxHeight: 220 }}>
        {visibleCaps.map((cap) => {
          const current = getEffectivePolicy(cap.id);
          const hasOverride = store?.globalPolicies[cap.id] !== undefined;
          return (
            <div key={cap.id} className="rounded-lg border border-[#1a1a1e] bg-[#0a0a0c] px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-[#e8e8ec]">{cap.name}</span>
                    <span className={`text-[9px] font-semibold ${RISK_COLOR[cap.risk] ?? "text-[#7a7a85]"}`}>
                      {cap.risk}
                    </span>
                    {cap.isDestructive && (
                      <span className="text-[9px] text-[#f87171]">DESTRUCTIVE</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-[#3a3a42]">{cap.description}</p>
                </div>
                <select
                  value={current}
                  disabled={saving === cap.id}
                  onChange={(e) => void handleSetPolicy(cap.id, e.target.value as CapabilityPolicy)}
                  className="flex-shrink-0 rounded-md border border-[#262629] bg-[#141416] px-2 py-1 text-[10px] text-[#e8e8ec] focus:border-[#6366f1] focus:outline-none disabled:opacity-40 cursor-pointer"
                >
                  {POLICY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                  {/* Show current policy from preset/default if not in standard set */}
                  {!POLICY_OPTIONS.some((o) => o.value === current) && (
                    <option value={current}>{current}</option>
                  )}
                </select>
              </div>
              {hasOverride && (
                <button
                  onClick={() => void handleSetPolicy(cap.id, cap.defaultPolicy)}
                  className="mt-1.5 text-[9px] text-[#3a3a42] hover:text-[#7a7a85] transition-colors"
                >
                  Reset to default ({cap.defaultPolicy})
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-lg border border-[#262629] bg-[#141416] px-3 py-2 text-xs text-[#e8e8ec] placeholder-[#3a3a42] focus:border-[#6366f1] focus:outline-none";

function SField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] font-medium uppercase tracking-wide text-[#7a7a85]">
        {label}
      </label>
      {children}
    </div>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}