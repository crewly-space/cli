import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithin } from "./workspace.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "opencrew-ws-")));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("resolveWithin", () => {
  test("rejects traversal", () => {
    const root = tempDir();
    expect(() => resolveWithin(root, join("..", "secret"))).toThrow(/escapes workspace/);
  });

  test("allows a new nested path", () => {
    const root = tempDir();
    expect(resolveWithin(root, join("src", "new.ts"))).toBe(join(root, "src", "new.ts"));
  });

  test("rejects a symlink escape", () => {
    const root = tempDir();
    const outside = tempDir();
    try {
      symlinkSync(outside, join(root, "escape"), "dir");
    } catch {
      return; // symlink creation needs developer mode on Windows
    }
    expect(() => resolveWithin(root, join("escape", "file"))).toThrow(/escapes workspace/);
  });

  test("rejects an absolute path outside the root", () => {
    const root = tempDir();
    const outside = tempDir();
    expect(() => resolveWithin(root, join(outside, "file"))).toThrow(/escapes workspace/);
  });
});
