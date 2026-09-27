import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWindows } from "./paths.ts";
import * as state from "./state.ts";
import { secureHttpUrl } from "./urls.ts";

const REPOSITORY = "crewly-space/server";

export const SERVER_BINARY = isWindows ? "crewly-server.exe" : "crewly-server";

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

/** The release asset for a platform, named as crewly-server's package-release.sh names it. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  const os = OS_NAMES[platform];
  const cpu = ARCH_NAMES[arch];
  if (!os || !cpu || (os === "windows" && cpu !== "amd64")) {
    throw new Error(`no Crewly server release is published for ${os ?? platform}/${cpu ?? arch}`);
  }
  return `crewly-server_${os}_${cpu}.${os === "windows" ? "zip" : "tar.gz"}`;
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
  const override = process.env.CREWLY_RELEASE_BASE_URL;
  if (override) return override;
  const version = process.env.CREWLY_VERSION || "latest";
  return version === "latest"
    ? `https://github.com/${REPOSITORY}/releases/latest/download`
    : `https://github.com/${REPOSITORY}/releases/download/${version}`;
}

async function download(url: string, asset?: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (response.ok) return new Uint8Array(await response.arrayBuffer());
  // A 404 here is not a broken link: the URL is built from the platform, so it
  // means the latest release publishes nothing under that name. Saying "HTTP
  // 404" sends people looking for a bug in their network instead.
  if (response.status === 404) {
    throw new Error(
      `the latest Crewly server release does not publish ${asset ?? url.split("/").pop()}. ` +
        `Check https://github.com/${REPOSITORY}/releases, or set CREWLY_VERSION to a release that has it.`,
    );
  }
  throw new Error(`download of ${url} failed: HTTP ${response.status}`);
}

// Windows ships bsdtar in System32, which reads zips. Anything else named `tar`
// on PATH (Git Bash's GNU tar, for one) cannot.
function tarBinary(): string {
  return isWindows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

async function extract(archive: string, into: string): Promise<void> {
  const names = Bun.spawn([tarBinary(), "-tf", archive], { stdout: "pipe", stderr: "pipe" });
  const [listing, listError, listCode] = await Promise.all([
    new Response(names.stdout).text(), new Response(names.stderr).text(), names.exited,
  ]);
  if (listCode !== 0) throw new Error(`could not inspect ${archive}: ${listError.trim()}`);
  for (const raw of listing.split(/\r?\n/).filter(Boolean)) {
    const entry = raw.replaceAll('\\', '/').replace(/^\.\//, '');
    if (entry.startsWith('/') || /^[A-Za-z]:\//.test(entry) || entry.split('/').includes('..')) {
      throw new Error(`release archive contains an unsafe path: ${raw}`);
    }
  }
  const details = Bun.spawn([tarBinary(), "-tvf", archive], { stdout: "pipe", stderr: "pipe" });
  const [verbose, detailError, detailCode] = await Promise.all([
    new Response(details.stdout).text(), new Response(details.stderr).text(), details.exited,
  ]);
  if (detailCode !== 0) throw new Error(`could not inspect ${archive}: ${detailError.trim()}`);
  if (verbose.split(/\r?\n/).some((line) => /^[lh]/.test(line))) {
    throw new Error('release archive contains links, which are not allowed');
  }
  const child = Bun.spawn([tarBinary(), "-xf", archive, "-C", into, "--no-same-owner", "--no-same-permissions"], { stdout: "ignore", stderr: "pipe" });
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
export async function install(options: { baseUrl?: string; publicKey?: string } = {}): Promise<void> {
  const asset = assetName();
  const baseUrl = (options.baseUrl ?? releaseUrl()).replace(/\/+$/, "");
  secureHttpUrl(baseUrl, 'release URL');
  const trustedKey = options.publicKey ?? process.env.CREWLY_RELEASE_PUBLIC_KEY;
  if (!trustedKey) throw new Error('CREWLY_RELEASE_PUBLIC_KEY is required to authenticate server releases');
  const target = managedDir();
  const root = await state.ensureDir();
  const scratch = await mkdtemp(join(root, ".server-download-"));
  try {
    const bytes = await download(`${baseUrl}/${asset}`, asset);
    const listing = new TextDecoder().decode(await download(`${baseUrl}/checksums.txt`, "checksums.txt"));
    const manifestSignature = await download(`${baseUrl}/checksums.txt.sig`, 'checksums.txt.sig');
    let publisherKey;
    try {
      const raw = Buffer.from(trustedKey, 'base64');
      if (raw.length !== 32) throw new Error('wrong key length');
      publisherKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    } catch {
      throw new Error('CREWLY_RELEASE_PUBLIC_KEY must be a base64 Ed25519 public key');
    }
    if (!verify(null, Buffer.from(listing, 'utf8'), publisherKey, manifestSignature)) {
      throw new Error('release manifest signature did not match the trusted publisher key');
    }
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
