import { describe, expect, it } from "bun:test";
import { NoInputError, readLine, stdin } from "./tty.ts";

/**
 * Replaces process.stdin's async iterator for one test. The reader holds a
 * single shared iterator, so each case gets its own fresh stream.
 */
function feed(chunks: string[]): void {
  const queue = chunks.map((c) => Buffer.from(c, "utf8"));
  (stdin as unknown as { iterator: AsyncIterator<Buffer> | null }).iterator = {
    next: async () => {
      const value = queue.shift();
      return value ? { value, done: false } : { value: undefined as never, done: true };
    },
  };
  (stdin as unknown as { buffer: Buffer }).buffer = Buffer.alloc(0);
}

describe("readLine", () => {
  it("reads a piped line", async () => {
    feed(["hello\n"]);
    expect(await readLine()).toBe("hello");
  });

  it("returns the last line when input ends without a newline", async () => {
    feed(["tail"]);
    expect(await readLine()).toBe("tail");
  });

  it("throws rather than answering its own question when input has ended", async () => {
    // End of input is not consent: treating it as an empty line accepted every
    // default and walked an unattended `crewly` through the whole installer.
    feed([]);
    await expect(readLine("Port [8787]: ")).rejects.toBeInstanceOf(NoInputError);
  });

  it("throws on the prompt that follows the last piped answer", async () => {
    feed(["only-one\n"]);
    expect(await readLine("First: ")).toBe("only-one");
    await expect(readLine("Second: ")).rejects.toBeInstanceOf(NoInputError);
  });
});
