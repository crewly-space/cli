import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { defaultPermissions, type Workspace } from "./state.ts";

export function register(path: string, name: string): Workspace {
  const canonicalPath = canonical(path);
  let info;
  try {
    info = statSync(canonicalPath);
  } catch (error) {
    throw new Error(`inspect workspace: ${(error as Error).message}`);
  }
  if (!info.isDirectory()) throw new Error("workspace must be a directory");
  const label = name.trim() === "" ? basename(canonicalPath) : name;
  const digest = createHash("sha256").update(canonicalPath.toLowerCase()).digest("hex");
  return {
    id: `ws_${digest.slice(0, 16)}`,
    name: label,
    path: canonicalPath,
    permissions: defaultPermissions(),
    addedAt: new Date().toISOString(),
  };
}

export function canonical(path: string): string {
  if (path.trim() === "") throw new Error("workspace path is required");
  const absolute = resolve(path);
  try {
    return normalize(realpathSync(absolute));
  } catch (error) {
    throw new Error(`resolve workspace links: ${(error as Error).message}`);
  }
}

/**
 * Resolves `requested` inside `root`, refusing anything that escapes it. The closest existing
 * parent is resolved first so a not-yet-created file cannot be reached through a symlink.
 */
export function resolveWithin(root: string, requested: string): string {
  const canonicalRoot = canonical(root);
  const candidate = isAbsolute(requested) ? requested : join(canonicalRoot, requested);
  const absolute = resolve(candidate);

  let probe = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`inspect requested path: ${(error as Error).message}`);
      }
    }
    const parent = dirname(probe);
    if (parent === probe) throw new Error("requested path has no existing parent");
    suffix.unshift(basename(probe));
    probe = parent;
  }

  let realParent: string;
  try {
    realParent = realpathSync(probe);
  } catch (error) {
    throw new Error(`resolve requested path links: ${(error as Error).message}`);
  }
  const resolved = join(realParent, ...suffix);
  const rel = relative(canonicalRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("requested path escapes workspace");
  }
  return normalize(resolved);
}
