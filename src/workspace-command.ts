import * as state from "./state.ts";
import { readLine } from "./tty.ts";
import { dim, green } from "./ui.ts";
import * as workspace from "./workspace.ts";

export async function command(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action) throw new Error("usage: crewly workspace add|list|rename|remove");
  const config = await state.load();
  switch (action) {
    case "list":
      if (config.workspaces.length === 0) {
        console.log(`No workspaces yet. ${dim("Add one with: crewly workspace add")}`);
        return;
      }
      for (const entry of config.workspaces) {
        console.log(`  ${green("•")} ${entry.name.padEnd(20)} ${dim(entry.path)}`);
        console.log(`  ${dim("read allow · write ask · shell ask · git push deny")}`);
      }
      return;
    case "add": {
      const path = rest[0] ?? (await readLine("Workspace path: "));
      const entry = workspace.add(config, path, rest.slice(1).join(" "), { allowBroad: true });
      await state.save(config);
      console.log(`${green("✓")} Added ${entry.name} ${dim(entry.path)}`);
      console.log(`  ${dim("read allow · write ask · shell ask · git push deny")}`);
      return;
    }
    case "rename": {
      const [ref, ...name] = rest;
      if (!ref || name.length === 0) throw new Error("usage: crewly workspace rename <name|path> <new name>");
      const entry = workspace.rename(config, ref, name.join(" "));
      await state.save(config);
      console.log(`${green("✓")} Renamed to ${entry.name} ${dim(entry.path)}`);
      return;
    }
    case "remove":
    case "rm": {
      if (!rest[0]) throw new Error("usage: crewly workspace remove <name|path>");
      const entry = workspace.remove(config, rest[0]);
      await state.save(config);
      console.log(`${green("✓")} Removed ${entry.name} ${dim("— the folder itself was not touched")}`);
      return;
    }
    default:
      throw new Error(`unknown workspace command "${action}"`);
  }
}
