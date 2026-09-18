import { AgentdRequestSchema, ChatRequestSchema, type AgentdRequest, type ChatResponse, type ModelInfo } from "./protocol/index.ts";
import { ClaudeSubscription } from "./provider/claude-subscription.ts";
import type * as state from "./state.ts";

export async function handleDeviceRequest(raw: unknown, config: state.Config): Promise<{ requestId: string; ok: true; result: Record<string, unknown> } | { requestId: string; ok: false; error: { code: string; message: string } }> {
  const parsed = AgentdRequestSchema.safeParse(raw);
  if (!parsed.success) return { requestId: requestIdFrom(raw), ok: false, error: { code: "invalid_request", message: "invalid device request" } };
  try {
    return { requestId: parsed.data.requestId, ok: true, result: await dispatch(parsed.data, config) };
  } catch (error) {
    return { requestId: parsed.data.requestId, ok: false, error: {
      code: error instanceof DeviceOperationError ? error.code : "device_error",
      message: error instanceof Error ? error.message : "device operation failed",
    } };
  }
}

class DeviceOperationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

async function dispatch(request: AgentdRequest, config: state.Config): Promise<Record<string, unknown>> {
  const kind = typeof request.payload.kind === "string" ? request.payload.kind : "";
  const provider = config.providers.find((candidate) => candidate.kind === kind && candidate.localOnly);
  if ((request.operation === "provider.chat" || request.operation === "provider.models") && !provider) {
    throw new DeviceOperationError("provider_unavailable", `${kind || "requested"} provider is not enabled on this device`);
  }
  if (request.operation === "provider.chat") {
    const chat = ChatRequestSchema.parse(request.payload.request);
    if (kind === "claude-subscription") return { response: await chatWithClaude(chat) };
    if (kind === "ollama") return { response: await chatWithOllama(chat, provider?.baseUrl) };
    throw new DeviceOperationError("provider_unavailable", `unsupported local provider ${kind}`);
  }
  if (request.operation === "provider.models") {
    if (kind === "claude-subscription") return { models: [] };
    if (kind === "ollama") return { models: await ollamaModels(request.payload.providerId as string, provider?.baseUrl) };
    throw new DeviceOperationError("provider_unavailable", `unsupported local provider ${kind}`);
  }
  throw new DeviceOperationError("operation_unavailable", `${request.operation} is not implemented by this device version`);
}

async function chatWithClaude(request: ReturnType<typeof ChatRequestSchema.parse>): Promise<ChatResponse> {
  const adapter = new ClaudeSubscription();
  if (!adapter.available()) throw new DeviceOperationError("provider_unavailable", "Claude Code is not installed");
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  let resultText = "";
  let assistantText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const event of adapter.stream({
    requestId: crypto.randomUUID(), model: request.model, system: system || undefined,
    messages: request.messages.filter((message) => message.role !== "system"),
  })) {
    if (event.type === "error") throw event.error ?? new Error("local Claude provider failed");
    if (!event.data) continue;
    const decoded = decodeClaudeEvent(event.data);
    if (decoded.result !== undefined) resultText = decoded.result;
    if (decoded.assistant !== undefined) assistantText = decoded.assistant;
    inputTokens = decoded.inputTokens ?? inputTokens;
    outputTokens = decoded.outputTokens ?? outputTokens;
  }
  const content = resultText || assistantText;
  if (!content) throw new DeviceOperationError("provider_invalid_response", "Claude returned no text");
  return { providerId: request.providerId, model: request.model, content, stopReason: "end_turn", usage: { inputTokens, outputTokens } };
}

export function decodeClaudeEvent(line: string): { result?: string; assistant?: string; inputTokens?: number; outputTokens?: number } {
  let value: Record<string, unknown>;
  try { value = JSON.parse(line) as Record<string, unknown>; } catch { return {}; }
  const usage = value.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : {};
  const result = value.type === "result" && typeof value.result === "string" ? value.result : undefined;
  let assistant: string | undefined;
  if (value.type === "assistant" && value.message && typeof value.message === "object") {
    const content = (value.message as Record<string, unknown>).content;
    if (Array.isArray(content)) assistant = content.map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    }).join("");
  }
  return {
    result, assistant,
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
  };
}

async function chatWithOllama(request: ReturnType<typeof ChatRequestSchema.parse>, configuredBaseUrl?: string): Promise<ChatResponse> {
  const baseUrl = (configuredBaseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: request.model, messages: request.messages, stream: false,
      options: { ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }) } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new DeviceOperationError("provider_unavailable", `Ollama returned HTTP ${response.status}`);
  const body = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
  if (!body.message?.content) throw new DeviceOperationError("provider_invalid_response", "Ollama returned no text");
  return { providerId: request.providerId, model: request.model, content: body.message.content,
    stopReason: body.done_reason === "length" ? "max_tokens" : "end_turn",
    usage: { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 } };
}

async function ollamaModels(providerId: string, configuredBaseUrl?: string): Promise<ModelInfo[]> {
  const baseUrl = (configuredBaseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new DeviceOperationError("provider_unavailable", `Ollama returned HTTP ${response.status}`);
  const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
  return (body.models ?? []).flatMap((model) => {
    const id = model.model ?? model.name;
    return id ? [{ id, providerId, displayName: id, contextWindow: 32_768 }] : [];
  });
}

function requestIdFrom(raw: unknown): string {
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).requestId === "string") {
    return (raw as Record<string, unknown>).requestId as string;
  }
  return "invalid";
}
