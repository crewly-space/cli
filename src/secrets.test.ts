import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./secrets.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencrew-secrets-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("secrets store", () => {
  test("round-trips a secret without writing plaintext", async () => {
    const dir = tempDir();
    const store = new Store(dir);
    const want = "sk-test-secret";
    await store.put("provider", new TextEncoder().encode(want));

    const raw = readFileSync(join(dir, "secret-provider.json"), "utf8");
    expect(raw).not.toContain(want);

    const got = new TextDecoder().decode(await store.get("provider"));
    expect(got).toBe(want);
  });

  test("rejects traversal in a secret reference", async () => {
    const store = new Store(tempDir());
    await expect(store.put("../../outside", new TextEncoder().encode("secret"))).rejects.toThrow();
    await expect(store.get("../outside")).rejects.toThrow();
  });

  test("rejects an empty secret", async () => {
    const store = new Store(tempDir());
    await expect(store.put("provider", new Uint8Array())).rejects.toThrow();
  });

  test("refuses to decrypt a tampered envelope", async () => {
    const dir = tempDir();
    const store = new Store(dir);
    await store.put("provider", new TextEncoder().encode("sk-test-secret"));
    const path = join(dir, "secret-provider.json");
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { nonce: string; ciphertext: string };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] as number) ^ 0xff;
    envelope.ciphertext = bytes.toString("base64").replace(/=+$/, "");
    await Bun.write(path, JSON.stringify(envelope));
    await expect(store.get("provider")).rejects.toThrow(/could not be decrypted/);
  });

  test("a secret sealed under one reference cannot be read under another", async () => {
    const dir = tempDir();
    const store = new Store(dir);
    await store.put("alpha", new TextEncoder().encode("sk-alpha"));
    const raw = readFileSync(join(dir, "secret-alpha.json"), "utf8");
    await Bun.write(join(dir, "secret-beta.json"), raw);
    await expect(store.get("beta")).rejects.toThrow(/could not be decrypted/);
  });
});
