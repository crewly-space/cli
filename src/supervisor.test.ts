import { describe, expect, test } from "bun:test";
import { adapterCommand, readLines } from "./supervisor.ts";

describe("adapterCommand", () => {
  test("rejects an undeclared runtime", () => {
    expect(() => adapterCommand({ runtimeId: "powershell", prompt: "whoami" })).toThrow(
      /unsupported runtime/,
    );
  });

  test("rejects a model provider used as an execution runtime", () => {
    expect(() => adapterCommand({ runtimeId: "claude-subscription", prompt: "run a command" })).toThrow(
      /unsupported runtime/,
    );
  });
});

describe("readLines", () => {
  test("splits on newlines and drops a trailing carriage return", async () => {
    const stream = new Response("alpha\r\nbeta\ngamma").body as ReadableStream<Uint8Array>;
    const lines: string[] = [];
    for await (const line of readLines(stream)) lines.push(line);
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
  });

  test("yields nothing for an empty stream", async () => {
    const stream = new Response("").body as ReadableStream<Uint8Array>;
    const lines: string[] = [];
    for await (const line of readLines(stream)) lines.push(line);
    expect(lines).toEqual([]);
  });
});
