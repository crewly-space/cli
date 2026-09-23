import { expect, test } from "bun:test";
import { handleDeviceRequest, type DeviceChecks } from "./device-operations.ts";
import type { Config } from "./state.ts";

function checks(claude: { installed: boolean; authenticated: boolean }, ollama = false) {
  const saved: Config[] = [];
  const injected: DeviceChecks = {
    claude: () => claude,
    ollamaAvailable: async () => ollama,
    save: async (next) => { saved.push(structuredClone(next)); },
    capabilities: (next) => ({ providers: next.providers.map(({ kind }) => ({ kind })) }),
  };
  return { saved, checks: injected };
}
const enable = (kind: string) => ({ requestId: "req-enable", operation: "provider.enable", payload: { kind } });
const emptyConfig = () => ({ providers: [], workspaces: [] }) as unknown as Config;

test("enables Claude Subscription when Claude Code is signed in, and reports the new capabilities", async () => {
  const { saved, checks: injected } = checks({ installed: true, authenticated: true });
  const response = await handleDeviceRequest(enable("claude-subscription"), emptyConfig(), injected);
  expect(response).toEqual({ requestId: "req-enable", ok: true, result: {
    enabled: true, capabilities: { providers: [{ kind: "claude-subscription" }] },
  } });
  expect(saved).toHaveLength(1);
  expect(saved[0]!.providers[0]).toMatchObject({ kind: "claude-subscription", localOnly: true });
});

test("refuses to enable Claude Subscription it cannot serve, saying why", async () => {
  const missing = await handleDeviceRequest(enable("claude-subscription"), emptyConfig(), checks({ installed: false, authenticated: false }).checks);
  expect(missing).toMatchObject({ ok: false, error: { code: "runtime_missing" } });
  const signedOut = await handleDeviceRequest(enable("claude-subscription"), emptyConfig(), checks({ installed: true, authenticated: false }).checks);
  expect(signedOut).toMatchObject({ ok: false, error: { code: "provider_sign_in_expired" } });
});

test("enables Ollama only when it answers", async () => {
  const down = await handleDeviceRequest(enable("ollama"), emptyConfig(), checks({ installed: false, authenticated: false }, false).checks);
  expect(down).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
  const up = await handleDeviceRequest(enable("ollama"), emptyConfig(), checks({ installed: false, authenticated: false }, true).checks);
  expect(up).toMatchObject({ ok: true, result: { enabled: true } });
});

test("never enables a remote provider on the device", async () => {
  const response = await handleDeviceRequest(enable("openai"), emptyConfig(), checks({ installed: true, authenticated: true }).checks);
  expect(response).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
});

test("does not add a provider twice", async () => {
  const local = emptyConfig();
  const first = checks({ installed: true, authenticated: true });
  await handleDeviceRequest(enable("claude-subscription"), local, first.checks);
  await handleDeviceRequest(enable("claude-subscription"), local, first.checks);
  expect(local.providers).toHaveLength(1);
  expect(first.saved).toHaveLength(1);
});

test("reports a lapsed Claude sign-in on chat as an expired sign-in", async () => {
  const local = { providers: [{ id: "c", kind: "claude-subscription", label: "Claude", localOnly: true }], workspaces: [] } as unknown as Config;
  const response = await handleDeviceRequest({ requestId: "req-chat", operation: "provider.chat", payload: {
    kind: "claude-subscription", providerId: "c",
    request: { providerId: "c", model: "claude", messages: [{ role: "user", content: "hi" }] },
  } }, local, checks({ installed: true, authenticated: false }).checks);
  expect(response).toMatchObject({ ok: false, error: { code: "provider_sign_in_expired" } });
});
