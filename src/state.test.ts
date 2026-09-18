import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPermissions, load, save } from "./state.ts";

const dirs: string[] = [];
const originalHome = process.env.OPENCREW_HOME;

function useTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencrew-state-"));
  dirs.push(dir);
  process.env.OPENCREW_HOME = dir;
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.OPENCREW_HOME;
  else process.env.OPENCREW_HOME = originalHome;
});

describe("state", () => {
  test("normalises the null slices the Go build wrote", async () => {
    const dir = useTempHome();
    await Bun.write(
      join(dir, "config.json"),
      JSON.stringify({
        version: 1,
        serverUrl: "https://app.opencrew.xyz",
        deviceId: "dev_abc",
        deviceName: "go-box",
        paired: false,
        workspaces: null,
        providers: null,
        sessions: null,
        initializedAt: "2026-01-01T00:00:00Z",
      }),
    );
    const config = await load();
    expect(config.workspaces).toEqual([]);
    expect(config.providers).toEqual([]);
    expect(config.sessions).toEqual([]);
    expect(config.deviceId).toBe("dev_abc");
    expect(config.server.port).toBe(8787);
  });

  test("returns defaults when no config exists yet", async () => {
    useTempHome();
    const config = await load();
    expect(config.version).toBe(2);
    expect(config.deviceId).toBe("");
    expect(config.serverUrl).toBe("http://127.0.0.1:8787");
  });

  test("save then load round-trips", async () => {
    useTempHome();
    const config = await load();
    config.deviceId = "dev_roundtrip";
    config.workspaces.push({
      id: "ws_1",
      name: "demo",
      path: "/tmp/demo",
      permissions: defaultPermissions(),
      addedAt: new Date().toISOString(),
    });
    await save(config);
    const reloaded = await load();
    expect(reloaded.deviceId).toBe("dev_roundtrip");
    expect(reloaded.workspaces).toHaveLength(1);
    expect(reloaded.workspaces[0]?.permissions["git.push"]).toBe("deny");
  });
});

describe("defaultPermissions", () => {
  test("git.push starts denied and writes start as ask", () => {
    const permissions = defaultPermissions();
    expect(permissions["git.push"]).toBe("deny");
    expect(permissions["workspace.write"]).toBe("ask");
    expect(permissions["workspace.read"]).toBe("allow");
  });
});
