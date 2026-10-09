import { describe, expect, test } from "bun:test";
import { claudeArgs, claudeModel, failure, formatPrompt, SPAWN_OPTIONS } from "./claude-subscription.ts";

describe("formatPrompt", () => {
  test("preserves conversation roles", () => {
    const got = formatPrompt([
      { role: "user", content: "Plan the launch" },
      { role: "assistant", content: "What is the date?" },
      { role: "user", content: "Tuesday" },
    ]);
    for (const want of ["USER:\nPlan the launch", "ASSISTANT:\nWhat is the date?", "USER:\nTuesday"]) {
      expect(got).toContain(want);
    }
  });

  test("defaults a blank role to USER and ends on the assistant turn", () => {
    expect(formatPrompt([{ role: "  ", content: "hi" }])).toBe("USER:\nhi\n\nASSISTANT:\n");
  });
});

describe("claudeModel", () => {
  test("passes Claude Code aliases and model ids through", () => {
    expect(claudeModel("sonnet")).toBe("sonnet");
    expect(claudeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(claudeModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5[1m]");
  });

  test("turns a display-style name into the id Claude Code recognizes", () => {
    expect(claudeModel("claude sonnet-5")).toBe("claude-sonnet-5");
    expect(claudeModel("  Claude  Sonnet 5 ")).toBe("claude-sonnet-5");
  });

  test("leaves the model to Claude Code when none is given", () => {
    expect(claudeModel(undefined)).toBeUndefined();
    expect(claudeModel("   ")).toBeUndefined();
  });

  test("rejects names that are not model ids", () => {
    expect(() => claudeModel("sonnet & calc")).toThrow("not a Claude model name");
  });
});

describe("claudeArgs", () => {
  // A claude.cmd shim runs through cmd.exe, and Bun refuses any argument it
  // cannot pass safely. Conversation text therefore never goes on the command line.
  test("keeps conversation and system prompt off the command line", () => {
    const args = claudeArgs("claude sonnet-5", "C:\\tmp\\system.txt");
    expect(args).toContain("--system-prompt-file");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    for (const arg of args) expect(arg).not.toMatch(/[\s&|<>^%"]/);
  });

  // The device owner's settings, hooks, MCP servers and session history are
  // theirs, not the agent's. (CLAUDE.md is kept out by the empty working directory.)
  test("isolates Claude from the device owner's configuration", () => {
    const args = claudeArgs(undefined, undefined);
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
  });

  test("omits optional flags", () => {
    const args = claudeArgs(undefined, undefined);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--system-prompt-file");
  });
});

test("spawns Claude without a console window", () => {
  expect(SPAWN_OPTIONS.windowsHide).toBe(true);
  expect(SPAWN_OPTIONS.stdin).toBe("pipe");
});

describe("failure", () => {
  test("reports stderr and exit status", () => {
    expect(failure(1, "[claude-code:unrecognized_model] bad", "").message)
      .toBe("local Claude provider failed (exit status 1): [claude-code:unrecognized_model] bad");
  });

  test("falls back to the last output line when stderr is empty", () => {
    expect(failure(1, "", '{"type":"result","is_error":true}').message)
      .toBe('local Claude provider failed (exit status 1): {"type":"result","is_error":true}');
  });
});
