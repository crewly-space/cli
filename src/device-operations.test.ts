import { expect, test } from "bun:test";
import { decodeClaudeEvent, handleDeviceRequest } from "./device-operations.ts";
import type { Config } from "./state.ts";

const config = { providers: [], workspaces: [] } as unknown as Config;

test("rejects provider requests that were not enabled locally", async () => {
  const response = await handleDeviceRequest({ requestId: "req-1", operation: "provider.models", payload: { kind: "ollama", providerId: "local" } }, config);
  expect(response).toEqual({ requestId: "req-1", ok: false, error: { code: "provider_unavailable", message: "ollama provider is not enabled on this device" } });
});

test("extracts final text and usage from Claude stream-json results", () => {
  expect(decodeClaudeEvent(JSON.stringify({ type: "result", result: "Hello", usage: { input_tokens: 4, output_tokens: 2 } })))
    .toEqual({ result: "Hello", assistant: undefined, inputTokens: 4, outputTokens: 2 });
  expect(decodeClaudeEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } })))
    .toEqual({ result: undefined, assistant: "Hi", inputTokens: undefined, outputTokens: undefined });
});

test("lists Ollama models and completes a chat through the local endpoint", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "qwen-test" }] });
      if (url.pathname === "/api/chat") {
        const body = await request.json() as { messages: Array<{ content: string }> };
        return Response.json({
          message: { content: `Local: ${body.messages.at(-1)?.content ?? ""}` },
          prompt_eval_count: 5,
          eval_count: 2,
          done_reason: "stop",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const localConfig = {
    providers: [{ id: "ollama-device", kind: "ollama", label: "Ollama", localOnly: true, baseUrl: `http://127.0.0.1:${server.port}` }],
    workspaces: [],
  } as unknown as Config;
  try {
    const models = await handleDeviceRequest({ requestId: "models-1", operation: "provider.models", payload: { kind: "ollama", providerId: "ollama-local" } }, localConfig);
    expect(models).toEqual({ requestId: "models-1", ok: true, result: { models: [{ id: "qwen-test", providerId: "ollama-local", displayName: "qwen-test", contextWindow: 32768 }] } });

    const chat = await handleDeviceRequest({ requestId: "chat-1", operation: "provider.chat", payload: {
      kind: "ollama", providerId: "ollama-local", request: {
        providerId: "ollama-local", model: "qwen-test", messages: [{ role: "user", content: "hello" }],
      },
    } }, localConfig);
    expect(chat).toEqual({ requestId: "chat-1", ok: true, result: { response: {
      providerId: "ollama-local", model: "qwen-test", content: "Local: hello", stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 2 },
    } } });
  } finally {
    server.stop(true);
  }
});
