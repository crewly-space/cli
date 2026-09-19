#!/usr/bin/env node
/*
 * Refresh the vendored copies of code this repository does not own.
 *
 * Crewly is split across four repositories with no shared workspace. Each
 * shared piece has exactly one owning repository; every other repository
 * commits a copy, so `npm ci`, Docker builds and fresh clones all work with no
 * sibling checkout present.
 *
 *   npm run vendor:sync     refresh from the sibling checkout, then commit
 *   npm run vendor:check    fail if the committed copy has drifted (CI)
 *
 * With no sibling checked out, sync is a no-op and keeps the committed copy.
 * The manifest lives in the "vendor" field of package.json.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).vendor ?? [];
const check = process.argv.includes("--check");

/*
 * Tests belong to the owning repository and are run there. Copying them would
 * drag that repo's test runner into every consumer's typecheck.
 */
const isVendorable = (file) => !/\.test\.[cm]?tsx?$/.test(file);

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((entry) => {
        const p = join(dir, entry);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

const digest = (dir) => {
  const hash = createHash("sha256");
  for (const file of walk(dir).filter(isVendorable).sort()) {
    hash.update(file.slice(dir.length).split(sep).join("/"));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
};

let drifted = 0;
for (const { owner, from, to } of manifest) {
  const source = resolve(repoRoot, from);
  const target = resolve(repoRoot, to);

  if (!existsSync(source)) {
    console.log(`vendor: ${owner} is not checked out alongside this repo; keeping committed ${to}`);
    continue;
  }

  if (check) {
    if (digest(source) === digest(target)) {
      console.log(`vendor: ${to} matches ${owner}`);
    } else {
      console.error(`vendor: DRIFT in ${to} -- run 'npm run vendor:sync' and commit the result`);
      drifted += 1;
    }
    continue;
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, filter: (from) => statSync(from).isDirectory() || isVendorable(from) });
  console.log(`vendor: refreshed ${to} from ${owner}`);
}

process.exit(drifted > 0 ? 1 : 0);
