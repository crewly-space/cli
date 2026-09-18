import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isWindows } from "./paths.ts";

/** Writes a file that only the owner can read. chmod is a no-op on Windows, as in the Go build. */
export async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  if (!isWindows) await chmod(path, 0o600);
}

export async function ensureDirPrivate(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!isWindows) await chmod(path, 0o700).catch(() => {});
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
