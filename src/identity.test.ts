import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRawStd } from "./b64.ts";
import { loadOrCreate } from "./identity.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewly-id-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/**
 * Vectors produced by the Go implementation this module replaces. They pin the on-disk
 * formats so an existing install keeps working after the switch to Bun.
 */
const GO_SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i));
const GO_PUBLIC = "C7w0aldmfDgBIL2cf9flHSxf3+o3zS9b9AWyxr9vLXg";
const GO_PRIVATE64 =
  "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoMLvDRqV2Z8OAEgvZx/1+UdLF/f6jfNL1v0BbLGv28teA";
const GO_DEVICE_ID = "dev_5540ee3de4e095226605";
const GO_SIGNATURE =
  "0EU/S0RMh8hJpo3DQax7IQBhL5NyiO3WiH7h2gqpTwnDvE7mKyji/nsIDwXMIs1hFod1sFrYdGxEn/0WnYEkAQ";

describe("identity", () => {
  test("reads a device key written by the Go build", async () => {
    const dir = tempDir();
    await Bun.write(join(dir, "device-key.json"), JSON.stringify({ privateKey: GO_PRIVATE64 }));
    const id = await loadOrCreate(dir);
    expect(id.deviceId).toBe(GO_DEVICE_ID);
    expect(id.publicKeyString()).toBe(GO_PUBLIC);
    expect(id.sign(new TextEncoder().encode("payload"))).toBe(GO_SIGNATURE);
  });

  test("creates a key that round-trips across restarts", async () => {
    const dir = tempDir();
    const created = await loadOrCreate(dir);
    const reloaded = await loadOrCreate(dir);
    expect(reloaded.deviceId).toBe(created.deviceId);
    expect(reloaded.publicKeyString()).toBe(created.publicKeyString());
    expect(created.deviceId).toMatch(/^dev_[0-9a-f]{20}$/);
  });

  test("stores the 64-byte seed-and-public-key layout Go expects", async () => {
    const dir = tempDir();
    await loadOrCreate(dir);
    const disk = JSON.parse(readFileSync(join(dir, "device-key.json"), "utf8")) as { privateKey: string };
    expect(Buffer.from(disk.privateKey, "base64")).toHaveLength(64);
    expect(disk.privateKey).not.toMatch(/=/);
  });

  test("rejects a malformed device key", async () => {
    const dir = tempDir();
    await Bun.write(join(dir, "device-key.json"), JSON.stringify({ privateKey: "too-short" }));
    await expect(loadOrCreate(dir)).rejects.toThrow(/device key is invalid/);
  });
});

describe("secret envelope compatibility", () => {
  test("matches the Go AES-256-GCM layout", () => {
    // Go appends the GCM tag to the ciphertext; this vector came from the Go build.
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const nonce = Buffer.from(Array.from({ length: 12 }, (_, i) => 200 + i));
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("sec_abc123", "utf8"));
    const sealed = Buffer.concat([
      cipher.update(Buffer.from("super-secret-api-key")),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expect(encodeRawStd(sealed)).toBe("Yg0RvvThiEUXTnrKM2ebfc3sidHbBU9WFSAqeyTyiHR+qB1E");
  });

  test("the Go seed derives the Go public key", async () => {
    const dir = tempDir();
    await Bun.write(
      join(dir, "device-key.json"),
      JSON.stringify({ privateKey: encodeRawStd(Buffer.concat([GO_SEED, Buffer.from(GO_PUBLIC, "base64")])) }),
    );
    expect((await loadOrCreate(dir)).publicKeyString()).toBe(GO_PUBLIC);
  });
});
