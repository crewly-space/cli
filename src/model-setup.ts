import { green, yellow } from "./ui.ts";

/*
 * Model access for a server, the way the web app's setup does it and in the
 * same words: Crewly Gateway, a provider's API key, or a subscription on this
 * device; then a default model, then proof that it answers. Setup ends on a
 * reply from the model, not on a saved key.
 */

export interface ServerAnswer { status: number; body: Record<string, unknown> }
export type ServerApi = (path: string, init?: { method?: string; body?: unknown }) => Promise<ServerAnswer>;

/** Calls this server as the signed-in owner. Never throws on an HTTP status; callers decide. */
export function serverApi(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ServerApi {
  return async (path, init = {}) => {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { message: text.slice(0, 300) }; }
    return { status: response.status, body };
  };
}

/** The server's own explanation of a failed call, or its status when it gave none. */
export function explain(answer: ServerAnswer, what: string): string {
  const message = answer.body.message ?? answer.body.error;
  return typeof message === "string" && message ? message : `${what} failed (HTTP ${answer.status})`;
}

export interface GatewayStatus {
  state: "not_linked" | "link_pending" | "revoked" | "missing_scope" | "not_offered" | "unavailable" | "ready";
  message: string;
  models: Array<{ id: string; displayName: string }>;
}

export async function gatewayStatus(api: ServerApi): Promise<GatewayStatus | null> {
  const answer = await api("/api/v1/providers/crewly-gateway/status");
  // An older server has no Gateway status to give; it cannot be offered then.
  return answer.status === 200 ? answer.body as unknown as GatewayStatus : null;
}

/** What the Gateway needs from the server's link to Crewly, plus mail, which setup asks for alongside. */
export const LINK_SCOPES = ["inference", "models:read", "mail:send"];

export interface Interaction {
  openUrl(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/**
 * Links this server to a Crewly account, when it is not yet, and returns the
 * Gateway's state afterwards. The person approves in their browser with a
 * short code; this waits for that, up to the code's lifetime.
 */
export async function linkForGateway(api: ServerApi, serverName: string, io: Interaction, options: { noOpen: boolean }): Promise<GatewayStatus | null> {
  let status = await gatewayStatus(api);
  if (!status) return null;
  if (status.state === "revoked") await api("/api/v1/server/crewly", { method: "DELETE" });
  if (status.state === "not_linked" || status.state === "revoked") {
    const started = await api("/api/v1/server/crewly/connect", { method: "POST", body: { name: serverName, scopes: LINK_SCOPES } });
    if (started.status !== 200 && started.status !== 201) throw new Error(explain(started, "Linking to Crewly"));
    status = { ...status, state: "link_pending" };
  }
  if (status.state === "link_pending") {
    const connection = (await api("/api/v1/server/crewly")).body as { link?: { userCode: string; verificationUrl: string; expiresAt: string; interval: number } | null };
    const link = connection.link;
    if (!link) throw new Error("Crewly did not return a link code");
    io.log(`\nApprove this server in your Crewly account with the code ${link.userCode}`);
    io.log(`  ${link.verificationUrl}`);
    if (!options.noOpen) await io.openUrl(link.verificationUrl).catch(() => undefined);
    const deadline = new Date(link.expiresAt).getTime();
    for (;;) {
      await io.sleep(Math.max(1, link.interval) * 1000);
      const polled = await api("/api/v1/server/crewly/connect/poll", { method: "POST" });
      if (polled.status >= 400) throw new Error(explain(polled, "Linking to Crewly"));
      if (polled.body.status === "connected") break;
      if (Date.now() > deadline) throw new Error("The link code expired before it was approved. Run setup again.");
    }
    io.log(`${green("✓")} Server linked to your Crewly account`);
    status = await gatewayStatus(api);
  }
  return status;
}

/** Adds the Gateway as a provider once it is ready; an existing one is kept. */
export async function addGateway(api: ServerApi): Promise<string> {
  const added = await api("/api/v1/providers", { method: "POST", body: { id: "crewly-gateway", kind: "crewly-gateway" } });
  if (added.status !== 201 && added.body.error !== "provider_exists") throw new Error(explain(added, "Adding Crewly Gateway"));
  return "crewly-gateway";
}

export interface ModelChoice { id: string; displayName: string }

export async function listModels(api: ServerApi, providerId: string): Promise<{ models: ModelChoice[]; error?: string }> {
  const answer = await api(`/api/v1/providers/${encodeURIComponent(providerId)}/models`);
  if (answer.status !== 200) return { models: [], error: explain(answer, "Listing models") };
  const list = (Array.isArray(answer.body) ? answer.body : []) as unknown as ModelChoice[];
  return { models: list.filter((model) => typeof model.id === "string") };
}

export async function verifyModel(api: ServerApi, providerId: string, model: string): Promise<{ ok: true; latencyMs: number } | { ok: false; message: string }> {
  const answer = await api(`/api/v1/providers/${encodeURIComponent(providerId)}/verify`, { method: "POST", body: { model } });
  if (answer.status === 200 && answer.body.ok === true) return { ok: true, latencyMs: Number(answer.body.latencyMs ?? 0) };
  // A server before 0.1.7 cannot verify; saying so beats a false failure.
  if (answer.status === 404 && answer.body.error !== "provider_not_found") return { ok: false, message: "This server cannot verify models yet; the first agent reply will." };
  return { ok: false, message: explain(answer, "Verifying the model") };
}

/** The web app's first template, so a crew started here looks like one started there. */
export const ASSISTANT = {
  name: "Assistant",
  personality: "Everyday assistant\nBe concise and practical. Ask one clarifying question when a request is ambiguous, otherwise act. Prefer short answers with clear next steps.",
};

/**
 * Gives the default model a home: a first agent that uses it, created only
 * when the server has none, so running setup again changes nothing.
 */
export async function ensureFirstAgent(api: ServerApi, providerId: string, model: string, io: Pick<Interaction, "log">): Promise<void> {
  const agents = await api("/api/v1/agents");
  if (agents.status === 200 && Array.isArray(agents.body) && agents.body.length > 0) {
    io.log(`${green("✓")} Agents already exist; set their model in the app if you want ${model}`);
    return;
  }
  const created = await api("/api/v1/agents", { method: "POST", body: {
    name: ASSISTANT.name, personality: ASSISTANT.personality, avatarMode: "bloop",
    modelPolicy: { defaultProviderId: providerId, defaultModel: model },
  } });
  if (created.status !== 201 && created.status !== 200) {
    io.log(`${yellow("!")} The first agent could not be created: ${explain(created, "Creating an agent")}`);
    return;
  }
  io.log(`${green("✓")} Created the agent ${ASSISTANT.name} on ${model}`);
}
