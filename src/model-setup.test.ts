import { afterEach, expect, test } from "bun:test";
import { ensureFirstAgent, linkForGateway, listModels, serverApi, verifyModel } from "./model-setup.ts";

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

/** A fake Crewly server; `routes` answers by "METHOD /path". */
function fakeServer(routes: Record<string, (body: unknown) => Response>) {
  const calls: Array<{ route: string; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      expect(request.headers.get("authorization")).toBe("Bearer owner-token");
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      calls.push({ route, body });
      return routes[route]?.(body) ?? new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    },
  });
  stop = () => server.stop(true);
  return { api: serverApi(`http://127.0.0.1:${server.port}`, "owner-token"), calls };
}

const quiet = { openUrl: async () => {}, sleep: async () => {}, log: () => {} };

test("links an unlinked server to Crewly, waits for approval, and reports the Gateway ready", async () => {
  let linked = false;
  let polls = 0;
  const { api, calls } = fakeServer({
    "GET /api/v1/providers/crewly-gateway/status": () => Response.json(linked
      ? { state: "ready", message: "ready", models: [{ id: "managed-small", displayName: "Managed Small" }] }
      : { state: "not_linked", message: "link it", models: [] }),
    "POST /api/v1/server/crewly/connect": () => Response.json({ status: "pending" }, { status: 201 }),
    "GET /api/v1/server/crewly": () => Response.json({ status: "pending", link: { userCode: "BCDF-GHJK", verificationUrl: "https://crewly.test/connect", expiresAt: new Date(Date.now() + 60_000).toISOString(), interval: 1 } }),
    "POST /api/v1/server/crewly/connect/poll": () => {
      polls += 1;
      if (polls === 2) linked = true;
      return Response.json({ status: linked ? "connected" : "pending" });
    },
  });
  const opened: string[] = [];
  const status = await linkForGateway(api, "Crewly on laptop", { ...quiet, openUrl: async (url) => { opened.push(url); } }, { noOpen: false });
  expect(status?.state).toBe("ready");
  expect(opened).toEqual(["https://crewly.test/connect"]);
  expect(calls.find((call) => call.route === "POST /api/v1/server/crewly/connect")?.body).toEqual({ name: "Crewly on laptop", scopes: ["inference", "models:read", "mail:send"] });
});

test("leaves a linked server without the Gateway grant to its message, without relinking", async () => {
  const { api, calls } = fakeServer({
    "GET /api/v1/providers/crewly-gateway/status": () => Response.json({ state: "missing_scope", message: "Grant it AI Gateway", models: [] }),
  });
  expect((await linkForGateway(api, "x", quiet, { noOpen: true }))?.message).toBe("Grant it AI Gateway");
  expect(calls.map((call) => call.route)).toEqual(["GET /api/v1/providers/crewly-gateway/status"]);
});

test("verifies a model, and passes on the server's reason when it does not answer", async () => {
  let answer = true;
  const { api } = fakeServer({
    "POST /api/v1/providers/openai-default/verify": () => answer
      ? Response.json({ ok: true, model: "gpt-x", reply: "ready", latencyMs: 420 })
      : Response.json({ ok: false, error: "provider_auth_failed", message: "The provider rejected its API key." }, { status: 502 }),
  });
  expect(await verifyModel(api, "openai-default", "gpt-x")).toEqual({ ok: true, latencyMs: 420 });
  answer = false;
  expect(await verifyModel(api, "openai-default", "gpt-x")).toEqual({ ok: false, message: "The provider rejected its API key." });
});

test("lists models and creates the first agent on the default model only when there is none", async () => {
  let agents: unknown[] = [];
  const { api, calls } = fakeServer({
    "GET /api/v1/providers/openai-default/models": () => Response.json([{ id: "gpt-x", displayName: "GPT X" }]),
    "GET /api/v1/agents": () => Response.json(agents),
    "POST /api/v1/agents": () => Response.json({ id: "agent-1" }, { status: 201 }),
  });
  expect((await listModels(api, "openai-default")).models).toEqual([{ id: "gpt-x", displayName: "GPT X" }]);
  await ensureFirstAgent(api, "openai-default", "gpt-x", quiet);
  const created = calls.find((call) => call.route === "POST /api/v1/agents")?.body as { name: string; modelPolicy: unknown };
  expect(created.name).toBe("Assistant");
  expect(created.modelPolicy).toEqual({ defaultProviderId: "openai-default", defaultModel: "gpt-x" });

  agents = [{ id: "agent-1" }];
  await ensureFirstAgent(api, "openai-default", "gpt-x", quiet);
  expect(calls.filter((call) => call.route === "POST /api/v1/agents")).toHaveLength(1);
});
