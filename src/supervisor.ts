import { all as allRuntimes } from "./detect.ts";

export interface Request {
  runtimeId: string;
  prompt: string;
  workspace?: string;
  resumeId?: string;
}

export interface Event {
  type: "output" | "diagnostic" | "completed" | "failed";
  text?: string;
  error?: Error;
}

/** Tracks running sessions so the server can stop one by id but never name an executable. */
export class Supervisor {
  private readonly running = new Map<string, AbortController>();

  /** Accepts only typed adapter requests — no executable or raw argv crosses this boundary. */
  start(sessionId: string, request: Request): AsyncGenerator<Event> {
    if (this.running.has(sessionId)) throw new Error("session is already running");
    const spec = adapterCommand(request);
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    return this.run(sessionId, spec, request, controller);
  }

  stop(sessionId: string): boolean {
    const controller = this.running.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async *run(
    sessionId: string,
    spec: { executable: string; args: string[] },
    request: Request,
    controller: AbortController,
  ): AsyncGenerator<Event> {
    const child = Bun.spawn([spec.executable, ...spec.args], {
      cwd: request.workspace || undefined,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    try {
      const queue = new EventQueue();
      const readers = [
        pump(child.stdout, "output", queue),
        pump(child.stderr, "diagnostic", queue),
      ];
      const finished = (async () => {
        const code = await child.exited;
        await Promise.all(readers);
        queue.push(
          code === 0 ? { type: "completed" } : { type: "failed", error: new Error(`exit status ${code}`) },
        );
        queue.close();
      })();
      yield* queue;
      await finished;
    } finally {
      this.running.delete(sessionId);
    }
  }
}

async function pump(stream: ReadableStream<Uint8Array>, kind: "output" | "diagnostic", queue: EventQueue) {
  try {
    for await (const line of readLines(stream)) queue.push({ type: kind, text: line });
  } catch (error) {
    queue.push({ type: "diagnostic", error: error as Error });
  }
}

/** Splits a byte stream into lines, matching bufio.Scanner's newline handling. */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") yield buffer.replace(/\r$/, "");
}

/** A small async queue so two readers can feed one consumer, like a buffered Go channel. */
class EventQueue {
  private readonly items: Event[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  push(event: Event) {
    this.items.push(event);
    this.waiting?.();
    this.waiting = null;
  }

  close() {
    this.closed = true;
    this.waiting?.();
    this.waiting = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Event> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift() as Event;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

export function adapterCommand(request: Request): { executable: string; args: string[] } {
  const runtime = allRuntimes().find((candidate) => candidate.id === request.runtimeId);
  if (!runtime || runtime.provider) throw new Error(`unsupported runtime "${request.runtimeId}"`);
  if (!runtime.installed || !runtime.executable) {
    throw new Error(`runtime "${request.runtimeId}" is not installed`);
  }
  switch (request.runtimeId) {
    case "claude-code": {
      const args = ["--print", "--output-format", "stream-json", request.prompt];
      return {
        executable: runtime.executable,
        args: request.resumeId ? ["--resume", request.resumeId, ...args] : args,
      };
    }
    case "codex":
      return {
        executable: runtime.executable,
        args: request.resumeId
          ? ["exec", "resume", request.resumeId, "--json", request.prompt]
          : ["exec", "--json", request.prompt],
      };
    default:
      throw new Error(`runtime "${request.runtimeId}" has no adapter`);
  }
}
