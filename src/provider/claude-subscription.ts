import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { look } from "../detect.ts";
import { writePrivate } from "../fsx.ts";
import { readLines } from "../supervisor.ts";
import type { Adapter, Event, Message, Request } from "./types.ts";

/**
 * agentd runs detached without a console, so on Windows a child started without
 * windowsHide gets a fresh, empty console window of its own.
 */
export const SPAWN_OPTIONS = { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true } as const;

/**
 * Uses the locally authenticated Claude executable. It never reads, serializes, or
 * forwards Claude credential files.
 */
export class ClaudeSubscription implements Adapter {
  readonly id = "claude-subscription";
  private readonly executable: string | undefined;

  constructor() {
    this.executable = look("claude");
  }

  available(): boolean {
    return this.executable !== undefined;
  }

  async *stream(request: Request): AsyncGenerator<Event> {
    if (!this.executable) throw new Error("Claude Code is not installed");
    if (request.messages.length === 0) throw new Error("at least one message is required");

    // The system prompt goes through a file and the conversation through stdin:
    // a claude.cmd shim runs through cmd.exe, which cannot be handed arbitrary text.
    // Claude runs in that empty directory so it discovers no CLAUDE.md from
    // wherever agentd happened to be started.
    const dir = await mkdtemp(join(tmpdir(), "claude-run-"));
    try {
      const systemFile = request.system ? join(dir, "system.txt") : undefined;
      if (systemFile) await writePrivate(systemFile, request.system!);

      let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
      try {
        child = Bun.spawn([this.executable, ...claudeArgs(request.model, systemFile)], { ...SPAWN_OPTIONS, cwd: dir });
      } catch (error) {
        yield { type: "error", error: new Error(`could not start Claude Code at ${this.executable}: ${(error as Error).message}`) };
        return;
      }
      child.stdin.write(formatPrompt(request.messages));
      await child.stdin.end();

      const diagnostics = collect(child.stderr);
      let last = "";
      try {
        for await (const line of readLines(child.stdout)) {
          if (line.trim()) last = line;
          yield { type: "delta", data: line };
        }
      } catch (error) {
        yield { type: "error", error: error as Error };
        return;
      }
      const code = await child.exited;
      if (code !== 0) {
        yield { type: "error", error: failure(code, await diagnostics, last) };
        return;
      }
      yield { type: "completed" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Claude Code takes an alias (sonnet) or a model id (claude-sonnet-5). Agents
 * can carry a display-style name such as "claude sonnet-5", which it rejects as
 * unrecognized, so whitespace is folded into the id's dashes.
 */
export function claudeModel(model: string | undefined): string | undefined {
  const id = model?.trim().toLowerCase().replace(/\s+/g, "-");
  if (!id) return undefined;
  if (!/^[a-z0-9][a-z0-9.\-_[\]]*$/.test(id)) throw new Error(`"${model}" is not a Claude model name`);
  return id;
}

export function claudeArgs(model: string | undefined, systemFile: string | undefined): string[] {
  // This adapter is a model provider, not a remote-control channel. Claude
  // receives no tools here, so a server-supplied prompt cannot read files or
  // execute commands on the device behind the user's permission settings.
  // Nor does it load the device owner's settings, hooks, MCP servers, or add
  // agent conversations to their Claude Code session history.
  const args = [
    "--print", "--output-format", "stream-json", "--verbose", "--tools", "",
    "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
  ];
  const id = claudeModel(model);
  if (id) args.push("--model", id);
  if (systemFile) args.push("--system-prompt-file", systemFile);
  return args;
}

/** Claude Code reports some failures only on stdout, so the last line stands in for empty stderr. */
export function failure(code: number, stderr: string, lastLine: string): Error {
  return new Error(`local Claude provider failed (exit status ${code}): ${stderr.trim() || lastLine.trim() || "no output"}`);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

export function formatPrompt(messages: Message[]): string {
  let out = "";
  for (const message of messages) {
    const role = message.role.trim().toUpperCase() || "USER";
    out += `${role}:\n${message.content.trim()}\n\n`;
  }
  return `${out}ASSISTANT:\n`;
}
