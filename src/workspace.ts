import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { defaultPermissions, dir as stateDir, type Config, type Workspace } from "./state.ts";

/** The home folder, from the environment first as Node's homedir() does on POSIX; Bun caches its own. */
const home = () => process.env.HOME || process.env.USERPROFILE || homedir();

/** The real path, in the case the file system stores it, so comparisons cannot be fooled by `/USERS/me`. */
const realpath = (path: string) => realpathSync.native(path);

/** Control characters, and the bidi overrides that can disguise text, never belong in a name. */
export function cleanName(name: string): string {
  return name.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "").trim();
}

export function register(path: string, name: string): Workspace {
  const canonicalPath = canonical(path);
  let info;
  try {
    info = statSync(canonicalPath);
  } catch (error) {
    throw new Error(`inspect workspace: ${(error as Error).message}`);
  }
  if (!info.isDirectory()) throw new Error("workspace must be a directory");
  const label = cleanName(name) || cleanName(basename(canonicalPath)) || "workspace";
  if (label.length > 100) throw new Error("workspace name is too long");
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
    return normalize(realpath(absolute));
  } catch (error) {
    throw new Error(`resolve workspace links: ${(error as Error).message}`);
  }
}

/** `~` and `~/…` mean the home folder, as they do in a shell. */
export function expandHome(path: string): string {
  if (path === "~") return home();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home(), path.slice(2));
  return path;
}

/*
 * Case is folded only where the file system ignores it. On Linux /home/Me
 * and /home/me are different folders -- folding there would let one pass
 * for being inside the other.
 */
const fold = (path: string) => process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;

/** Whether `inner` is `outer` or inside it. */
function within(inner: string, outer: string): boolean {
  const rel = relative(fold(outer), fold(inner));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/*
 * Somebody asking from the app is not sitting at this device, so they may
 * only share a project folder inside the home folder: never the home folder
 * itself or anything above it, no hidden folder (~/.ssh, ~/.aws, …), no
 * Library or AppData, and nothing that holds or sits inside crewly's own
 * configuration, where this device's key lives.
 */
function assertShareableFromAfar(path: string): void {
  const root = canonical(home());
  const refuse = () => { throw new Error("pick a project folder inside your home folder, not a system, hidden or settings folder"); };
  if (!within(path, root) || within(root, path)) refuse();
  const segments = relative(fold(root), fold(path)).split(sep);
  if (segments.some((segment) => segment.startsWith("."))) refuse();
  if (["library", "appdata"].includes(segments[0]!.toLowerCase())) refuse();
  let crewly = resolve(stateDir());
  try { crewly = canonical(crewly); } catch { /* not created yet: compare as written */ }
  if (within(path, crewly) || within(crewly, path)) refuse();
}

/**
 * Adds a folder, refusing one already added. `fromAfar` is a request from the
 * app rather than from somebody at this device, and is held to a narrower rule.
 */
export function add(config: Config, path: string, name = "", options: { fromAfar?: boolean } = {}): Workspace {
  const entry = register(path, name);
  if (options.fromAfar) assertShareableFromAfar(entry.path);
  const existing = config.workspaces.find((candidate) => candidate.id === entry.id);
  if (existing) throw new Error(`${existing.path} is already a workspace, named "${existing.name}"`);
  config.workspaces.push(entry);
  return entry;
}

/** Finds a workspace by id or, for somebody at this device, by name or path too. */
export function find(config: Config, ref: string, options: { idOnly?: boolean } = {}): Workspace {
  const byId = config.workspaces.find((candidate) => candidate.id === ref);
  if (byId || options.idOnly) {
    if (!byId) throw new Error("that workspace is not on this device");
    return byId;
  }
  const match = config.workspaces.find((candidate) => candidate.name === ref)
    ?? config.workspaces.find((candidate) => { try { return candidate.path === canonical(ref); } catch { return false; } });
  if (!match) throw new Error(`no workspace "${ref}"`);
  return match;
}

export function rename(config: Config, ref: string, name: string, options: { idOnly?: boolean } = {}): Workspace {
  const label = cleanName(name);
  if (label === "") throw new Error("workspace name is required");
  if (label.length > 100) throw new Error("workspace name is too long");
  const entry = find(config, ref, options);
  entry.name = label;
  return entry;
}

/** Stops sharing the folder. The folder itself is left alone. */
export function remove(config: Config, ref: string, options: { idOnly?: boolean } = {}): Workspace {
  const entry = find(config, ref, options);
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
    realParent = realpath(probe);
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
