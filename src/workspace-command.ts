import * as state from "./state.ts";
import { readLine } from "./tty.ts";
import * as workspace from "./workspace.ts";

export async function command(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action) throw new Error("usage: opencrew workspace add|list");
  const config = await state.load();
  switch (action) {
    case "list":
      if (config.workspaces.length === 0) {
        console.log("No workspaces yet. Add one with: opencrew workspace add");
        return;
      }
      for (const entry of config.workspaces) {
        console.log(`${entry.name.padEnd(20)} ${entry.path}`);
        console.log("  read allow · write ask · shell ask · git push deny");
      }
      return;
    case "add": {
      const path = rest[0] ?? (await readLine("Workspace path: "));
      const entry = workspace.register(path, "");
      if (config.workspaces.some((existing) => existing.id === entry.id)) {
        throw new Error("workspace is already registered");
      }
      config.workspaces.push(entry);
      await state.save(config);
      console.log(`✓ Added ${entry.path}`);
      console.log("  read allow · write ask · shell ask · git push deny");
      return;
    }
    default:
      throw new Error(`unknown workspace command "${action}"`);
  }
}
