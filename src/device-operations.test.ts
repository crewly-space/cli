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

async function withHome(run: (home: string) => Promise<void>) {
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "crewly-home-")));
  const saved = { HOME: process.env.HOME, CREWLY_HOME: process.env.CREWLY_HOME };
  process.env.HOME = home;
  process.env.CREWLY_HOME = join(home, "Library", "crewly");
  try { await run(home); } finally {
    process.env.HOME = saved.HOME;
    if (saved.CREWLY_HOME === undefined) delete process.env.CREWLY_HOME; else process.env.CREWLY_HOME = saved.CREWLY_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

const quietChecks = (onSave: () => void = () => {}) => ({
  claude: () => ({ installed: false, authenticated: false }),
  ollamaAvailable: async () => false,
  save: async () => { onSave(); },
  capabilities: (current: Config) => ({ workspaces: current.workspaces.map(({ id, name }) => ({ id, name })) }),
});

test("adds, renames and removes a workspace for the owner, and reports what it now shares", () => withHome(async (home) => {
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const folder = join(home, "code", "site");
  mkdirSync(folder, { recursive: true });
  const local = { providers: [], workspaces: [] } as unknown as Config;
  let saved = 0;
  const checks = quietChecks(() => { saved += 1; });

  const added = await handleDeviceRequest({ requestId: "a", operation: "workspace.add", payload: { path: "~/code/site", name: "Site" } }, local, checks);
  expect(added.ok).toBe(true);
  const id = local.workspaces[0]!.id;
  expect(local.workspaces[0]!.path).toBe(folder);
  expect(added).toMatchObject({ result: { workspace: { id, name: "Site" }, capabilities: { workspaces: [{ id, name: "Site" }] } } });

  const again = await handleDeviceRequest({ requestId: "b", operation: "workspace.add", payload: { path: folder } }, local, checks);
  expect(again).toMatchObject({ ok: false, error: { code: "workspace_invalid" } });

  // Named by id only: a name or a path from afar finds nothing.
  for (const ref of ["Site", folder]) {
    const byOther = await handleDeviceRequest({ requestId: "n", operation: "workspace.remove", payload: { workspaceId: ref } }, local, checks);
    expect(byOther).toMatchObject({ ok: false, error: { code: "workspace_invalid" } });
  }

  const renamed = await handleDeviceRequest({ requestId: "c", operation: "workspace.update", payload: { workspaceId: id, name: "\u001b]0;pwned\u0007Web\u202Esite" } }, local, checks);
  expect(renamed).toMatchObject({ ok: true, result: { workspace: { id, name: "]0;pwnedWebsite" } } });

  const removed = await handleDeviceRequest({ requestId: "d", operation: "workspace.remove", payload: { workspaceId: id } }, local, checks);
  expect(removed).toMatchObject({ ok: true, result: { workspace: null, capabilities: { workspaces: [] } } });
  expect(saved).toBe(3);
}));

test("shares only project folders inside the home folder from afar", () => withHome(async (home) => {
  const { mkdirSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  for (const sub of [".ssh", "code/.git", "Library/crewly", "Library/Keychains"]) mkdirSync(join(home, sub), { recursive: true });
  const local = { providers: [], workspaces: [] } as unknown as Config;
  const refused = ["/", "/etc", dirname(home), "~", home.toUpperCase(), "~/.ssh", "~/code/.git", "~/library/keychains", "~/Library/crewly", "~/Library"];
  for (const path of refused) {
    const response = await handleDeviceRequest({ requestId: "r", operation: "workspace.add", payload: { path } }, local, quietChecks());
    expect(response.ok, path).toBe(false);
  }
  expect(local.workspaces).toHaveLength(0);
}));

test("does not mistake a differently-cased sibling for the home folder where case matters", () => withHome(async (home) => {
  if (process.platform === "darwin" || process.platform === "win32") return;
  const { mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const twin = home.replace(/[a-z](?=[^/]*$)/, (letter) => letter.toUpperCase());
  if (twin === home) return;
  mkdirSync(join(twin, "code"), { recursive: true });
  try {
    const local = { providers: [], workspaces: [] } as unknown as Config;
    const response = await handleDeviceRequest({ requestId: "t", operation: "workspace.add", payload: { path: join(twin, "code") } }, local, quietChecks());
    expect(response.ok).toBe(false);
  } finally {
    rmSync(twin, { recursive: true, force: true });
  }
}));
