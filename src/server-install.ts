import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWindows } from "./paths.ts";
import * as state from "./state.ts";

const REPOSITORY = "opentribe-dev/opencrew-server";

export const SERVER_BINARY = isWindows ? "opencrew-server.exe" : "opencrew-server";

/**
 * Where a server fetched by the CLI lives. The sibling-of-the-executable layout
 * is only right for a release install; under `bun dev` the executable is Bun
 * itself, and writing next to it would litter the runtime's own directory.
 */
export function managedDir(): string {
  return join(state.dir(), "server-bin");
}

const OS_NAMES: Record<string, string> = { win32: "windows", linux: "linux", darwin: "darwin" };
const ARCH_NAMES: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/** The release asset for a platform, named as opencrew-server's package-release.sh names it. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  const os = OS_NAMES[platform];
  const cpu = ARCH_NAMES[arch];
  if (!os || !cpu || (os === "windows" && cpu !== "amd64")) {
    throw new Error(`no OpenCrew server release is published for ${os ?? platform}/${cpu ?? arch}`);
  }
  return `opencrew-server_${os}_${cpu}.${os === "windows" ? "zip" : "tar.gz"}`;
}

/** Reads one asset's SHA-256 out of a release's checksums.txt (`<hash>  <name>` per line). */
export function expectedChecksum(listing: string, asset: string): string {
  for (const line of listing.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name?.replace(/^\*/, "") === asset) return hash.toLowerCase();
  }
  throw new Error(`release checksum for ${asset} is missing`);
}

function releaseUrl(): string {
  const override = process.env.OPENCREW_RELEASE_BASE_URL;
  if (override) return override;
  const version = process.env.OPENCREW_VERSION || "latest";
  return version === "latest"
    ? `https://github.com/${REPOSITORY}/releases/latest/download`
    : `https://github.com/${REPOSITORY}/releases/download/${version}`;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download of ${url} failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Windows ships bsdtar in System32, which reads zips. Anything else named `tar`
// on PATH (Git Bash's GNU tar, for one) cannot.
function tarBinary(): string {
  return isWindows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

async function extract(archive: string, into: string): Promise<void> {
  const child = Bun.spawn([tarBinary(), "-xf", archive, "-C", into], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`could not unpack ${archive}: ${stderr.trim()}`);
}

/**
 * Fetches the server release for this platform, verifies it against the
 * release's checksums.txt, and replaces the managed install with it. The
 * download is unpacked and checked in a scratch directory first, so a failure
 * at any step leaves the previous state untouched.
 *
 * The checksum guards against a corrupt or truncated download; it lives in the
 * same release as the archive, so it does not authenticate the publisher.
 */
export async function install(options: { baseUrl?: string } = {}): Promise<void> {
  const asset = assetName();
  const baseUrl = (options.baseUrl ?? releaseUrl()).replace(/\/+$/, "");
  const target = managedDir();
  const root = await state.ensureDir();
  const scratch = await mkdtemp(join(root, ".server-download-"));
  try {
    const bytes = await download(`${baseUrl}/${asset}`);
    const listing = new TextDecoder().decode(await download(`${baseUrl}/checksums.txt`));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedChecksum(listing, asset)) {
      throw new Error(`checksum for ${asset} did not match; refusing to install it`);
    }

    const archive = join(scratch, asset);
    await writeFile(archive, bytes);
    const unpacked = join(scratch, "unpacked");
    await mkdir(unpacked);
    await extract(archive, unpacked);
    for (const required of [SERVER_BINARY, join("web", "index.html")]) {
      if (!existsSync(join(unpacked, required))) throw new Error(`release is missing ${required}`);
    }

    await rm(target, { recursive: true, force: true });
    await rename(unpacked, target);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
