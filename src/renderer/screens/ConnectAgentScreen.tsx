import React, { useEffect, useReducer, useRef, useState } from "react";
import { randomUUID } from "../utils/id.js";
import type {
  AgentConfig,
  AppState,
  ConnectionStatus,
  Protocol,
} from "@shared/types.js";

interface Props {
  initialConfigId: string | null;
  onComplete: (state: AppState) => void;
}

interface FormState {
  name: string;
  endpoint: string;
  protocol: Protocol;
  model: string;
  apiKey: string;
  apiKeyHeader: string;
  timeoutMs: string;
}

type FormAction =
  | { type: "SET_FIELD"; field: keyof FormState; value: string }
  | { type: "SET_PROTOCOL"; value: Protocol };

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "SET_FIELD":
      return { ...state, [action.field]: action.value };
    case "SET_PROTOCOL":
      return { ...state, protocol: action.value };
    default:
      return state;
  }
}

const INITIAL_STATE: FormState = {
  name: "",
  endpoint: "",
  protocol: "openai",
  model: "",
  apiKey: "",
  apiKeyHeader: "",
  timeoutMs: "30000",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: "",
  connecting: "Connecting…",
  connected: "Connected",
  auth_failed: "Authentication failed",
  unreachable: "Endpoint unreachable",
  invalid_response: "Invalid response",
  timeout: "Timeout",
  model_unavailable: "Model not available",
  error: "Error",
};

export default function ConnectAgentScreen({
  initialConfigId,
  onComplete,
}: Props): React.ReactElement {
  const [form, dispatch] = useReducer(formReducer, INITIAL_STATE);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testStatus, setTestStatus] = useState<ConnectionStatus>("idle");
  const [testMessage, setTestMessage] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [existingId, setExistingId] = useState<string | null>(
    initialConfigId
  );
  const nameRef = useRef<HTMLInputElement>(null);

  // Pre-populate if editing
  useEffect(() => {
    if (!initialConfigId) {
      nameRef.current?.focus();
      return;
    }
    void (async () => {
      const cfg = await window.forgeApi.getConfig(initialConfigId);
      if (!cfg) return;
      dispatch({ type: "SET_FIELD", field: "name", value: cfg.name });
      dispatch({ type: "SET_FIELD", field: "endpoint", value: cfg.endpoint });
      dispatch({ type: "SET_PROTOCOL", value: cfg.protocol });
      dispatch({ type: "SET_FIELD", field: "model", value: cfg.model });
      if (cfg.apiKeyHeader) {
        dispatch({
          type: "SET_FIELD",
          field: "apiKeyHeader",
          value: cfg.apiKeyHeader,
        });
        setShowAdvanced(true);
      }
      if (cfg.timeoutMs) {
        dispatch({
          type: "SET_FIELD",
          field: "timeoutMs",
          value: String(cfg.timeoutMs),
        });
      }
    })();
  }, [initialConfigId]);

  const set = (field: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      dispatch({ type: "SET_FIELD", field, value: e.target.value });

  const isFormValid =
    form.name.trim() !== "" &&
    form.endpoint.trim() !== "" &&
    form.model.trim() !== "" &&
    form.apiKey.trim() !== "";

  const buildConfig = (id: string): AgentConfig => ({
    id,
    name: form.name.trim(),
    endpoint: form.endpoint.trim(),
    protocol: form.protocol,
    model: form.model.trim(),
    ...(form.apiKeyHeader.trim() !== "" && {
      apiKeyHeader: form.apiKeyHeader.trim(),
    }),
    ...(form.timeoutMs.trim() !== "" && {
      timeoutMs: parseInt(form.timeoutMs, 10),
    }),
  });

  const handleTest = async (): Promise<void> => {
    if (!isFormValid) return;
    setIsTesting(true);
    setTestStatus("connecting");
    setTestMessage("Connecting…");
    try {
      const id = existingId ?? randomUUID();
      if (!existingId) setExistingId(id);

      const cfg = buildConfig(id);

      // Store secret before testing (needed in main process)
      await window.forgeApi.saveConfig(cfg);
      await window.forgeApi.setSecret(id, form.apiKey.trim());

      const result = await window.forgeApi.testConnection(cfg);
      setTestStatus(result.status);
      setTestMessage(result.message);
    } catch {
      setTestStatus("error");
      setTestMessage("Connection failed. Check your settings and try again.");
    } finally {
      setIsTesting(false);
    }
  };

  const handleContinue = async (): Promise<void> => {
    if (testStatus !== "connected" || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const id = existingId ?? randomUUID();
      const cfg = buildConfig(id);

      await window.forgeApi.saveConfig(cfg);
      await window.forgeApi.setSecret(id, form.apiKey.trim());

      const newState: AppState = {
        onboardingComplete: true,
        agentConfigId: id,
        defaultAgentProfileId: id,
      };
      await window.forgeApi.setAppState(newState);

      onComplete(newState);
    } catch {
      // IPC error — re-enable button so user can retry
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#0d0d0f]">
      {/* Drag region */}
      <div className="drag-region h-10 w-full flex-shrink-0" />

      {/* Scrollable form area */}
      <div className="no-drag flex flex-1 flex-col items-center overflow-y-auto px-6 pb-10">
        <div className="w-full max-w-md">
          {/* Header */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold text-[#e8e8ec]">
              Connect Agent
            </h2>
            <p className="mt-1 text-sm text-[#7a7a85]">
              Configure your AI-compatible endpoint.
            </p>
          </div>

          {/* Form fields */}
          <div className="space-y-4">
            {/* Agent Name */}
            <Field label="Agent Name">
              <input
                ref={nameRef}
                type="text"
                value={form.name}
                onChange={set("name")}
                placeholder="My Agent"
                className={inputCls}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            {/* Endpoint */}
            <Field label="Endpoint">
              <input
                type="url"
                value={form.endpoint}
                onChange={set("endpoint")}
                placeholder="https://api.example.com"
                className={inputCls}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            {/* Protocol */}
            <Field label="Protocol">
              <SegmentedControl
                options={[
                  { value: "openai", label: "OpenAI Compatible" },
                  { value: "anthropic", label: "Anthropic Compatible" },
                ]}
                value={form.protocol}
                onChange={(v) =>
                  dispatch({ type: "SET_PROTOCOL", value: v as Protocol })
                }
              />
            </Field>

            {/* Model */}
            <Field label="Default Model">
              <input
                type="text"
                value={form.model}
                onChange={set("model")}
                placeholder={
                  form.protocol === "anthropic"
                    ? "claude-sonnet"
                    : "gpt-5"
                }
                className={inputCls}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            {/* API Key */}
            <Field label="API Key">
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={set("apiKey")}
                  placeholder="••••••••••••••••"
                  className={`${inputCls} pr-10`}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#7a7a85] transition-colors hover:text-[#e8e8ec]"
                  tabIndex={-1}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                >
                  {showKey ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </Field>

            {/* Advanced toggle */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-[#7a7a85] transition-colors hover:text-[#e8e8ec]"
              >
                <ChevronIcon open={showAdvanced} />
                Advanced
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-4 rounded-lg border border-[#262629] bg-[#141416] p-4">
                  <Field label="Custom API Key Header" hint="Overrides default header">
                    <input
                      type="text"
                      value={form.apiKeyHeader}
                      onChange={set("apiKeyHeader")}
                      placeholder={
                        form.protocol === "anthropic"
                          ? "x-api-key"
                          : "Authorization"
                      }
                      className={inputCls}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="Timeout (ms)">
                    <input
                      type="number"
                      value={form.timeoutMs}
                      onChange={set("timeoutMs")}
                      placeholder="30000"
                      min={1000}
                      max={120000}
                      className={inputCls}
                    />
                  </Field>
                </div>
              )}
            </div>

            {/* Connection status */}
            {testStatus !== "idle" && (
              <ConnectionStatusBadge
                status={testStatus}
                message={testMessage}
                isLoading={isTesting}
              />
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={!isFormValid || isTesting}
                className="flex h-10 flex-1 items-center justify-center rounded-lg border border-[#262629] bg-[#141416] text-sm font-medium text-[#e8e8ec] transition-colors hover:border-[#3a3a42] hover:bg-[#1a1a1e] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isTesting ? (
                  <span className="flex items-center gap-2">
                    <Spinner />
                    Connecting…
                  </span>
                ) : (
                  "Test Connection"
                )}
              </button>

              <button
                type="button"
                onClick={() => void handleContinue()}
                disabled={testStatus !== "connected" || isSubmitting}
                className="flex h-10 flex-1 items-center justify-center rounded-lg bg-[#6366f1] text-sm font-medium text-white transition-colors hover:bg-[#7578f3] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isSubmitting ? (
                  <span className="flex items-center gap-2">
                    <Spinner />
                    Saving…
                  </span>
                ) : (
                  "Continue"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-lg border border-[#262629] bg-[#141416] px-3 py-2.5 text-sm text-[#e8e8ec] placeholder-[#3a3a42] transition-colors focus:border-[#6366f1] focus:outline-none";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <label className="text-xs font-medium text-[#7a7a85]">{label}</label>
        {hint && (
          <span className="text-[10px] text-[#3a3a42]">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="flex rounded-lg border border-[#262629] bg-[#141416] p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 rounded-md py-2 text-xs font-medium transition-colors ${
            value === opt.value
              ? "bg-[#6366f1] text-white shadow-sm"
              : "text-[#7a7a85] hover:text-[#e8e8ec]"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ConnectionStatusBadge({
  status,
  message,
  isLoading,
}: {
  status: ConnectionStatus;
  message: string;
  isLoading: boolean;
}): React.ReactElement {
  const isOk = status === "connected";
  const isErr =
    status !== "connected" &&
    status !== "idle" &&
    status !== "connecting";

  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${
        isLoading
          ? "border-[#262629] bg-[#141416] text-[#7a7a85]"
          : isOk
          ? "border-[#34d399]/20 bg-[#34d399]/5 text-[#34d399]"
          : isErr
          ? "border-[#f87171]/20 bg-[#f87171]/5 text-[#f87171]"
          : "border-[#262629] bg-[#141416] text-[#7a7a85]"
      }`}
    >
      <span className="mt-0.5 flex-shrink-0">
        {isLoading ? (
          <Spinner />
        ) : isOk ? (
          <DotIcon color="#34d399" />
        ) : isErr ? (
          <DotIcon color="#f87171" />
        ) : (
          <DotIcon color="#7a7a85" />
        )}
      </span>
      <span>
        <span className="font-medium">
          {STATUS_LABEL[status]}
        </span>
        {message && !isLoading && (
          <span className="ml-1 opacity-70">{message}</span>
        )}
      </span>
    </div>
  );
}

function Spinner(): React.ReactElement {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

function DotIcon({ color }: { color: string }): React.ReactElement {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
      <circle cx="4" cy="4" r="3" fill={color} />
    </svg>
  );
}

function EyeIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}