import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as daemon from "./daemon.ts";
import * as identity from "./identity.ts";
import { pairDevice } from "./pairing.ts";
import * as localProvider from "./provider/commands.ts";
import * as server from "./server.ts";
import * as service from "./service/index.ts";
import * as state from "./state.ts";
import { select } from "./select.ts";
import { readLine, readLineDefault, readSecret } from "./tty.ts";
import { green, heading, nextCommand, yellow } from "./ui.ts";

type Mode = "server" | "server-app" | "connect";

interface Options {
  yes: boolean;
  noOpen: boolean;
  mode?: Mode;
  host?: string;
  port?: number;
  dataDir?: string;
  url?: string;
  email?: string;
  name?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

const REMOTE_PROVIDERS = ["anthropic", "openai", "openrouter", "deepseek", "openai-compatible"] as const;

export async function init(args: string[], entrypoint = import.meta.path): Promise<void> {
  const options = parseOptions(args);
  const config = await state.load();
  heading("Crewly setup");

  const mode = options.mode ?? (options.yes ? "server-app" : await chooseMode());
  if (mode === "connect") return configureConnection(config, options, entrypoint);

  const host = options.host ?? (options.yes ? "127.0.0.1" : await readLineDefault("Bind address", "127.0.0.1"));
  const port = options.port ?? (options.yes ? 8787 : parsePort(await readLineDefault("Port", "8787")));
  const dataDir = options.dataDir ?? join(state.dir(), "server");
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  config.version = 2;
  config.installMode = mode;
  config.server = { host, port, dataDir };
  config.serverUrl = options.url?.replace(/\/+$/, "") ?? `http://${formatHost(browserHost)}:${port}`;
  await state.save(config);

  console.log(`\n${green("✓")} Mode: ${mode === "server-app" ? "server + web app" : "server only"}`);
  console.log(`${green("✓")} Data: ${dataDir}`);
  await server.start(config);

  const token = await ensureOwner(config.serverUrl, dataDir, options);
  if (token) await configureProvider(config, token, options);

  const deviceIdentity = await identity.loadOrCreate(await state.ensureDir());
  const alreadyPaired = config.paired && config.deviceId === deviceIdentity.deviceId;
  config.deviceId = deviceIdentity.deviceId;
  config.deviceName = options.name ?? hostname();
  await state.save(config);
  const paired = alreadyPaired || await pairDevice(config, deviceIdentity, {
      approvalToken: token ?? undefined,
      noOpen: options.noOpen,
      waitForApproval: token !== null || !options.yes,
    });
  if (alreadyPaired) console.log(`${green("✓")} Device is already paired`);
  if (paired) await startDaemon(entrypoint);

  console.log(`\n${green("✓")} Crewly is ready at ${config.serverUrl}`);
  nextCommand("crewly doctor", "Check the connection, model access, and local runtimes");
  if (mode === "server-app" && !options.noOpen) await server.open(config);
}

async function chooseMode(): Promise<Mode> {
  return await select<Mode>("\nWhat do you want to run here?", [
    { value: "server-app", label: "Server + app", hint: "recommended · opens in your browser" },
    { value: "server", label: "Server only", hint: "API without the web app" },
    { value: "connect", label: "Connect this device", hint: "use an existing server" },
  ]);
}

async function configureConnection(config: state.Config, options: Options, entrypoint: string): Promise<void> {
  if (options.yes && !options.url) throw new Error("--url is required with --mode connect --yes");
  const url = options.url ?? await readLineDefault("Crewly server URL", config.serverUrl);
  validateUrl(url);
  const dir = await state.ensureDir();
  const id = await identity.loadOrCreate(dir);
  config.version = 2;
  config.installMode = "connect";
  config.serverUrl = url.replace(/\/+$/, "");
  config.deviceId = id.deviceId;
  config.deviceName = options.name ?? hostname();
  config.paired = false;
  await state.save(config);
  console.log(`\n${green("✓")} Device identity created: ${config.deviceId}`);
  console.log(`${green("✓")} Server saved: ${config.serverUrl}`);
  const paired = await pairDevice(config, id, {
    noOpen: options.noOpen,
    waitForApproval: !options.yes,
  });
  if (paired) await startDaemon(entrypoint);
}

async function startDaemon(entrypoint: string): Promise<void> {
  if (process.env.CREWLY_NO_SERVICE === "1") {
    await daemon.start(entrypoint);
    return;
  }
  try {
    await service.installCurrent(entrypoint);
    console.log(`${green("✓")} Device daemon installed and started`);
  } catch (error) {
    console.log(`${yellow("!")} Could not register the login service: ${(error as Error).message}`);
    await daemon.start(entrypoint);
  }
}

async function ensureOwner(baseUrl: string, dataDir: string, options: Options): Promise<string | null> {
  const status = await request(baseUrl, "/api/v1/auth/status") as { initialized: boolean; claimRequired?: boolean };
  if (status.initialized) {
    console.log(`${green("✓")} Owner account already exists`);
    return null;
  }
  if (options.yes && (!options.email || !process.env.CREWLY_ADMIN_PASSWORD)) {
    console.log(`${yellow("!")} Create the first owner in the app, or set CREWLY_ADMIN_PASSWORD with --email for unattended setup.`);
    return null;
  }

  heading("Create the first owner account");
  const displayName = options.name ?? await readLineDefault("Display name", hostname());
  const email = options.email ?? await readLine("Email: ");
  const password = process.env.CREWLY_ADMIN_PASSWORD ?? await promptPassword();
  let claimToken: string | undefined;
  if (status.claimRequired) {
    try {
      claimToken = (await readFile(join(dataDir, "claim-token"), "utf8")).trim();
    } catch (error) {
      throw new Error(`could not read the server claim token: ${(error as Error).message}`);
    }
  }
  const result = await request(baseUrl, "/api/v1/auth/setup", {
    method: "POST",
    body: JSON.stringify({ email, displayName, password, ...(claimToken ? { claimToken } : {}) }),
  }) as { token: string };
  console.log(`${green("✓")} Owner account created`);
  return result.token;
}

async function configureProvider(config: state.Config, token: string, options: Options): Promise<void> {
  const baseUrl = config.serverUrl;
  let kind = options.provider;
  if (!kind && options.yes) kind = "later";
  if (!kind) kind = await chooseProvider();
  if (kind === "later") {
    console.log(`${yellow("!")} Model provider skipped; add one from the app when ready.`);
    return;
  }
  if (kind === "crewly" || kind === "account") {
    throw new Error(`${kind === "crewly" ? "Crewly model access" : "Crewly account linking"} is not available until the hosted gateway is deployed`);
  }
  if (kind === "claude-subscription" || kind === "ollama") {
    if (kind === "claude-subscription" && !localProvider.claudeSubscriptionAvailable()) {
      throw new Error("Claude Code sign-in was not detected on this computer");
    }
    const ollamaBaseUrl = kind === "ollama"
      ? (options.baseUrl ?? (options.yes ? "http://127.0.0.1:11434" : await readLineDefault("Ollama URL", "http://127.0.0.1:11434"))).replace(/\/+$/, "")
      : undefined;
    if (kind === "ollama" && !await localProvider.ollamaAvailable(ollamaBaseUrl)) {
      throw new Error(`Ollama was not reachable at ${ollamaBaseUrl}`);
    }
    if (!localProvider.has(config, kind)) {
      config.providers.push(localProvider.create(kind, kind === "claude-subscription" ? "Claude Subscription" : "Ollama", {
        localOnly: true,
        ...(ollamaBaseUrl ? { baseUrl: ollamaBaseUrl } : {}),
      }));
      await state.save(config);
    }
    await request(baseUrl, "/api/v1/providers", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: `${kind}-local`, kind }),
    });
    console.log(`${green("✓")} ${kind === "claude-subscription" ? "Claude Subscription" : "Ollama"} connected through this device`);
    return;
  }
  if (!REMOTE_PROVIDERS.includes(kind as (typeof REMOTE_PROVIDERS)[number])) {
    throw new Error(`unsupported provider "${kind}"`);
  }

  let baseUrlValue = options.baseUrl;
  if (kind === "openai-compatible" && !baseUrlValue) {
    baseUrlValue = await readLineDefault("API base URL", "http://127.0.0.1:8080/v1");
  }
  const apiKey = options.apiKey ?? process.env.CREWLY_PROVIDER_API_KEY ?? await promptApiKey();
  await request(baseUrl, "/api/v1/providers", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: `${kind}-default`,
      kind,
      apiKey,
      ...(baseUrlValue ? { baseUrl: baseUrlValue.replace(/\/+$/, "") } : {}),
    }),
  });
  console.log(`${green("✓")} ${kind} provider connected`);
}

async function chooseProvider(): Promise<string> {
  const available = [] as Array<{ value: string; label: string; hint?: string }>;
  if (localProvider.claudeSubscriptionAvailable()) {
    available.push({ value: "claude-subscription", label: "Claude Subscription", hint: "signed in on this device" });
  }
  if (await localProvider.ollamaAvailable()) {
    available.push({ value: "ollama", label: "Ollama", hint: "running on this device" });
  }
  available.push(
    { value: "anthropic", label: "Anthropic", hint: "API key" },
    { value: "openai", label: "OpenAI", hint: "API key" },
    { value: "openrouter", label: "OpenRouter", hint: "API key" },
    { value: "deepseek", label: "DeepSeek", hint: "API key" },
    { value: "openai-compatible", label: "OpenAI-compatible", hint: "API key + URL" },
    { value: "later", label: "Configure later", hint: "add a provider in the app" },
  );
  return await select("\nHow should agents access AI models?", available, available.length - 1);
}

async function promptPassword(): Promise<string> {
  process.stdout.write("Password (12+ characters): ");
  const password = await readSecret();
  console.log();
  process.stdout.write("Confirm password: ");
  const confirmation = await readSecret();
  console.log();
  if (password !== confirmation) throw new Error("passwords do not match");
  if (password.length < 12) throw new Error("password must contain at least 12 characters");
  return password;
}

async function promptApiKey(): Promise<string> {
  process.stdout.write("API key (hidden): ");
  const key = await readSecret();
  console.log();
  if (!key) throw new Error("API key is required");
  return key;
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  return response.json();
}

function parseOptions(args: string[]): Options {
  const result: Options = { yes: false, noOpen: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--yes" || arg === "-y") { result.yes = true; continue; }
    if (arg === "--no-open") { result.noOpen = true; continue; }
    const equals = arg.indexOf("=");
    const rawName = equals === -1 ? arg : arg.slice(0, equals);
    const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
    if (!value) throw new Error(`${rawName} requires a value`);
    switch (rawName) {
      case "--mode":
        if (!["server", "server-app", "connect"].includes(value)) throw new Error("--mode must be server, server-app, or connect");
        result.mode = value as Mode;
        break;
      case "--host": result.host = value; break;
      case "--port": result.port = parsePort(value); break;
      case "--data-dir": result.dataDir = value; break;
      case "--url": result.url = value; break;
      case "--email": result.email = value; break;
      case "--name": result.name = value; break;
      case "--provider": result.provider = value; break;
      case "--api-key": result.apiKey = value; break;
      case "--base-url": result.baseUrl = value; break;
      default: throw new Error(`unknown init option "${rawName}"`);
    }
  }
  return result;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("port must be between 1 and 65535");
  return port;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function validateUrl(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("server URL must be a valid http or https address"); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    throw new Error("server URL must be a valid http or https address");
  }
}
