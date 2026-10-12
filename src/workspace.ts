import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { defaultPermissions, type Config, type Workspace } from "./state.ts";

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
  const absolute = resolve(expandHome(path.trim()));
  try {
    return normalize(realpathSync(absolute));
  } catch (error) {
    throw new Error(`resolve workspace links: ${(error as Error).message}`);
  }
}

/** `~` and `~/…` mean the home folder, as they do in a shell. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** Adds a folder, refusing one already added. `broad` folders are refused unless the person is at this device. */
export function add(config: Config, path: string, name = "", options: { allowBroad?: boolean } = {}): Workspace {
  const entry = register(path, name);
  if (!options.allowBroad && (entry.path === parse(entry.path).root || entry.path === canonical(homedir()))) {
    throw new Error("pick a project folder, not the whole disk or home folder");
  }
  const existing = config.workspaces.find((candidate) => candidate.id === entry.id);
  if (existing) throw new Error(`${existing.path} is already a workspace, named "${existing.name}"`);
  config.workspaces.push(entry);
  return entry;
}

/** Finds a workspace by id, name or path. */
export function find(config: Config, ref: string): Workspace {
  const match = config.workspaces.find((candidate) => candidate.id === ref)
    ?? config.workspaces.find((candidate) => candidate.name === ref)
    ?? config.workspaces.find((candidate) => { try { return candidate.path === canonical(ref); } catch { return false; } });
  if (!match) throw new Error(`no workspace "${ref}"`);
  return match;
}

export function rename(config: Config, ref: string, name: string): Workspace {
  const label = name.trim();
  if (label === "") throw new Error("workspace name is required");
  if (label.length > 100) throw new Error("workspace name is too long");
  const entry = find(config, ref);
  entry.name = label;
  return entry;
}

/** Stops sharing the folder. The folder itself is left alone. */
export function remove(config: Config, ref: string): Workspace {
  const entry = find(config, ref);
  config.workspaces = config.workspaces.filter((candidate) => candidate.id !== entry.id);
  return entry;
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
