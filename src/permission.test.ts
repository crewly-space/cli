import { describe, expect, test } from "bun:test";
import { evaluate } from "./permission.ts";
import { defaultPermissions, type Workspace } from "./state.ts";

function workspace(): Workspace {
  return { id: "ws_test", name: "test", path: "/tmp", permissions: defaultPermissions(), addedAt: "" };
}

describe("permission", () => {
  test("unknown capabilities fail closed", () => {
    expect(() => evaluate(workspace(), "shell.arbitrary")).toThrow(/undeclared capability/);
  });

  test("git.push is denied by default", () => {
    expect(evaluate(workspace(), "git.push").policy).toBe("deny");
  });

  test("a capability missing from the workspace falls back to deny", () => {
    const bare = { ...workspace(), permissions: {} };
    const decision = evaluate(bare, "shell.run");
    expect(decision.policy).toBe("deny");
    expect(decision.needsAsk).toBe(false);
  });
});
