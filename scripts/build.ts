#!/usr/bin/env bun
/**
 * Cross-compiles the standalone `crewly` binaries the installer downloads.
 * Each target produces one self-contained executable with the Bun runtime embedded,
 * so a user's machine still needs nothing installed.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const [bunMajor, bunMinor] = Bun.version.split(".").map(Number);
if (bunMajor < 1 || (bunMajor === 1 && bunMinor < 4)) {
  console.error(`Bun 1.4 or newer is required to build release binaries (found ${Bun.version})`);
  process.exit(1);
}

interface Target {
  /** Bun's --target triple. */
  target: string;
  /** Release asset name, matching what install.sh and install.ps1 expect. */
  asset: string;
  binary: string;
}

const TARGETS: Target[] = [
  { target: "bun-linux-x64", asset: "crewly_linux_amd64", binary: "crewly" },
  { target: "bun-linux-arm64", asset: "crewly_linux_arm64", binary: "crewly" },
  { target: "bun-darwin-x64", asset: "crewly_darwin_amd64", binary: "crewly" },
  { target: "bun-darwin-arm64", asset: "crewly_darwin_arm64", binary: "crewly" },
  { target: "bun-windows-x64", asset: "crewly_windows_amd64", binary: "crewly.exe" },
];

const OUT_DIR = join(import.meta.dir, "..", "dist");
const requested = process.argv.slice(2);
const selected = requested.length > 0 ? TARGETS.filter((t) => requested.includes(t.target)) : TARGETS;

if (selected.length === 0) {
  console.error(`No matching target. Known: ${TARGETS.map((t) => t.target).join(", ")}`);
  process.exit(1);
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

let failed = false;
for (const { target, asset, binary } of selected) {
  const outfile = join(OUT_DIR, asset, binary);
  process.stdout.write(`  building ${target.padEnd(18)} `);
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      join(import.meta.dir, "..", "src", "index.ts"),
      "--compile",
      `--target=${target}`,
      "--minify",
      "--sourcemap",
      `--outfile=${outfile}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await child.exited;
  if (code !== 0) {
    failed = true;
    console.log("failed");
    console.error((await new Response(child.stderr).text()).trim());
    continue;
  }
  const size = Bun.file(outfile).size || Bun.file(`${outfile}`).size;
  console.log(`${(size / 1_048_576).toFixed(1)} MB → dist/${asset}/${binary}`);
}

if (failed) process.exit(1);
console.log(`\nBuilt ${selected.length} target(s) into dist/`);
