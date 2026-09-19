import * as detect from "./detect.ts";
import { select } from "./select.ts";

/**
 * Installing the coding runtimes an agent can drive.
 *
 * detect.ts only ever answered "is it there?". This answers "put it there",
 * so a fresh server can go from bare to usable without the operator hunting
 * down two separate install commands.
 *
 * Both ship as npm packages whose bin name is exactly what detect.ts looks
 * for, so a successful install is observable: the binary shows up on PATH.
 */
export interface Installable {
  id: string;
  name: string;
  package: string;
  binary: string;
  signIn: string;
}

export const INSTALLABLE: Installable[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    package: "@anthropic-ai/claude-code",
    binary: "claude",
    signIn: "claude",
  },
  {
    id: "codex",
    name: "Codex",
    package: "@openai/codex",
    binary: "codex",
    signIn: "codex",
  },
];

export function find(id: string): Installable {
  const match = INSTALLABLE.find((item) => item.id === id);
  if (!match) {
    throw new Error(`unknown runtime "${id}"; choose ${INSTALLABLE.map((i) => i.id).join(" or ")}`);
  }
  return match;
}

function npmCommand(): string[] {
  const npm = detect.look("npm");
  if (!npm) {
    throw new Error(
      "npm is required to install coding runtimes but was not found on PATH.\n" +
        "  Install Node.js (which bundles npm), then run this again.",
    );
  }
  // npm ships as a .cmd shim on Windows, which needs a shell to execute.
  return process.platform === "win32" ? ["cmd.exe", "/c", "npm"] : [npm];
}

async function run(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await child.exited;
}

/** Installs one runtime globally, then confirms its binary is actually reachable. */
export async function install(id: string): Promise<void> {
  const target = find(id);
  const before = detect.look(target.binary);
  if (before) {
    console.log(`✓ ${target.name} is already installed (${before})`);
    return;
  }

  console.log(`\nInstalling ${target.name} from ${target.package}`);
  const code = await run([...npmCommand(), "install", "--global", target.package]);
  if (code !== 0) {
    throw new Error(
      `npm install --global ${target.package} exited with ${code}.\n` +
        "  On Linux a global install often needs sudo, or an npm prefix you own.",
    );
  }

  const after = detect.look(target.binary);
  if (!after) {
    throw new Error(
      `${target.name} installed but "${target.binary}" is not on PATH.\n` +
        "  Open a new terminal, or add your npm global bin directory to PATH.",
    );
  }
  console.log(`✓ ${target.name} installed (${after})`);
  console.log(`  Run "${target.signIn}" once to sign in.`);
}

/** Interactive picker used by `crewly runtime install` with no argument. */
export async function installInteractive(): Promise<void> {
  const missing = INSTALLABLE.filter((item) => !detect.look(item.binary));
  if (missing.length === 0) {
    console.log("✓ Claude Code and Codex are both installed");
    return;
  }
  const options = [
    ...missing.map((item) => ({ value: item.id, label: item.name, hint: `(${item.package})` })),
    ...(missing.length > 1 ? [{ value: "all", label: "Install both" }] : []),
  ];
  const choice = await select("\nWhich runtime should I install?", options);
  for (const item of choice === "all" ? missing : [find(choice)]) {
    await install(item.id);
  }
}

export function list(): void {
  console.log("\nCoding runtimes\n");
  for (const runtime of detect.all().filter((entry) => !entry.provider)) {
    const mark = runtime.installed ? (runtime.authenticated ? "✓" : "·") : "×";
    console.log(`  ${mark} ${runtime.name.padEnd(14)} ${runtime.detail}`);
  }
  const missing = INSTALLABLE.filter((item) => !detect.look(item.binary));
  console.log(
    missing.length > 0
      ? `\nInstall with: crewly runtime install ${missing[0]!.id}`
      : "\nBoth runtimes are installed.",
  );
}
