import https from "https";
import http from "http";
import { URL } from "url";
import type { AgentConfig, ConnectionTestResult } from "../../shared/types.js";

type SimpleMessage = { role: "user" | "assistant"; content: string };

function apiKeyHeader(cfg: AgentConfig): Record<string, string> {
  const headerName =
    cfg.apiKeyHeader?.trim() ||
    (cfg.protocol === "anthropic" ? "x-api-key" : "Authorization");

  if (cfg.protocol === "anthropic" && !cfg.apiKeyHeader) {
    return { [headerName]: "<SECRET>" };
  }
  if (cfg.protocol === "openai" && !cfg.apiKeyHeader) {
    return { [headerName]: "Bearer <SECRET>" };
  }
  return { [headerName]: "<SECRET>" };
}

/** Replace <SECRET> placeholder with the real key — only done inside main process */
function resolveHeaders(
  cfg: AgentConfig,
  apiKey: string
): Record<string, string> {
  const headers = apiKeyHeader(cfg);
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    resolved[k] = v.replace("<SECRET>", apiKey);
  }
  return resolved;
}

function buildOpenAIBody(
  messages: SimpleMessage[],
  model: string,
  stream: boolean
): string {
  return JSON.stringify({ model, messages, stream, max_tokens: 4096 });
}

function buildAnthropicBody(
  messages: SimpleMessage[],
  model: string,
  stream: boolean
): string {
  return JSON.stringify({
    model,
    messages,
    max_tokens: 4096,
    stream,
  });
}

interface RequestOptions {
  cfg: AgentConfig;
  apiKey: string;
  messages: SimpleMessage[];
  stream: boolean;
  onChunk?: (text: string) => void;
  signal?: { aborted: boolean };
}

function getEndpointUrl(cfg: AgentConfig): string {
  const base = cfg.endpoint.replace(/\/$/, "");
  if (cfg.protocol === "openai") {
    return base.endsWith("/chat/completions")
      ? base
      : `${base}/v1/chat/completions`;
  }
  // anthropic
  return base.endsWith("/messages") ? base : `${base}/v1/messages`;
}

export function makeRequest(opts: RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const { cfg, apiKey, messages, stream, onChunk, signal } = opts;
    const urlStr = getEndpointUrl(cfg);

    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error("Invalid endpoint URL"));
      return;
    }

    const body =
      cfg.protocol === "openai"
        ? buildOpenAIBody(messages, cfg.model, stream)
        : buildAnthropicBody(messages, cfg.model, stream);

    const authHeaders = resolveHeaders(cfg, apiKey);
    const extraHeaders: Record<string, string> =
      cfg.protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {};

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      ...authHeaders,
      ...extraHeaders,
    };

    const reqOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers,
      timeout: cfg.timeoutMs ?? 30000,
    };

    const transport = url.protocol === "https:" ? https : http;
    let fullText = "";

    const req = transport.request(reqOptions, (res) => {
      if (signal?.aborted) {
        req.destroy();
        reject(new Error("cancelled"));
        return;
      }

      const statusCode = res.statusCode ?? 0;

      if (statusCode === 401 || statusCode === 403) {
        req.destroy();
        reject(new Error(`auth_failed:${statusCode}`));
        return;
      }
      if (statusCode === 404) {
        req.destroy();
        reject(new Error("unreachable:404"));
        return;
      }
      if (statusCode === 429) {
        // Rate limited — but the endpoint is reachable and auth worked
        req.destroy();
        reject(new Error("rate_limited"));
        return;
      }
      if (statusCode >= 500) {
        req.destroy();
        reject(new Error(`server_error:${statusCode}`));
        return;
      }
      if (statusCode !== 200) {
        req.destroy();
        reject(new Error(`unexpected_status:${statusCode}`));
        return;
      }

      let buffer = "";

      res.on("data", (chunk: Buffer) => {
        if (signal?.aborted) {
          req.destroy();
          reject(new Error("cancelled"));
          return;
        }

        const raw = chunk.toString("utf8");

        if (!stream) {
          buffer += raw;
          return;
        }

        // SSE parsing
        buffer += raw;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          const jsonStr = trimmed.slice(6);
          try {
            const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
            const text = extractStreamText(parsed, cfg.protocol);
            if (text) {
              fullText += text;
              onChunk?.(text);
            }
          } catch {
            // malformed SSE chunk — skip
          }
        }
      });

      res.on("end", () => {
        if (!stream) {
          try {
            const parsed = JSON.parse(buffer) as Record<string, unknown>;
            const text = extractFullText(parsed, cfg.protocol);
            resolve(text);
          } catch {
            reject(new Error("invalid_response"));
          }
        } else {
          resolve(fullText);
        }
      });

      res.on("error", (err) => reject(err));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
        reject(new Error("unreachable"));
      } else {
        reject(err);
      }
    });

    req.write(body);
    req.end();
  });
}

function extractStreamText(
  parsed: Record<string, unknown>,
  protocol: string
): string {
  if (protocol === "openai") {
    const choices = parsed["choices"];
    if (!Array.isArray(choices) || choices.length === 0) return "";
    const delta = (choices[0] as Record<string, unknown>)["delta"];
    if (typeof delta !== "object" || delta === null) return "";
    const content = (delta as Record<string, unknown>)["content"];
    return typeof content === "string" ? content : "";
  }
  // anthropic streaming
  const type = parsed["type"];
  if (type === "content_block_delta") {
    const delta = parsed["delta"];
    if (typeof delta !== "object" || delta === null) return "";
    const text = (delta as Record<string, unknown>)["text"];
    return typeof text === "string" ? text : "";
  }
  return "";
}

function extractFullText(
  parsed: Record<string, unknown>,
  protocol: string
): string {
  if (protocol === "openai") {
    const choices = parsed["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error("invalid_response");
    }
    const message = (choices[0] as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null) {
      throw new Error("invalid_response");
    }
    const content = (message as Record<string, unknown>)["content"];
    return typeof content === "string" ? content : "";
  }
  // anthropic
  const content = parsed["content"];
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("invalid_response");
  }
  const block = content[0] as Record<string, unknown>;
  const text = block["text"];
  return typeof text === "string" ? text : "";
}

// ── Connection Test ────────────────────────────────────────────────────────

export async function testConnection(
  cfg: AgentConfig,
  apiKey: string
): Promise<ConnectionTestResult> {
  if (!apiKey.trim()) {
    return { status: "auth_failed", message: "API key is required." };
  }

  try {
    new URL(cfg.endpoint);
  } catch {
    return { status: "unreachable", message: "Invalid endpoint URL." };
  }

  if (!cfg.model.trim()) {
    return { status: "model_unavailable", message: "Model name is required." };
  }

  const testMessages: SimpleMessage[] = [
    { role: "user", content: "Say hello in one word." },
  ];

  try {
    const text = await makeRequest({
      cfg,
      apiKey,
      messages: testMessages,
      stream: false,
    });

    if (typeof text === "string" && text.length >= 0) {
      return { status: "connected", message: "Connected successfully." };
    }
    return { status: "invalid_response", message: "Unexpected response format." };
  } catch (err: unknown) {
    return classifyError(err);
  }
}

function classifyError(err: unknown): ConnectionTestResult {
  if (!(err instanceof Error)) {
    return { status: "error", message: "Unknown error occurred." };
  }

  const msg = err.message;

  if (msg === "rate_limited") {
    return {
      status: "connected",
      message: "Rate limited — connection verified.",
    };
  }
  if (msg.startsWith("auth_failed")) {
    return {
      status: "auth_failed",
      message: "Authentication failed. Check your API key.",
    };
  }
  if (msg.startsWith("unreachable") || msg === "unreachable") {
    return {
      status: "unreachable",
      message: "Endpoint unreachable. Check the URL.",
    };
  }
  if (msg === "timeout") {
    return { status: "timeout", message: "Request timed out." };
  }
  if (msg === "invalid_response") {
    return {
      status: "invalid_response",
      message: "Endpoint returned an unexpected response.",
    };
  }
  if (msg.startsWith("server_error")) {
    return {
      status: "error",
      message: `Server error (${msg.split(":")[1] ?? "5xx"}).`,
    };
  }
  if (msg === "cancelled") {
    return { status: "idle", message: "Cancelled." };
  }

  return { status: "error", message: err.message };
}

export { classifyError, type SimpleMessage };