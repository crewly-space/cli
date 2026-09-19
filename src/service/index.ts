import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivate } from "../fsx.ts";
import { userConfigDir } from "../paths.ts";

export async function installCurrent(entrypoint: string): Promise<void> {
  const bunRuntime = process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe");
  return install(process.execPath, bunRuntime ? [entrypoint] : []);
}

export async function install(executable: string, prefixArgs: string[] = []): Promise<void> {
  if (!executable) throw new Error("executable path is required");
  switch (process.platform) {
    case "linux":
      return installLinux(executable, prefixArgs);
    case "darwin":
      return installDarwin(executable, prefixArgs);
    case "win32":
      return installWindows(executable, prefixArgs);
    default:
      throw new Error(`unsupported platform ${process.platform}`);
  }
}

async function run(command: string[]): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
}

async function installLinux(executable: string, prefixArgs: string[]): Promise<void> {
  const dir = join(userConfigDir(), "systemd", "user");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const unit = `[Unit]
Description=Crewly local agent daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${[executable, ...prefixArgs, "_serve"].map(systemdQuote).join(" ")}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
  await writePrivate(join(dir, "crewly-agentd.service"), unit);
  const reload = await run(["systemctl", "--user", "daemon-reload"]);
  if (!reload.ok) throw new Error(`reload user services: ${reload.output}`);
  const enable = await run(["systemctl", "--user", "enable", "--now", "crewly-agentd.service"]);
  if (!enable.ok) throw new Error(`enable agentd: ${enable.output}`);
}

async function installDarwin(executable: string, prefixArgs: string[]): Promise<void> {
  const dir = join(homedir(), "Library", "LaunchAgents");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "dev.crewly.agentd.plist");
  const logPath = join(userConfigDir(), "crewly", "agentd.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.crewly.agentd</string>
<key>ProgramArguments</key><array>${[executable, ...prefixArgs, "_serve"].map((value) => `<string>${xmlEscape(value)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${logPath}</string><key>StandardErrorPath</key><string>${logPath}</string>
</dict></plist>`;
  await writePrivate(path, plist);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  await run(["launchctl", "bootout", `${domain}/dev.crewly.agentd`]);
  const bootstrap = await run(["launchctl", "bootstrap", domain, path]);
  if (!bootstrap.ok) throw new Error(`load agentd: ${bootstrap.output}`);
}

async function installWindows(executable: string, prefixArgs: string[]): Promise<void> {
  const command = [executable, ...prefixArgs, "_serve"].map(windowsQuote).join(" ");
  const create = await run([
    "schtasks.exe", "/Create", "/TN", "Crewly agentd", "/SC", "ONLOGON", "/TR", command, "/F",
  ]);
  if (!create.ok) throw new Error(`register agentd task: ${create.output}`);
  const start = await run(["schtasks.exe", "/Run", "/TN", "Crewly agentd"]);
  if (!start.ok) throw new Error(`start agentd task: ${start.output}`);
}

function systemdQuote(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
