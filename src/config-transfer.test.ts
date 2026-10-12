import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, restore } from './config-transfer.ts';
import * as state from './state.ts';

let directory: string;
let previousHome: string | undefined;
beforeEach(async () => {
  previousHome = process.env.CREWLY_HOME;
  directory = await mkdtemp(join(tmpdir(), 'crewly-config-transfer-'));
  process.env.CREWLY_HOME = directory;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CREWLY_HOME;
  else process.env.CREWLY_HOME = previousHome;
  await rm(directory, { recursive: true, force: true });
});

describe('configuration backups', () => {
  test('restores the version 2 backup it writes without exporting API credentials', async () => {
    const config = await state.load();
    config.deviceName = 'Saved device';
    config.providers = [{ id: 'secret-provider', kind: 'openai', label: 'Private key', secretRef: 'credentials/openai', localOnly: false, createdAt: new Date().toISOString() }];
    await state.save(config);
    const archive = join(directory, 'backup.json');
    await backup([archive]);
    expect(JSON.parse(await readFile(archive, 'utf8'))).toMatchObject({ version: 2, providers: [] });
    config.deviceName = 'Changed device';
    await state.save(config);
    await restore([archive]);
    expect((await state.load()).deviceName).toBe('Saved device');
    expect((await state.load()).providers).toEqual([]);
  });

  test('keeps support for legacy version 1 backups', async () => {
    const config = { ...await state.load(), version: 1, deviceName: 'Legacy device' };
    const archive = join(directory, 'legacy.json');
    await writeFile(archive, JSON.stringify(config));
    await restore([archive]);
    expect((await state.load()).deviceName).toBe('Legacy device');
  });

  test('rejects unknown backup versions without overwriting current settings', async () => {
    const config = await state.load();
    config.deviceName = 'Keep this device';
    await state.save(config);
    const archive = join(directory, 'unknown.json');
    await writeFile(archive, JSON.stringify({ ...config, version: 999, deviceName: 'Wrong device' }));
    await expect(restore([archive])).rejects.toThrow('unsupported backup version');
    expect((await state.load()).deviceName).toBe('Keep this device');
  });
});
