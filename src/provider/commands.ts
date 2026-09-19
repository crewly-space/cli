import { randomBytes } from "node:crypto";
import * as detect from "../detect.ts";
import { Store } from "../secrets.ts";
import * as state from "../state.ts";
import { select } from "../select.ts";
import { readLineDefault, readSecret } from "../tty.ts";
import { dim, green, mark, Spinner } from "../ui.ts";

const OPTIONS = [
  { kind: "claude-subscription", label: "Claude Subscription", local: true },
  { kind: "anthropic", label: "Anthropic API", local: false },
  { kind: "openai", label: "OpenAI", local: false },
  { kind: "openrouter", label: "OpenRouter", local: false },
  { kind: "gemini", label: "Gemini", local: false },
  { kind: "deepseek", label: "DeepSeek", local: false },
  { kind: "ollama", label: "Ollama", local: true },
  { kind: "openai-compatible", label: "OpenAI-compatible", local: false },
] as const;

export async function command(args: string[]): Promise<void> {
  const [action] = args;
  if (!action) throw new Error("usage: crewly provider add|list|test");
  const config = await state.load();
  switch (action) {
    case "list":
      if (config.providers.length === 0) {
        console.log(`No providers configured. ${dim("Run: crewly provider add")}`);
        return;
      }
      for (const provider of config.providers) {
        console.log(`  ${green("•")} ${provider.label.padEnd(24)} ${dim(provider.kind)}${provider.localOnly ? ` ${dim("· local")}` : ""}`);
      }
      return;
    case "add":
      return add(config);
    case "test":
      return test(config);
    default:
      throw new Error(`unknown provider command "${action}"`);
  }
}

export function has(config: state.Config, kind: string): boolean {
  return config.providers.some((provider) => provider.kind === kind);
}

export function claudeSubscriptionAvailable(): boolean {
  const runtime = detect.all().find((candidate) => candidate.id === "claude-subscription");
  return Boolean(runtime?.installed && runtime.authenticated);
}

export function ollamaAvailable(baseUrl = "http://127.0.0.1:11434"): Promise<boolean> {
  return health(`${baseUrl.replace(/\/+$/, "")}/api/tags`);
}

export function create(kind: string, label: string, extra: Partial<state.Provider>): state.Provider {
  return {
    id: newId("prv"),
    kind,
    label,
    localOnly: false,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

async function add(config: state.Config): Promise<void> {
  const option = await select("\nAdd a provider", OPTIONS.map((entry) => ({
    value: entry,
    label: entry.label,
    hint: entry.local ? "on this device" : "API key",
  })));

  if (option.kind === "claude-subscription") {
    if (!claudeSubscriptionAvailable()) {
      throw new Error("Claude Code authentication was not detected; run claude login first");
    }
    config.providers.push(create(option.kind, option.label, { localOnly: true }));
    await state.save(config);
    console.log(`${green("✓")} Claude Subscription enabled. No API key was requested.`);
    return;
  }
  if (option.kind === "ollama") {
    config.providers.push(create(option.kind, option.label, { localOnly: true }));
    await state.save(config);
    return test(config);
  }

  let baseUrl = "";
  if (option.kind === "openai-compatible") {
    baseUrl = await readLineDefault("API base URL", "http://127.0.0.1:8080/v1");
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      throw new Error("API base URL must use http or https");
    }
  }
  process.stdout.write("API key (input hidden where supported): ");
  const secret = await readSecret();
  console.log();
  if (secret.trim() === "") throw new Error("API key is required");

  const dir = await state.ensureDir();
  const ref = newId("sec");
  await new Store(dir).put(ref, new TextEncoder().encode(secret));
  config.providers.push(
    create(option.kind, option.label, {
      localOnly: true,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      secretRef: ref,
    }),
  );
  await state.save(config);
  console.log(`${green("✓")} Credential encrypted locally`);
  return test(config);
}

async function test(config: state.Config): Promise<void> {
  if (config.providers.length === 0) throw new Error("no providers configured");
  let failed = false;
  for (const provider of config.providers) {
    const spinner = new Spinner(`Testing ${provider.label}`);
    spinner.start();
    let ok = true;
    let detail = "configuration available";
    if (provider.kind === "claude-subscription") {
      ok = claudeSubscriptionAvailable();
      detail = "local Claude authentication";
    }
    if (provider.kind === "ollama") {
      const baseUrl = provider.baseUrl ?? "http://127.0.0.1:11434";
      ok = await ollamaAvailable(baseUrl);
      detail = `Ollama at ${baseUrl.replace(/^https?:\/\//, "")}`;
    }
    if (provider.secretRef) {
      try {
        const secret = await new Store(state.dir()).get(provider.secretRef);
        ({ ok, detail } = await providerHealth(provider, new TextDecoder().decode(secret)));
      } catch {
        ok = false;
        detail = "encrypted credential unavailable";
      }
    }
    spinner.stop();
    console.log(`  ${mark(ok)} ${provider.label.padEnd(24)} ${dim(detail)}`);
    failed ||= !ok;
  }
  if (failed) throw new Error("one or more providers could not be reached");
}

async function providerHealth(
  provider: state.Provider,
  secret: string,
): Promise<{ ok: boolean; detail: string }> {
  let endpoint: string;
  let header = "Authorization";
  let value = `Bearer ${secret}`;
  switch (provider.kind) {
    case "openai":
      endpoint = "https://api.openai.com/v1/models";
      break;
    case "anthropic":
      endpoint = "https://api.anthropic.com/v1/models";
      header = "x-api-key";
      value = secret;
      break;
    case "openrouter":
      endpoint = "https://openrouter.ai/api/v1/auth/key";
      break;
    case "gemini":
      endpoint = "https://generativelanguage.googleapis.com/v1beta/models";
      header = "x-goog-api-key";
      value = secret;
      break;
    case "deepseek":
      endpoint = "https://api.deepseek.com/models";
      break;
    case "openai-compatible":
      endpoint = `${(provider.baseUrl ?? "").replace(/\/+$/, "")}/models`;
      break;
    default:
      return { ok: true, detail: "encrypted credential readable" };
  }
  const headers: Record<string, string> = { [header]: value };
  if (provider.kind === "anthropic") headers["anthropic-version"] = "2023-06-01";
  try {
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return { ok: false, detail: `credential rejected (HTTP ${response.status})` };
    return { ok: true, detail: "credential verified" };
  } catch {
    return { ok: false, detail: "provider unreachable" };
  }
}

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
