import { readFile, writeFile } from "node:fs/promises";
import * as state from "./state.ts";

export async function backup(args: string[]): Promise<void> {
  const [target] = args;
  if (args.length !== 1 || !target) throw new Error("usage: opencrew backup <file>");
  const config = await state.load();
  const omitted = config.providers.filter((provider) => provider.secretRef).length;
  config.providers = config.providers.filter((provider) => !provider.secretRef);
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Backup created: ${target}`);
  if (omitted > 0) {
    console.log(`API credentials were excluded. Reconnect ${omitted} provider(s) after restore.`);
  }
}

export async function restore(args: string[]): Promise<void> {
  const [source] = args;
  if (args.length !== 1 || !source) throw new Error("usage: opencrew restore <file>");
  const config = JSON.parse(await readFile(source, "utf8")) as state.Config;
  if (config.version !== 1) throw new Error("unsupported backup version");
  await state.save(config);
  console.log("Configuration restored. Run 'opencrew doctor' to verify this device.");
}
