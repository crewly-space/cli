import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryPath, webPath } from "./server.ts";
import { assetName, expectedChecksum, install, managedDir } from "./server-install.ts";

const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
const saved = {
  home: process.env.CREWLY_HOME,
  bin: process.env.CREWLY_SERVER_BIN,
  web: process.env.CREWLY_WEB_DIR,
};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewly-install-"));
  dirs.push(dir);
  return dir;
}

function useTempHome(): string {
  const dir = tempDir();
  process.env.CREWLY_HOME = dir;
  delete process.env.CREWLY_SERVER_BIN;
  delete process.env.CREWLY_WEB_DIR;
  return dir;
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  restore("CREWLY_HOME", saved.home);
  restore("CREWLY_SERVER_BIN", saved.bin);
  restore("CREWLY_WEB_DIR", saved.web);
});

// Windows ships bsdtar in System32; Git Bash puts GNU tar first on PATH, which cannot read zips.
const tar = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";
const serverFile = process.platform === "win32" ? "crewly-server.exe" : "crewly-server";

/** Builds a release archive shaped like the real one: the binary plus web/index.html. */
function buildArchive(): { name: string; bytes: Uint8Array } {
  const stage = tempDir();
  writeFileSync(join(stage, serverFile), "fake server binary");
  mkdirSync(join(stage, "web"));
  writeFileSync(join(stage, "web", "index.html"), "<html></html>");
  const name = assetName();
  const archive = join(tempDir(), name);
  const result = Bun.spawnSync([tar, "-a", "-cf", archive, "-C", stage, "."]);
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
  return { name, bytes: new Uint8Array(readFileSync(archive)) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Serves an archive and a checksums.txt the way a GitHub release does. */
function serveRelease(archive: { name: string; bytes: Uint8Array }, checksum: string): string {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === `/${archive.name}`) return new Response(archive.bytes);
      if (path === "/checksums.txt") return new Response(`${checksum}  ${archive.name}\n`);
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("assetName", () => {
  test("uses a zip for Windows and a tarball elsewhere", () => {
    expect(assetName("win32", "x64")).toBe("crewly-server_windows_amd64.zip");
    expect(assetName("linux", "x64")).toBe("crewly-server_linux_amd64.tar.gz");
    expect(assetName("linux", "arm64")).toBe("crewly-server_linux_arm64.tar.gz");
    expect(assetName("darwin", "arm64")).toBe("crewly-server_darwin_arm64.tar.gz");
  });

  test("refuses a platform that has no published release", () => {
    expect(() => assetName("win32", "arm64")).toThrow(/windows.*arm64/i);
    expect(() => assetName("freebsd", "x64")).toThrow(/freebsd/i);
  });
});

describe("expectedChecksum", () => {
  const listing = [
    `${"a".repeat(64)}  crewly-server_linux_amd64.tar.gz`,
    `${"B".repeat(64)}  crewly-server_windows_amd64.zip`,
    `${"c".repeat(64)}  install.sh`,
  ].join("\n");

  test("returns the lowercase hash for the matching asset", () => {
    expect(expectedChecksum(listing, "crewly-server_windows_amd64.zip")).toBe("b".repeat(64));
  });

  test("does not match an asset whose name merely ends the same way", () => {
    expect(() => expectedChecksum(`${"a".repeat(64)}  x-crewly-server_windows_amd64.zip`, "crewly-server_windows_amd64.zip"))
      .toThrow(/missing/i);
  });

  test("throws when the release lists no checksum for the asset", () => {
    expect(() => expectedChecksum(listing, "crewly-server_darwin_arm64.tar.gz")).toThrow(/missing/i);
  });
});

describe("binary and app location", () => {
  test("an explicit override always wins", () => {
    useTempHome();
    process.env.CREWLY_SERVER_BIN = "C:\\custom\\crewly-server.exe";
    process.env.CREWLY_WEB_DIR = "C:\\custom\\web";
    expect(binaryPath()).toBe("C:\\custom\\crewly-server.exe");
    expect(webPath()).toBe("C:\\custom\\web");
  });

  test("falls back to the managed directory when nothing sits next to the runtime", () => {
    const home = useTempHome();
    expect(managedDir()).toBe(join(home, "server-bin"));
    expect(binaryPath()).toBe(join(home, "server-bin", serverFile));
    expect(webPath()).toBe(join(home, "server-bin", "web"));
  });
});

describe("install", () => {
  test("downloads, verifies and unpacks the server and the app into the managed directory", async () => {
    useTempHome();
    const archive = buildArchive();
    const baseUrl = serveRelease(archive, sha256(archive.bytes));

    await install({ baseUrl });

    expect(existsSync(join(managedDir(), serverFile))).toBe(true);
    expect(existsSync(join(managedDir(), "web", "index.html"))).toBe(true);
  });

  test("rejects an archive whose checksum does not match and installs nothing", async () => {
    useTempHome();
    const archive = buildArchive();
    const baseUrl = serveRelease(archive, "0".repeat(64));

    await expect(install({ baseUrl })).rejects.toThrow(/checksum/i);
    expect(existsSync(managedDir())).toBe(false);
  });

  test("reports a failed download instead of installing a partial server", async () => {
    useTempHome();
    const archive = buildArchive();
    const baseUrl = serveRelease({ name: "some-other-asset.zip", bytes: archive.bytes }, sha256(archive.bytes));

    await expect(install({ baseUrl })).rejects.toThrow(/does not publish crewly-server_/);
    expect(existsSync(managedDir())).toBe(false);
  });

  test("replaces an earlier install rather than layering on top of it", async () => {
    useTempHome();
    mkdirSync(managedDir(), { recursive: true });
    writeFileSync(join(managedDir(), "stale-file"), "left over from an older release");
    const archive = buildArchive();
    const baseUrl = serveRelease(archive, sha256(archive.bytes));

    await install({ baseUrl });

    expect(existsSync(join(managedDir(), "stale-file"))).toBe(false);
    expect(existsSync(join(managedDir(), serverFile))).toBe(true);
  });
});

