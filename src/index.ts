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
import { close as closeStdin, readLine } from "./tty.ts";
import { bold, brand, cyan, dim, green, heading, mark, red, row, stateMark, yellow, type RuntimeState } from "./ui.ts";
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
      console.error(`${red("Error:")} ${error instanceof Error ? error.message : error}`);
      console.error(dim("Run 'crewly help' for usage, or 'crewly doctor' to check your setup."));
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
      console.log(brand("crewly"), VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      return help();
    default:
      throw new Error(`unknown command "${command}"; run crewly help`);
  }
}

async function dashboard(): Promise<void> {
  const config = await state.load();
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(`  ${brand("Crewly")}`);
  console.log(`  ${dim("Your agents, on your terms.")}\n`);
  if (config.installMode === "unconfigured") {
    console.log(`  ${cyan("Press Enter")} ${dim("to begin, or q to quit.")}`);
    const choice = await readLine("");
    if (choice.toLowerCase() === "q") return;
    return init([]);
  }
  row("Device", config.deviceName);
  row("Pairing", config.paired ? green("Connected") : yellow("Not paired"));
  row("Providers", String(config.providers.length));
  row("Workspaces", String(config.workspaces.length));
  console.log();
  for (const runtime of detect.all()) {
    console.log(`  ${stateMark(runtimeState(runtime))} ${runtime.name.padEnd(20)} ${dim(runtime.detail)}`);
  }
  console.log(`\n  ${dim("init · up · status · provider · workspace · doctor · logs")}`);
}

async function connect(args: string[]): Promise<void> {
  // Without this an unknown flag is taken as the server URL, and the failure
  // shows up as "server URL must be a valid http or https address".
  const flag = args.find((arg) => arg.startsWith("-"));
  if (flag) throw new Error(`unknown option "${flag}"; usage: crewly connect [server-url]`);
  if (args.length > 1) throw new Error("usage: crewly connect [server-url]");
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
  if (!(await pairDevice(config, deviceIdentity))) return;
  // A daemon left over from a previous pairing keeps talking to the old server:
  // daemon.start() sees a live process and returns, so the new server never
  // gets a connection and reports the device as offline with no capabilities.
  const { running } = await daemon.running(state.dir());
  if (running) await daemon.stop();
  await daemon.start(import.meta.path);
}

async function status(): Promise<void> {
  const config = await state.load();
  const { running, pid } = await daemon.running(state.dir());
  const serverState = await server.running();
  console.log(`${brand("Crewly")} ${VERSION} ${dim(`(${detect.platform()})`)}`);
  row("Mode", config.installMode);
  row("Server", `${serverState.running ? green(`running (pid ${serverState.pid})`) : dim("stopped")} · ${config.serverUrl}`);
  row("Agentd", running ? green(`running (pid ${pid})`) : dim("stopped"));
  row("Device", config.deviceId ? `${config.deviceName} · ${dim(config.deviceId)}` : yellow("not set up"));
  row("Paired", config.paired ? green("yes") : yellow("no"));
  // Device providers are the ones agentd brokers locally. Providers configured
  // on the server need an owner session to read, which the CLI does not hold,
  // so labelling this plainly beats printing a count that looks like the server's.
  row("Device providers", String(config.providers.length));
  row("Workspaces", String(config.workspaces.length));
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
  heading("Crewly doctor");
  let failed = false;
  for (const check of checks) {
    console.log(`  ${mark(check.ok)} ${check.name.padEnd(22)} ${dim(check.detail)}`);
    failed ||= !check.ok;
  }
  console.log(dim("\nOptional runtimes"));
  for (const runtime of detect.all()) {
    console.log(`  ${stateMark(runtimeState(runtime))} ${runtime.name.padEnd(22)} ${dim(runtime.detail)}`);
  }
  if (failed) {
    console.log(`\n${dim("Next:")} run 'crewly setup' to repair required configuration.`);
    throw new AlreadyReported();
  }
  console.log(`\n${green("Everything required is ready.")}`);
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
      throw new Error(`unknown runtime command "${action}"; usage: crewly runtime list|install [name]`);
  }
}

async function agentdCommand(args: string[]): Promise<void> {
  const [action] = args;
  if (!action) throw new Error("usage: crewly agentd install|status");
  switch (action) {
    case "status":
      return status();
    case "install":
      await service.installCurrent(import.meta.path);
      console.log(`${green("✓")} agentd installed and started for this user`);
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
      console.log(current.running ? green(`Crewly server is running (pid ${current.pid})`) : dim("Crewly server is stopped"));
      return;
    }
    case "logs":
      return server.logs(rest.includes("--all"));
    default:
      throw new Error("usage: crewly server start|stop|restart|status|logs");
  }
}

function update(): void {
  if (isWindows) {
    console.log(`Run this in PowerShell to update Crewly:\n\n  ${cyan("irm https://crewly.space/install.ps1 | iex")}`);
  } else {
    console.log(`Run this command to update Crewly:\n\n  ${cyan("curl -fsSL https://crewly.space/install.sh | sh")}`);
  }
}

/** Installed is a pass, installed-but-unsigned-in warns, and missing is neutral. */
function runtimeState(runtime: detect.Runtime): RuntimeState {
  if (!runtime.installed) return "missing";
  return runtime.authenticated ? "ok" : "warn";
}

function help(): void {
  const cmd = (name: string, description: string): string =>
    `  ${bold(name.padEnd(26))} ${dim(description)}`;

  console.log(brand("Crewly"));
  console.log(dim("Your local agent bridge\n"));
  console.log(bold("Usage"));
  console.log(`  ${dim("crewly")} ${bold("<command>")} ${dim("[options]")}\n`);

  console.log(bold("Get started"));
  console.log(cmd("init", "Set up a server, app, and model access"));
  console.log(cmd("connect [server-url]", "Pair this computer with a server"));
  console.log(cmd("doctor", "Check setup and optional runtimes"));
  console.log(cmd("status", "Show server, device, and provider state"));
  console.log(cmd("up | down", "Start or stop the local server"));
  console.log(cmd("open", "Open the app in your browser"));
  console.log();

  console.log(bold("Control the daemon"));
  console.log(cmd("start | stop | restart", "Manage the local device daemon"));
  console.log(cmd("server <action>", "start, stop, restart, status, logs"));
  console.log(cmd("logs [--all]", "Show recent daemon logs"));
  console.log();

  console.log(bold("Providers and workspaces"));
  console.log(cmd("provider <action>", "add, list, test"));
  console.log(cmd("workspace <action>", "add [path], list"));
  console.log(cmd("agentd <action>", "install, status"));
  console.log(cmd("runtime <action>", "list, install [claude-code | codex]"));
  console.log();

  console.log(bold("Manage"));
  console.log(cmd("backup <file>", "Back up configuration without API credentials"));
  console.log(cmd("restore <file>", "Restore a configuration backup"));
  console.log(cmd("update", "Print the safe update command"));
  console.log();

  console.log(`${dim("Run")} ${bold("crewly init")} ${dim("to get started.")}`);
}

await main();
