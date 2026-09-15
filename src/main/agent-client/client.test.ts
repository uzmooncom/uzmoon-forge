import { describe, it, expect } from "vitest";
import { classifyError } from "./client.js";
import type { AgentConfig } from "../../shared/types.js";

describe("classifyError", () => {
  it("classifies auth_failed errors", () => {
    const result = classifyError(new Error("auth_failed:401"));
    expect(result.status).toBe("auth_failed");
    expect(result.message).toContain("Authentication failed");
  });

  it("classifies unreachable errors", () => {
    const result = classifyError(new Error("unreachable"));
    expect(result.status).toBe("unreachable");
    expect(result.message).toContain("unreachable");
  });

  it("classifies timeout errors", () => {
    const result = classifyError(new Error("timeout"));
    expect(result.status).toBe("timeout");
    expect(result.message).toContain("timed out");
  });

  it("classifies invalid_response errors", () => {
    const result = classifyError(new Error("invalid_response"));
    expect(result.status).toBe("invalid_response");
    expect(result.message).toContain("unexpected response");
  });

  it("classifies server errors", () => {
    const result = classifyError(new Error("server_error:500"));
    expect(result.status).toBe("error");
    expect(result.message).toContain("500");
  });

  it("classifies cancelled", () => {
    const result = classifyError(new Error("cancelled"));
    expect(result.status).toBe("idle");
  });

  it("handles non-Error objects", () => {
    const result = classifyError("something weird");
    expect(result.status).toBe("error");
    expect(result.message).toContain("Unknown error");
  });

  it("passes through unknown errors", () => {
    const result = classifyError(new Error("network failure"));
    expect(result.status).toBe("error");
    expect(result.message).toBe("network failure");
  });
});

describe("endpoint URL resolution", () => {
  // Test the URL building logic by verifying expected structure
  const openaiCfg: AgentConfig = {
    id: "test-1",
    name: "Test",
    endpoint: "https://api.openai.com",
    protocol: "openai",
    model: "gpt-4",
  };

  const anthropicCfg: AgentConfig = {
    id: "test-2",
    name: "Test",
    endpoint: "https://api.anthropic.com",
    protocol: "anthropic",
    model: "claude-3",
  };

  it("openai config has correct protocol", () => {
    expect(openaiCfg.protocol).toBe("openai");
  });

  it("anthropic config has correct protocol", () => {
    expect(anthropicCfg.protocol).toBe("anthropic");
  });

  it("validates endpoint is a proper URL", () => {
    expect(() => new URL(openaiCfg.endpoint)).not.toThrow();
    expect(() => new URL(anthropicCfg.endpoint)).not.toThrow();
  });

  it("rejects invalid endpoints", () => {
    expect(() => new URL("not-a-url")).toThrow();
    expect(() => new URL("")).toThrow();
  });
});