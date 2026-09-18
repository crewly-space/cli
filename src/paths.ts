import { homedir } from "node:os";
import { join } from "node:path";

/** Mirrors Go's os.UserConfigDir across the three platforms agentd supports. */
export function userConfigDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("%AppData% is not defined");
    return appData;
  }
  if (process.platform === "darwin") return join(home, "Library", "Application Support");
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.startsWith("/")) return xdg;
  return join(home, ".config");
}

export const isWindows = process.platform === "win32";
