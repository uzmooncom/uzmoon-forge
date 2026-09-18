/**
 * V17 — Fake Provider
 *
 * Deterministic LLM response engine for Playwright e2e tests.
 * Activated when FORGE_TEST_PROVIDER=fake is set in the environment.
 *
 * Response routing:
 *  - Messages containing "__fail__" → throw provider error
 *  - Messages containing "__slow__" → delay 2s then respond
 *  - Messages containing "__tool__" → emit a read_file forge_tool call, then forge_final
 *  - Messages containing "__human__" → emit a forge_final with status="blocked" (waiting_for_human)
 *  - All other messages → echo a forge_final response immediately
 */

// Minimal shape matching RequestOptions in client.ts (not exported from client)
export interface FakeRequestOpts {
  messages: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
  [key: string]: unknown;
}

export const FAKE_PROVIDER_ENV = "FORGE_TEST_PROVIDER";

export function isFakeProviderEnabled(): boolean {
  return process.env[FAKE_PROVIDER_ENV] === "fake";
}

function extractLastUserText(opts: FakeRequestOpts): string {
  const messages = opts.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        const textBlock = m.content.find((b: { type?: string; text?: string }) => b.type === "text");
        if (textBlock && typeof textBlock.text === "string") return textBlock.text;
      }
    }
  }
  return "";
}

function makeForgeFinal(content: string): string {
  const payload = JSON.stringify({ content });
  return `\`\`\`forge_final\n${payload}\n\`\`\``;
}

function makeForgeFinalBlocked(reason: string): string {
  const inner = JSON.stringify({ status: "blocked", summary: reason, evidenceRefs: [] });
  const payload = JSON.stringify({ content: inner });
  return `\`\`\`forge_final\n${payload}\n\`\`\``;
}

function makeForgeToolRead(filePath: string): string {
  const toolCallJson = JSON.stringify({
    callId: "fake-call-001",
    name: "read_file",
    arguments: { path: filePath },
  });
  return `\`\`\`forge_tool\n${toolCallJson}\n\`\`\``;
}

export async function fakeRequest(opts: FakeRequestOpts): Promise<string> {
  const userText = extractLastUserText(opts).toLowerCase();

  if (userText.includes("__fail__")) {
    throw new Error("FAKE_PROVIDER: simulated provider failure");
  }

  if (userText.includes("__slow__")) {
    await new Promise((r) => setTimeout(r, 2000));
    return makeForgeFinal("Slow response complete.");
  }

  if (userText.includes("__tool__")) {
    // Simulate one tool step, then a final answer
    // The agent-loop handles multi-turn; here we emit a tool call.
    // In a real multi-turn scenario the loop re-invokes us; simulate by
    // checking for a prior tool result in the messages.
    const hasPriorToolResult = opts.messages.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("forge_tool_result"),
    );
    if (hasPriorToolResult) {
      return makeForgeFinal("Tool call processed. Here is the file content summary.");
    }
    return makeForgeToolRead("/tmp/fake-test-file.txt");
  }

  if (userText.includes("__human__")) {
    return makeForgeFinalBlocked("This step requires human completion (simulated).");
  }

  // Default: echo
  const echo = `Fake provider response to: "${userText.slice(0, 80)}"`;
  return makeForgeFinal(echo);
}