import { look } from "../detect.ts";
import { readLines } from "../supervisor.ts";
import type { Adapter, Event, Message, Request } from "./types.ts";

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

    const args = ["--print", "--output-format", "stream-json", "--verbose"];
    if (request.model) args.push("--model", request.model);
    if (request.system) args.push("--system-prompt", request.system);
    args.push(formatPrompt(request.messages));

    const child = Bun.spawn([this.executable, ...args], { stdout: "pipe", stderr: "pipe" });
    const diagnostics = collect(child.stderr);
    try {
      for await (const line of readLines(child.stdout)) yield { type: "delta", data: line };
    } catch (error) {
      yield { type: "error", error: error as Error };
      return;
    }
    const code = await child.exited;
    const stderrText = (await diagnostics).trim();
    if (code !== 0) {
      yield {
        type: "error",
        error: new Error(`local Claude provider failed: ${stderrText}: exit status ${code}`),
      };
      return;
    }
    yield { type: "completed" };
  }
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
