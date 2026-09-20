import { dim } from "./ui.ts";

/**
 * A single buffered reader over stdin. One shared instance matters: line reads and the
 * hidden-input read must not race for the same bytes.
 */
class StdinReader {
  private buffer = Buffer.alloc(0);
  private iterator: AsyncIterator<Buffer> | null = null;

  private source(): AsyncIterator<Buffer> {
    this.iterator ??= process.stdin[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    return this.iterator;
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.source().next();
    if (done || !value) return false;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(value)]);
    return true;
  }

  /** Resolves to null once the stream ends with nothing left to read. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const index = this.buffer.indexOf(0x0a);
      if (index !== -1) {
        const line = this.buffer.subarray(0, index).toString("utf8");
        this.buffer = this.buffer.subarray(index + 1);
        return line.replace(/\r$/, "");
      }
      if (!(await this.fill())) {
        if (this.buffer.length === 0) return null;
        const rest = this.buffer.toString("utf8");
        this.buffer = Buffer.alloc(0);
        return rest;
      }
    }
  }

  async readByte(): Promise<number | null> {
    while (this.buffer.length === 0) {
      if (!(await this.fill())) return null;
    }
    const byte = this.buffer[0] as number;
    this.buffer = this.buffer.subarray(1);
    return byte;
  }
}

export const stdin = new StdinReader();

/**
 * Signals that a question had no one to answer it. End of input is not consent:
 * without this, a closed stdin answers every prompt with its default and walks
 * an unattended `crewly` through the whole install.
 */
export class NoInputError extends Error {
  constructor() {
    super("crewly needs a terminal to ask that question. Run it in one, or pass --yes to accept the defaults.");
    this.name = "NoInputError";
  }
}

export async function readLine(prompt = ""): Promise<string> {
  if (prompt) process.stdout.write(prompt);
  const line = await stdin.readLine();
  if (line === null) {
    if (prompt) process.stdout.write("\n");
    throw new NoInputError();
  }
  return line.trim();
}

export async function readLineDefault(label: string, value: string): Promise<string> {
  const next = await readLine(`${label} ${dim(`[${value}]`)}: `);
  return next === "" ? value : next;
}

/** Reads without echoing where the terminal supports it, falling back to a plain line read. */
export async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return await readLine();
  }
  process.stdin.setRawMode(true);
  try {
    let value = "";
    for (;;) {
      const byte = await stdin.readByte();
      if (byte === null || byte === 0x0a || byte === 0x0d) break;
      if (byte === 0x03) {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (byte === 0x7f || byte === 0x08) {
        value = value.slice(0, -1);
        continue;
      }
      value += String.fromCharCode(byte);
    }
    return value.trim();
  } finally {
    process.stdin.setRawMode(false);
  }
}

export function close(): void {
  process.stdin.pause();
}
