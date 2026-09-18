#!/usr/bin/env bun
import * as configTransfer from "./config-transfer.ts";
import * as daemon from "./daemon.ts";
import * as detect from "./detect.ts";
import * as identity from "./identity.ts";
import { init } from "./onboarding.ts";
import { pairDevice } from "./pairing.ts";
import { isWindows } from "./paths.ts";
import * as provider from "./provider/commands.ts";
import * as runtimeInstall from "./runtime-install.ts";
import * as service from "./service/index.ts";
import * as server from "./server.ts";
import * as state from "./state.ts";
import { close as closeStdin, readLine, readLineDefault } from "./tty.ts";
import * as workspace from "./workspace-command.ts";

const VERSION = "0.1.0-dev";

/** Signals that the command already printed a useful explanation. */
class AlreadyReported extends Error {}

async function main(): Promise<void> {
  try {
    await run(process.argv.slice(2));
    closeStdin();
  } catch (error) {
    if (!(error instanceof AlreadyReported)) {
      console.error("Error:", error instanceof Error ? error.message : error);
    }
    process.exit(1);
  }
}

async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
      return dashboard();
    case "init":
      return init(rest, import.meta.path);
    case "setup":
      return init(rest, import.meta.path);
    case "connect":
      return connect(rest);
    case "status":
      return status();
    case "start":
      return daemon.start(import.meta.path);
    case "stop":
      return daemon.stop();
    case "restart":
      await daemon.stop();
      return daemon.start(import.meta.path);
    case "up":
      await server.start();
      if ((await state.load()).installMode === "server-app") await server.open();
      return;
    case "down":
      return server.stop();
    case "open":
      return server.open();
    case "server":
      return serverCommand(rest);
    case "update":
      return update();
    case "doctor":
      return doctor();
    case "logs":
      return daemon.logs(rest);
    case "backup":
      return configTransfer.backup(rest);
    case "restore":
      return configTransfer.restore(rest);
    case "provider":
      return provider.command(rest);
    case "workspace":
      return workspace.command(rest);
    case "agentd":
      return agentdCommand(rest);
    case "runtime":
      return runtimeCommand(rest);
    case "_serve":
      return daemon.serve();
    case "version":
    case "--version":
    case "-v":
      console.log("opencrew", VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      return help();
    default:
      throw new Error(`unknown command "${command}"; run opencrew help`);
  }
}

async function dashboard(): Promise<void> {
  const config = await state.load();
  process.stdout.write("\x1b[2J\x1b[H");
  console.log("  OpenCrew");
  console.log("  Your agents, on your terms.\n");
  if (config.installMode === "unconfigured") {
    console.log("  Setup is ready. Press Enter to begin, or q to quit.");
    const choice = await readLine("");
    if (choice.toLowerCase() === "q") return;
    return init([]);
  }
  console.log(`  Device     ${config.deviceName}`);
  console.log(`  Pairing    ${config.paired ? "Connected" : "Not paired"}`);
  console.log(`  Providers  ${config.providers.length}`);
  console.log(`  Workspaces ${config.workspaces.length}\n`);
  for (const runtime of detect.all()) {
    console.log(`  ${runtime.name.padEnd(20)} ${runtime.detail}`);
  }
  console.log("\n  init · up · status · provider · workspace · doctor · logs");
}

async function connect(args: string[]): Promise<void> {
  // Without this an unknown flag is taken as the server URL, and the failure
  // shows up as "server URL must be a valid http or https address".
  const flag = args.find((arg) => arg.startsWith("-"));
  if (flag) throw new Error(`unknown option "${flag}"; usage: opencrew connect [server-url]`);
  if (args.length > 1) throw new Error("usage: opencrew connect [server-url]");
  const config = await state.load();
  if (args[0]) config.serverUrl = args[0].replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(config.serverUrl);
  } catch {
    throw new Error("server URL must be a valid http or https address");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("server URL must be a valid http or https address");
  }
  const deviceIdentity = await identity.loadOrCreate(await state.ensureDir());
  config.version = 2;
  if (config.installMode === "unconfigured") config.installMode = "connect";
  config.deviceId = deviceIdentity.deviceId;
  config.paired = false;
  await state.save(config);
  if (await pairDevice(config, deviceIdentity)) await daemon.start(import.meta.path);
}

async function setup(): Promise<void> {
  const dir = await state.ensureDir();
  const config = await state.load();
  const id = await identity.loadOrCreate(dir);
  config.deviceId = id.deviceId;

  console.log("\nOpenCrew setup\n──────────────");
  const name = (await readLineDefault("Device name", config.deviceName)).trim();
  const server = (await readLineDefault("OpenCrew URL", config.serverUrl)).trim().replace(/\/+$/, "");
  if (name === "") throw new Error("device name cannot be empty");
  let parsed: URL;
  try {
    parsed = new URL(server);
  } catch {
    throw new Error("OpenCrew URL must be a valid http or https address");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.host === "") {
    throw new Error("OpenCrew URL must be a valid http or https address");
  }
  config.deviceName = name;
  config.serverUrl = server;

  console.log("\nLocal runtimes");
  for (const runtime of detect.all()) {
    const ready = runtime.installed && (!runtime.provider || runtime.authenticated);
    console.log(`  ${mark(ready)}  ${runtime.name} — ${runtime.detail}`);
  }
  if (provider.claudeSubscriptionAvailable() && !provider.has(config, "claude-subscription")) {
    const answer = await readLine("\nUse your detected Claude subscription? [Y/n] ");
    if (answer === "" || answer.toLowerCase() === "y") {
      config.providers.push(
        provider.create("claude-subscription", "Claude Subscription", { localOnly: true }),
      );
    }
  }
  await state.save(config);
  console.log(`\n✓ Device identity created: ${config.deviceId}`);
  console.log("✓ Credentials and runtime access stay on this device");
  if (config.providers.length === 0) console.log("\nNext: opencrew provider add");
  else if (config.workspaces.length === 0) console.log("\nNext: opencrew workspace add");
  else console.log("\nReady: opencrew agentd install");
}

async function status(): Promise<void> {
  const config = await state.load();
  const { running, pid } = await daemon.running(state.dir());
  const serverState = await server.running();
  console.log(`OpenCrew ${VERSION} (${detect.platform()})`);
  console.log(`Mode: ${config.installMode}`);
  console.log(`Server: ${serverState.running ? `running (pid ${serverState.pid})` : "stopped"} · ${config.serverUrl}`);
  console.log(`Agentd: ${running ? `running (pid ${pid})` : "stopped"}`);
  console.log(`Device: ${config.deviceId ? `${config.deviceName} · ${config.deviceId}` : "not set up"}`);
  console.log(`Paired: ${config.paired}`);
  // Device providers are the ones agentd brokers locally. Providers configured
  // on the server need an owner session to read, which the CLI does not hold,
  // so labelling this plainly beats printing a count that looks like the server's.
  console.log(`Device providers: ${config.providers.length}`);
  console.log(`Workspaces: ${config.workspaces.length}`);
}

async function doctor(): Promise<void> {
  let dirDetail: string;
  let dirOk = true;
  try {
    dirDetail = await state.ensureDir();
  } catch (error) {
    dirOk = false;
    dirDetail = (error as Error).message;
  }
  let config: state.Config | null = null;
  let configDetail = "config.json";
  try {
    config = await state.load();
  } catch (error) {
    configDetail = (error as Error).message;
  }
  const checks = [
    { name: "State directory", ok: dirOk, detail: dirDetail },
    { name: "Configuration", ok: config !== null, detail: configDetail },
    {
      name: "Device identity",
      ok: Boolean(config?.deviceId),
      detail: config?.deviceId || "Not configured",
    },
    {
      name: "Server URL",
      ok: Boolean(config?.serverUrl?.startsWith("http")),
      detail: config?.serverUrl || "Not configured",
    },
  ];
  console.log("OpenCrew doctor\n");
  let failed = false;
  for (const check of checks) {
    console.log(`${mark(check.ok)} ${check.name.padEnd(22)} ${check.detail}`);
    failed ||= !check.ok;
  }
  console.log("\nOptional runtimes");
  for (const runtime of detect.all()) {
    console.log(`${mark(runtime.installed)} ${runtime.name.padEnd(22)} ${runtime.detail}`);
  }
  if (failed) {
    console.log("\nNext: run 'opencrew setup' to repair required configuration.");
    throw new AlreadyReported();
  }
  console.log("\nEverything required is ready.");
}

async function runtimeCommand(args: string[]): Promise<void> {
  const [action, target] = args;
  switch (action) {
    case undefined:
    case "list":
      return runtimeInstall.list();
    case "install":
      return target ? await runtimeInstall.install(target) : await runtimeInstall.installInteractive();
    default:
      throw new Error(`unknown runtime command "${action}"; usage: opencrew runtime list|install [name]`);
  }
}

async function agentdCommand(args: string[]): Promise<void> {
  const [action] = args;
  if (!action) throw new Error("usage: opencrew agentd install|status");
  switch (action) {
    case "status":
      return status();
    case "install":
      await service.installCurrent(import.meta.path);
      console.log("✓ agentd installed and started for this user");
      return;
    default:
      throw new Error(`unknown agentd command "${action}"`);
  }
}

async function serverCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  switch (action) {
    case "start":
      return server.start();
    case "stop":
      return server.stop();
    case "restart":
      return server.restart();
    case "status": {
      const current = await server.running();
      console.log(current.running ? `OpenCrew server is running (pid ${current.pid})` : "OpenCrew server is stopped");
      return;
    }
    case "logs":
      return server.logs(rest.includes("--all"));
    default:
      throw new Error("usage: opencrew server start|stop|restart|status|logs");
  }
}

function update(): void {
  if (isWindows) {
    console.log("Run this in PowerShell to update OpenCrew:\n\n  irm https://opencrew.dev/install.ps1 | iex");
  } else {
    console.log("Run this command to update OpenCrew:\n\n  curl -fsSL https://opencrew.dev/install.sh | sh");
  }
}

function mark(ok: boolean): string {
  return ok ? "✓" : "·";
}

function help(): void {
  console.log(`OpenCrew — your local agent bridge

Usage:
  opencrew                         Open the local dashboard
  opencrew init                    Choose server, app, and model access
  opencrew connect [server-url]    Pair this computer with a server
  opencrew up|down                 Start or stop the local server
  opencrew open                    Open the app in your browser
  opencrew status                  Show server, device, and provider state
  opencrew server start|stop|restart|status|logs
  opencrew start|stop|restart      Control the local device daemon
  opencrew doctor                  Check required setup and optional runtimes
  opencrew logs [--all]            Show recent daemon logs
  opencrew update                  Print the safe update command
  opencrew backup <file>           Back up configuration without API credentials
  opencrew restore <file>          Restore a configuration backup

Providers and workspaces:
  opencrew provider add|list|test
  opencrew workspace add [path]|list
  opencrew agentd install|status
  opencrew runtime list|install [claude-code|codex]

Run 'opencrew init' to get started.`);
}

await main();
