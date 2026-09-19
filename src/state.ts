import { hostname } from "node:os";
import { readFile, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ensureDirPrivate, isNotFound, writePrivate } from "./fsx.ts";
import { userConfigDir } from "./paths.ts";

export type Permission = "allow" | "ask" | "deny";

export interface Workspace {
  id: string;
  name: string;
  path: string;
  permissions: Record<string, Permission>;
  addedAt: string;
}

export interface Provider {
  id: string;
  kind: string;
  label: string;
  baseUrl?: string;
  secretRef?: string;
  localOnly: boolean;
  createdAt: string;
}

export interface Session {
  id: string;
  agentId: string;
  conversationId: string;
  runtime: string;
  workspaceId?: string;
  externalId?: string;
  updatedAt: string;
}

export interface Config {
  version: number;
  serverUrl: string;
  installMode: "unconfigured" | "server" | "server-app" | "connect";
  server: {
    host: string;
    port: number;
    dataDir: string;
  };
  deviceId: string;
  deviceName: string;
  paired: boolean;
  workspaces: Workspace[];
  providers: Provider[];
  sessions: Session[];
  initializedAt: string;
}

export function dir(): string {
  const override = process.env.CREWLY_HOME;
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(userConfigDir(), "crewly");
}

export async function ensureDir(): Promise<string> {
  const target = dir();
  await ensureDirPrivate(target);
  return target;
}

function emptyConfig(): Config {
  return {
    version: 2,
    serverUrl: "http://127.0.0.1:8787",
    installMode: "unconfigured",
    server: {
      host: "127.0.0.1",
      port: 8787,
      dataDir: join(dir(), "server"),
    },
    deviceId: "",
    deviceName: hostname(),
    paired: false,
    workspaces: [],
    providers: [],
    sessions: [],
    initializedAt: new Date().toISOString(),
  };
}

export async function load(): Promise<Config> {
  const target = await ensureDir();
  let raw: string;
  try {
    raw = await readFile(join(target, "config.json"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return emptyConfig();
    throw new Error(`read config: ${(error as Error).message}`);
  }
  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(raw) as Partial<Config>;
  } catch (error) {
    throw new Error(`decode config: ${(error as Error).message}`);
  }
  // The Go build encoded empty slices as null, so normalise them before anything reads .length.
  return {
    ...emptyConfig(),
    ...parsed,
    server: {
      ...emptyConfig().server,
      ...(parsed.server ?? {}),
    },
    workspaces: parsed.workspaces ?? [],
    providers: parsed.providers ?? [],
    sessions: parsed.sessions ?? [],
  };
}

export async function save(config: Config): Promise<void> {
  const target = await ensureDir();
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const tmp = join(target, "config.json.tmp");
  await writePrivate(tmp, payload);
  await rename(tmp, join(target, "config.json"));
}

export function defaultPermissions(): Record<string, Permission> {
  return {
    "workspace.read": "allow",
    "workspace.write": "ask",
    "shell.run": "ask",
    "network.access": "ask",
    "git.commit": "ask",
    "git.push": "deny",
    "mcp.use": "ask",
  };
}
