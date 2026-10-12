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

test("adds, renames and removes a workspace for the owner, and reports what it now shares", async () => {
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "crewly-ws-op-")));
  const local = { providers: [], workspaces: [] } as unknown as Config;
  let saved = 0;
  const checks = {
    claude: () => ({ installed: false, authenticated: false }),
    ollamaAvailable: async () => false,
    save: async () => { saved += 1; },
    capabilities: (current: Config) => ({ workspaces: current.workspaces.map(({ id, name }) => ({ id, name })) }),
  };
  try {
    const added = await handleDeviceRequest({ requestId: "a", operation: "workspace.add", payload: { path: folder, name: "Site" } }, local, checks);
    expect(added.ok).toBe(true);
    const id = local.workspaces[0]!.id;
    expect(added).toMatchObject({ result: { workspace: { id, name: "Site" }, capabilities: { workspaces: [{ id, name: "Site" }] } } });

    const again = await handleDeviceRequest({ requestId: "b", operation: "workspace.add", payload: { path: folder } }, local, checks);
    expect(again).toMatchObject({ ok: false, error: { code: "workspace_invalid" } });

    const renamed = await handleDeviceRequest({ requestId: "c", operation: "workspace.update", payload: { workspaceId: id, name: "Website" } }, local, checks);
    expect(renamed).toMatchObject({ ok: true, result: { workspace: { id, name: "Website" } } });

    const removed = await handleDeviceRequest({ requestId: "d", operation: "workspace.remove", payload: { workspaceId: id } }, local, checks);
    expect(removed).toMatchObject({ ok: true, result: { workspace: null, capabilities: { workspaces: [] } } });
    expect(saved).toBe(3);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("refuses to share the whole disk or home folder from afar", async () => {
  const local = { providers: [], workspaces: [] } as unknown as Config;
  for (const path of ["/", "~"]) {
    const response = await handleDeviceRequest({ requestId: "r", operation: "workspace.add", payload: { path } }, local);
    expect(response).toMatchObject({ ok: false, error: { code: "workspace_invalid", message: "Pick a project folder, not the whole disk or home folder" } });
  }
  expect(local.workspaces).toHaveLength(0);
});
