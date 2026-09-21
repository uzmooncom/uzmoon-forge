/**
 * AgentProfilesModal — manage all agent profiles (list, create, edit, test, delete, set default)
 */
import React, { useEffect, useState, useCallback } from "react";
import { randomUUID } from "../utils/id.js";
import type { AgentProfile, ConnectionTestResult, Protocol } from "../../shared/types.js";

interface Props {
  onClose: () => void;
  onProfilesChanged?: () => void;
}

type View = "list" | "edit";

const inputCls =
  "w-full rounded-lg border border-[#262629] bg-[#141416] px-3 py-2 text-xs text-[#e8e8ec] placeholder-[#3a3a42] focus:border-[#6366f1] focus:outline-none";

function SField({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] font-medium uppercase tracking-wide text-[#7a7a85]">
        {label}
      </label>
      {children}
      {hint && <p className="text-[10px] text-[#3a3a42]">{hint}</p>}
    </div>
  );
}

function StatusDot({ status }: { status?: AgentProfile["lastConnectionStatus"] }): React.ReactElement {
  if (status === "connected") return <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0 inline-block" />;
  if (status === "error") return <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 inline-block" />;
  if (status === "auth_failed") return <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0 inline-block" />;
  return <span className="w-2 h-2 rounded-full bg-white/15 flex-shrink-0 inline-block" />;
}

export default function AgentProfilesModal({ onClose, onProfilesChanged }: Props): React.ReactElement {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [view, setView] = useState<View>("list");
  const [editingProfile, setEditingProfile] = useState<AgentProfile | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    const ps = await window.forgeApi.listProfiles();
    setProfiles(ps);
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleNew = () => {
    const now = Date.now();
    const newProfile: AgentProfile = {
      id: randomUUID(),
      name: "",
      endpoint: "",
      protocol: "openai",
      model: "",
      isDefault: profiles.length === 0,
      createdAt: now,
      updatedAt: now,
    };
    setEditingProfile(newProfile);
    setView("edit");
  };

  const handleEdit = (p: AgentProfile) => {
    setEditingProfile(p);
    setView("edit");
  };

  const handleDelete = async (id: string) => {
    await window.forgeApi.deleteProfile(id);
    setDeleteConfirmId(null);
    await loadProfiles();
    onProfilesChanged?.();
  };

  const handleSetDefault = async (id: string) => {
    await window.forgeApi.setDefaultProfile(id);
    await loadProfiles();
    onProfilesChanged?.();
  };

  const handleSaved = async () => {
    setView("list");
    setEditingProfile(null);
    await loadProfiles();
    onProfilesChanged?.();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="w-full max-w-xl rounded-2xl border border-[#262629] bg-[#0d0d0f] shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#1a1a1e] px-5 py-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            {view === "edit" && (
              <button
                onClick={() => { setView("list"); setEditingProfile(null); }}
                className="flex items-center justify-center w-6 h-6 rounded-md text-[#7a7a85] hover:bg-[#1a1a1e] hover:text-[#e8e8ec] transition-colors"
              >
                <BackIcon />
              </button>
            )}
            <h2 className="text-sm font-semibold text-[#e8e8ec]">
              {view === "list" ? "Agent Profiles" : (editingProfile?.name || "New Agent")}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[#7a7a85] transition-colors hover:bg-[#1a1a1e] hover:text-[#e8e8ec]"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {view === "list" ? (
            <ProfileList
              profiles={profiles}
              deleteConfirmId={deleteConfirmId}
              onNew={handleNew}
              onEdit={handleEdit}
              onDelete={(id) => setDeleteConfirmId(id)}
              onDeleteConfirm={handleDelete}
              onDeleteCancel={() => setDeleteConfirmId(null)}
              onSetDefault={handleSetDefault}
            />
          ) : editingProfile ? (
            <ProfileEditForm
              profile={editingProfile}
              isNew={!profiles.find((p) => p.id === editingProfile.id)}
              onSaved={handleSaved}
              onCancel={() => { setView("list"); setEditingProfile(null); }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Profile List ─────────────────────────────────────────────────────────

function ProfileList({
  profiles,
  deleteConfirmId,
  onNew,
  onEdit,
  onDelete,
  onDeleteConfirm,
  onDeleteCancel,
  onSetDefault,
}: {
  profiles: AgentProfile[];
  deleteConfirmId: string | null;
  onNew: () => void;
  onEdit: (p: AgentProfile) => void;
  onDelete: (id: string) => void;
  onDeleteConfirm: (id: string) => Promise<void>;
  onDeleteCancel: () => void;
  onSetDefault: (id: string) => Promise<void>;
}): React.ReactElement {
  return (
    <div className="p-5 space-y-3">
      {profiles.length === 0 ? (
        <div className="text-center py-12 space-y-3">
          <p className="text-sm text-[#7a7a85]">No agent profiles yet</p>
          <p className="text-xs text-[#3a3a42]">Create one to start chatting</p>
        </div>
      ) : (
        <div className="space-y-2">
          {profiles.map((p) =>
            deleteConfirmId === p.id ? (
              <div
                key={p.id}
                className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 space-y-2"
              >
                <p className="text-xs text-[#e8e8ec]">
                  Delete <strong>{p.name}</strong>? This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => void onDeleteConfirm(p.id)}
                    className="flex h-7 flex-1 items-center justify-center rounded-lg bg-red-600 text-xs font-medium text-white hover:bg-red-500 transition-colors"
                  >
                    Delete
                  </button>
                  <button
                    onClick={onDeleteCancel}
                    className="flex h-7 flex-1 items-center justify-center rounded-lg border border-[#262629] bg-[#141416] text-xs text-[#e8e8ec] hover:bg-[#1a1a1e] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-xl border border-[#1a1a1e] bg-[#141416] px-4 py-3 hover:border-[#262629] transition-colors"
              >
                <StatusDot status={p.lastConnectionStatus} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[#e8e8ec] truncate">{p.name || "(unnamed)"}</span>
                    {p.isDefault && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#6366f1]/15 text-[#6366f1] font-medium flex-shrink-0">
                        default
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[#7a7a85] truncate">{p.model || "—"} · {p.endpoint || "—"}</p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!p.isDefault && (
                    <button
                      onClick={() => void onSetDefault(p.id)}
                      title="Set as default"
                      className="px-2 py-1 text-[10px] text-[#7a7a85] hover:text-[#e8e8ec] hover:bg-[#1a1a1e] rounded-lg transition-colors"
                    >
                      Set default
                    </button>
                  )}
                  <button
                    onClick={() => onEdit(p)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-[#7a7a85] hover:text-[#e8e8ec] hover:bg-[#1a1a1e] transition-colors"
                    title="Edit"
                  >
                    <EditIcon />
                  </button>
                  <button
                    onClick={() => onDelete(p.id)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-[#7a7a85] hover:text-red-400 hover:bg-red-400/10 transition-colors"
                    title="Delete"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      <button
        onClick={onNew}
        className="w-full flex items-center justify-center gap-2 h-9 rounded-xl border border-dashed border-[#262629] text-xs text-[#7a7a85] hover:border-[#6366f1]/40 hover:text-[#6366f1] transition-colors"
      >
        <PlusIcon />
        Add Agent Profile
      </button>
    </div>
  );
}

// ── Profile Edit Form ────────────────────────────────────────────────────

function ProfileEditForm({
  profile,
  isNew,
  onSaved,
  onCancel,
}: {
  profile: AgentProfile;
  isNew: boolean;
  onSaved: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description ?? "");
  const [endpoint, setEndpoint] = useState(profile.endpoint);
  const [protocol, setProtocol] = useState<Protocol>(profile.protocol);
  const [model, setModel] = useState(profile.model);
  const [apiKeyHeader, setApiKeyHeader] = useState(profile.apiKeyHeader ?? "");
  const [timeoutMs, setTimeoutMs] = useState(String(profile.timeoutMs ?? ""));
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [replaceKey, setReplaceKey] = useState(isNew);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  useEffect(() => {
    if (!isNew) {
      void window.forgeApi.hasSecret(profile.id).then(setHasKey);
    }
  }, [profile.id, isNew]);

  const buildProfile = (): AgentProfile => ({
    ...profile,
    name: name.trim() || "Unnamed Agent",
    ...(description.trim() && { description: description.trim() }),
    endpoint: endpoint.trim(),
    protocol,
    model: model.trim(),
    ...(apiKeyHeader.trim() && { apiKeyHeader: apiKeyHeader.trim() }),
    ...(timeoutMs.trim() && !isNaN(Number(timeoutMs)) && { timeoutMs: Number(timeoutMs) }),
    updatedAt: Date.now(),
  });

  const handleSave = async () => {
    if (!name.trim() || !endpoint.trim() || !model.trim()) return;
    if (replaceKey && !apiKey.trim()) return;
    setIsSaving(true);
    const p = buildProfile();
    await window.forgeApi.saveProfile(p);
    if (replaceKey && apiKey.trim()) {
      await window.forgeApi.setSecret(p.id, apiKey.trim());
    }
    setIsSaving(false);
    onSaved();
  };

  const handleTest = async () => {
    if (!endpoint.trim() || !model.trim()) return;
    setIsTesting(true);
    setTestResult(null);
    const p = buildProfile();
    // If replacing key, use the new one for the test; otherwise use stored
    if (replaceKey && apiKey.trim()) {
      await window.forgeApi.setSecret(p.id, apiKey.trim());
    }
    const result = await window.forgeApi.testConnection({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      protocol: p.protocol,
      model: p.model,
      ...(p.apiKeyHeader && { apiKeyHeader: p.apiKeyHeader }),
      ...(p.timeoutMs !== undefined && { timeoutMs: p.timeoutMs }),
    });
    setTestResult(result);
    setIsTesting(false);
  };

  const canSave = name.trim() && endpoint.trim() && model.trim() && (!replaceKey || apiKey.trim());

  return (
    <div className="p-5 space-y-4">
      <SField label="Agent Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Claude, GPT-4, Local Ollama"
          className={inputCls}
          autoFocus
        />
      </SField>

      <SField label="Description" hint="Optional — shown in the profile list">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this agent for?"
          className={inputCls}
        />
      </SField>

      <SField label="Endpoint URL">
        <input
          type="url"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://api.anthropic.com"
          className={inputCls}
          spellCheck={false}
        />
      </SField>

      <SField label="Protocol">
        <select
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as Protocol)}
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
          onChange={(e) => setModel(e.target.value)}
          placeholder="e.g. claude-sonnet-4-6, gpt-4o"
          className={inputCls}
          spellCheck={false}
        />
      </SField>

      <SField label="API Key Header" hint="Optional — overrides protocol default (e.g. X-API-Key)">
        <input
          type="text"
          value={apiKeyHeader}
          onChange={(e) => setApiKeyHeader(e.target.value)}
          placeholder="Authorization"
          className={inputCls}
          spellCheck={false}
        />
      </SField>

      <SField label="Timeout (ms)" hint="Optional — default 30000">
        <input
          type="number"
          value={timeoutMs}
          onChange={(e) => setTimeoutMs(e.target.value)}
          placeholder="30000"
          className={inputCls}
          min={1000}
          max={300000}
        />
      </SField>

      {/* API Key */}
      <SField label="API Key">
        {!replaceKey && hasKey ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border border-[#262629] bg-[#141416] px-3 py-2.5">
              <span className="font-mono text-xs text-[#7a7a85]">••••••••••••</span>
              <span className="text-[10px] font-medium text-[#34d399]">Configured</span>
            </div>
            <button
              onClick={() => setReplaceKey(true)}
              className="text-xs text-[#6366f1] hover:text-[#7578f3] transition-colors"
            >
              Replace API Key…
            </button>
          </div>
        ) : (
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={isNew ? "Enter API key" : "Enter new API key"}
            className={inputCls}
            autoComplete="off"
          />
        )}
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
          onClick={() => void handleTest()}
          disabled={isTesting || !endpoint.trim() || !model.trim()}
          className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[#262629] bg-[#141416] text-xs font-medium text-[#e8e8ec] transition-colors hover:border-[#3a3a42] hover:bg-[#1a1a1e] disabled:opacity-40"
        >
          {isTesting ? "Testing…" : "Test Connection"}
        </button>
        <button
          onClick={onCancel}
          className="flex h-8 items-center justify-center rounded-lg border border-[#262629] bg-[#141416] px-4 text-xs font-medium text-[#7a7a85] transition-colors hover:text-[#e8e8ec] hover:bg-[#1a1a1e]"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={isSaving || !canSave}
          className="flex h-8 flex-1 items-center justify-center rounded-lg bg-[#6366f1] text-xs font-medium text-white transition-colors hover:bg-[#7578f3] disabled:opacity-40"
        >
          {isSaving ? "Saving…" : isNew ? "Create" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────

function CloseIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function BackIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function PlusIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function EditIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function TrashIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}