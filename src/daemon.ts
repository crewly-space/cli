import { spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as detect from "./detect.ts";
import { handleDeviceRequest } from "./device-operations.ts";
import { isNotFound, writePrivate } from "./fsx.ts";
import * as identity from "./identity.ts";
import { isWindows } from "./paths.ts";
import * as state from "./state.ts";

export async function start(entrypoint: string): Promise<void> {
  const dir = await state.ensureDir();
  const existing = await running(dir);
  if (existing.running) {
    console.log(`agentd is already running (pid ${existing.pid})`);
    return;
  }
  const config = await state.load();
  if (config.deviceId === "") throw new Error("setup is incomplete; run 'opencrew setup' first");
  if (!config.paired) throw new Error("device is not paired; run 'opencrew connect' first");

  const logFd = openSync(join(dir, "agentd.log"), "a", 0o600);
  try {
    // node:child_process, not Bun.spawn: only a detached child outlives this process on Windows.
    const child = spawn(process.execPath, [...selfArgs(entrypoint), "_serve"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error("could not start agentd");
    await writePrivate(join(dir, "agentd.pid"), String(child.pid));
    child.unref();
    console.log(`agentd started (pid ${child.pid})`);
  } finally {
    closeSync(logFd);
  }
}

export async function stop(): Promise<void> {
  const path = join(state.dir(), "agentd.pid");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      console.log("agentd is not running");
      return;
    }
    throw error;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid)) throw new Error("invalid agentd pid file");
  let failure: Error | null = null;
  try {
    process.kill(pid, isWindows ? "SIGKILL" : "SIGINT");
  } catch (error) {
    // A stale pid file is not a failure; the daemon is already gone.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error as Error;
  }
  await unlink(path).catch(() => {});
  if (failure) throw new Error(`stop agentd: ${failure.message}`);
  console.log("agentd stopped");
}

export async function serve(): Promise<void> {
  const dir = await state.ensureDir();
  const pidPath = join(dir, "agentd.pid");
  try {
    await writePrivate(pidPath, String(process.pid));
  } catch (error) {
    throw new Error(`write agentd pid: ${(error as Error).message}`);
  }
  const config = await state.load();
  if (config.deviceId === "") throw new Error("run opencrew setup before starting agentd");
  if (!config.paired) throw new Error("device is not paired; run 'opencrew connect'");
  const deviceIdentity = await identity.loadOrCreate(dir);
  if (deviceIdentity.deviceId !== config.deviceId) throw new Error("configured device identity does not match device key");
  console.log(`${new Date().toISOString()} agentd starting for ${config.deviceId}`);

  let stopping = false;
  let activeSocket: WebSocket | undefined;
  const stop = () => {
    stopping = true;
    activeSocket?.close(1000, "agentd stopping");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let backoffMs = 1_000;
  try {
    while (!stopping) {
      try {
        await connectOnce(config, deviceIdentity, (socket) => { activeSocket = socket; });
        backoffMs = 1_000;
      } catch (error) {
        console.error(`${new Date().toISOString()} connection failed: ${(error as Error).message}`);
      }
      if (!stopping) {
        await Bun.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try { unlinkSync(pidPath); } catch { /* the pid file may already be gone */ }
  }
}

export function websocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/agentd/connect";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function signaturePayload(deviceId: string, timestamp: string, nonce: string): Uint8Array {
  return new TextEncoder().encode(`${deviceId}\n${timestamp}\n${nonce}`);
}

async function connectOnce(
  config: state.Config,
  deviceIdentity: identity.Identity,
  onSocket: (socket: WebSocket) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(websocketUrl(config.serverUrl));
    onSocket(socket);
    let authenticated = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const sendHeartbeat = async () => {
      const latest = await state.load();
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        type: "heartbeat",
        capabilities: {
          providers: latest.providers.map(({ id, kind, label, localOnly }) => ({ id, kind, label, localOnly })),
          workspaces: latest.workspaces.map(({ id, name }) => ({ id, name })),
          runtimes: detect.all().filter((runtime) => runtime.installed).map(({ id, name, authenticated: ready }) => ({ id, name, authenticated: ready })),
        },
      }));
    };

    socket.addEventListener("message", (event) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(String(event.data)) as Record<string, unknown>; }
      catch { socket.close(4002, "invalid server message"); return; }
      if (message.type === "challenge" && typeof message.nonce === "string") {
        const timestamp = new Date().toISOString();
        socket.send(JSON.stringify({
          type: "authenticate",
          deviceId: deviceIdentity.deviceId,
          timestamp,
          nonce: message.nonce,
          signature: deviceIdentity.sign(signaturePayload(deviceIdentity.deviceId, timestamp, message.nonce)),
        }));
        return;
      }
      if (message.type === "authenticated") {
        authenticated = true;
        console.log(`${new Date().toISOString()} connected to ${config.serverUrl}`);
        void sendHeartbeat();
        heartbeat = setInterval(() => void sendHeartbeat(), 30_000);
        return;
      }
      if (authenticated && typeof message.requestId === "string" && typeof message.operation === "string") {
        void state.load().then((latest) => handleDeviceRequest(message, latest)).then((response) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
        }).catch((error) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
            requestId: message.requestId,
            ok: false,
            error: { code: "device_error", message: error instanceof Error ? error.message : "device operation failed" },
          }));
        });
      }
    });
    socket.addEventListener("close", (event) => {
      if (heartbeat) clearInterval(heartbeat);
      if (authenticated || event.code === 1000) resolve();
      else reject(new Error(`server closed connection (${event.code}${event.reason ? `: ${event.reason}` : ""})`));
    });
    socket.addEventListener("error", () => {
      if (!authenticated) reject(new Error(`could not connect to ${config.serverUrl}`));
    });
  });
}

export async function logs(args: string[]): Promise<void> {
  const path = join(state.dir(), "agentd.log");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      console.log("No logs yet.");
      return;
    }
    throw error;
  }
  let lines = raw.replace(/[\r\n]+$/, "").split("\n");
  if (args.length === 0 && lines.length > 200) {
    lines = lines.slice(-200);
    console.log("Showing the latest 200 lines. Use 'opencrew logs --all' for everything.\n");
  }
  console.log(lines.join("\n"));
}

export async function running(dir: string): Promise<{ running: boolean; pid: number }> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "agentd.pid"), "utf8");
  } catch {
    return { running: false, pid: 0 };
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid)) return { running: false, pid: 0 };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return { running: (error as NodeJS.ErrnoException).code === "EPERM", pid };
  }
}

/** Arguments needed to re-enter this program, so a compiled binary and `bun run` both work. */
function selfArgs(entrypoint: string): string[] {
  const exe = process.execPath;
  return exe.endsWith("bun") || exe.endsWith("bun.exe") ? [entrypoint] : [];
}
