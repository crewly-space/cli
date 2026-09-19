import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNotFound, writePrivate } from "./fsx.ts";
import { isWindows } from "./paths.ts";
import { SERVER_BINARY, install, managedDir } from "./server-install.ts";
import * as state from "./state.ts";
import { dim, green, Spinner } from "./ui.ts";

/** An override, else the release layout beside the CLI, else the copy the CLI downloaded itself. */
export function binaryPath(): string {
  if (process.env.CREWLY_SERVER_BIN) return process.env.CREWLY_SERVER_BIN;
  const sibling = join(dirname(process.execPath), SERVER_BINARY);
  return existsSync(sibling) ? sibling : join(managedDir(), SERVER_BINARY);
}

export function webPath(): string {
  if (process.env.CREWLY_WEB_DIR) return process.env.CREWLY_WEB_DIR;
  const sibling = join(dirname(process.execPath), "web");
  return existsSync(join(sibling, "index.html")) ? sibling : join(managedDir(), "web");
}

/** Only fetch what the user did not point us at: an override that is missing is their mistake to see. */
function needsDownload(wantsApp: boolean): boolean {
  const missingBinary = !process.env.CREWLY_SERVER_BIN && !existsSync(binaryPath());
  const missingApp = wantsApp && !process.env.CREWLY_WEB_DIR && !existsSync(join(webPath(), "index.html"));
  return missingBinary || missingApp;
}

export async function start(input?: state.Config): Promise<void> {
  const config = input ?? await state.load();
  if (config.installMode !== "server" && config.installMode !== "server-app") {
    throw new Error("this device is not configured to host a server; run 'crewly init'");
  }
  const current = await running();
  if (current.running) {
    console.log(`${green("Crewly server is already running")} (pid ${current.pid})`);
    return;
  }
  if (needsDownload(config.installMode === "server-app")) {
    const download = new Spinner("Downloading the Crewly server");
    download.start();
    try {
      await install();
      download.succeed("Crewly server downloaded");
    } catch (error) {
      download.stop();
      throw error;
    }
  }
  const executable = binaryPath();
  if (!existsSync(executable)) {
    throw new Error(`server binary not found at ${executable}; reinstall Crewly`);
  }
  const args = [
    "--host", config.server.host,
    "--port", String(config.server.port),
    "--data-dir", config.server.dataDir,
  ];
  if (config.installMode === "server-app") {
    const webDir = webPath();
    if (!existsSync(join(webDir, "index.html"))) {
      throw new Error(`app files not found at ${webDir}; reinstall Crewly or choose server-only mode`);
    }
    args.push("--web-dir", webDir);
  }

  const dir = await state.ensureDir();
  const logFd = openSync(join(dir, "server.log"), "a", 0o600);
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error("could not start Crewly server");
    await writePrivate(join(dir, "server.pid"), String(child.pid));
    child.unref();
    const ready = new Spinner("Starting the Crewly server");
    ready.start();
    try {
      await waitUntilReady(config.serverUrl, child.pid);
      ready.succeed(`Crewly server started (pid ${child.pid})`);
    } catch (error) {
      ready.stop();
      throw error;
    }
  } finally {
    closeSync(logFd);
  }
}

export async function stop(): Promise<void> {
  const path = join(state.dir(), "server.pid");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      console.log(dim("Crewly server is not running"));
      return;
    }
    throw error;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid)) throw new Error("invalid server pid file");
  try {
    process.kill(pid, isWindows ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await unlink(path).catch(() => {});
  console.log(green("Crewly server stopped"));
}

export async function restart(): Promise<void> {
  await stop();
  await start();
}

export async function running(): Promise<{ running: boolean; pid: number }> {
  let raw: string;
  try {
    raw = await readFile(join(state.dir(), "server.pid"), "utf8");
  } catch {
    return { running: false, pid: 0 };
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid)) return { running: false, pid: 0 };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (error) {
    return { running: (error as NodeJS.ErrnoException).code === "EPERM", pid };
  }
}

export async function logs(all = false): Promise<void> {
  const path = join(state.dir(), "server.log");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      console.log(dim("No server logs yet."));
      return;
    }
    throw error;
  }
  let lines = raw.replace(/[\r\n]+$/, "").split("\n");
  if (!all && lines.length > 200) lines = lines.slice(-200);
  console.log(lines.join("\n"));
}

export async function open(input?: state.Config): Promise<void> {
  const config = input ?? await state.load();
  await openUrl(config.serverUrl);
}

export async function openUrl(url: string): Promise<void> {
  const command = process.platform === "win32"
    ? ["cmd.exe", "/c", "start", "", url]
    : process.platform === "darwin"
      ? ["open", url]
      : ["xdg-open", url];
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0) console.log(`Open ${url} in your browser.`);
}

async function waitUntilReady(baseUrl: string, pid: number): Promise<void> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/readyz`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch {
      // Server may still be opening SQLite or applying first-run migrations.
    }
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(`server exited before becoming ready; run 'crewly server logs'`);
    }
    await Bun.sleep(250);
  }
  throw new Error(`server did not become ready at ${endpoint}; run 'crewly server logs'`);
}
