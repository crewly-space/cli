import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Runtime {
  id: string;
  name: string;
  executable?: string;
  installed: boolean;
  authenticated: boolean;
  provider: boolean;
  detail: string;
}

export function all(): Runtime[] {
  const home = homedir();
  const claudePath = look("claude");
  const codexPath = look("codex");
  const claudeInstalled = claudePath !== undefined;
  const claudeAuth = existsAny(join(home, ".claude", ".credentials.json"), join(home, ".claude.json"));
  const codexAuth = existsAny(join(home, ".codex", "auth.json"));
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      executable: claudePath,
      installed: claudeInstalled,
      authenticated: claudeAuth,
      provider: false,
      detail: detail(claudeInstalled, claudeAuth),
    },
    {
      id: "codex",
      name: "Codex",
      executable: codexPath,
      installed: codexPath !== undefined,
      authenticated: codexAuth,
      provider: false,
      detail: detail(codexPath !== undefined, codexAuth),
    },
    {
      id: "claude-subscription",
      name: "Claude Subscription",
      executable: claudePath,
      installed: claudeInstalled,
      authenticated: claudeAuth,
      provider: true,
      detail: subscriptionDetail(claudeInstalled, claudeAuth),
    },
  ];
}

export function look(name: string): string | undefined {
  return Bun.which(name) ?? undefined;
}

function existsAny(...paths: string[]): boolean {
  return paths.some((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

function detail(installed: boolean, authenticated: boolean): string {
  if (!installed) return "Not installed";
  return authenticated ? "Installed and authenticated" : "Installed; sign-in not detected";
}

function subscriptionDetail(installed: boolean, authenticated: boolean): string {
  if (installed && authenticated) return "Local subscription is available";
  if (installed) return "Run claude login to enable the subscription";
  return "Claude Code is required for local subscription access";
}

/** Reports the Go-style os/arch pair the rest of Crewly already speaks. */
export function platform(): string {
  const os: Record<string, string> = { win32: "windows", darwin: "darwin", linux: "linux" };
  const arch: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  return `${os[process.platform] ?? process.platform}/${arch[process.arch] ?? process.arch}`;
}
