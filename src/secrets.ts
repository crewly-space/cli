import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeRawStd, encodeRawStd } from "./b64.ts";
import { isNotFound, writePrivate } from "./fsx.ts";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

interface Envelope {
  nonce: string;
  ciphertext: string;
}

export class Store {
  constructor(private readonly dir: string) {}

  async put(ref: string, secret: Uint8Array): Promise<void> {
    if (!validRef(ref) || secret.length === 0) {
      throw new Error("secret reference and value are required");
    }
    const key = await this.key();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(ref, "utf8"));
    // Go's GCM Seal appends the auth tag to the ciphertext; keep the same layout.
    const sealed = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
    const envelope: Envelope = {
      nonce: encodeRawStd(nonce),
      ciphertext: encodeRawStd(sealed),
    };
    await writePrivate(join(this.dir, `secret-${ref}.json`), `${JSON.stringify(envelope)}\n`);
  }

  async get(ref: string): Promise<Uint8Array> {
    if (!validRef(ref)) throw new Error("invalid secret reference");
    const raw = await readFile(join(this.dir, `secret-${ref}.json`), "utf8");
    const envelope = JSON.parse(raw) as Envelope;
    const nonce = decodeRawStd(envelope.nonce);
    const sealed = decodeRawStd(envelope.ciphertext);
    if (sealed.length < TAG_BYTES) throw new Error("credential could not be decrypted");
    const key = await this.key();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(ref, "utf8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    try {
      return new Uint8Array(
        Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]),
      );
    } catch {
      throw new Error("credential could not be decrypted");
    }
  }

  private async key(): Promise<Buffer> {
    const path = join(this.dir, "credential-key");
    try {
      const existing = await readFile(path);
      if (existing.length !== KEY_BYTES) throw new Error("credential key has invalid length");
      return existing;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const key = randomBytes(KEY_BYTES);
    try {
      await writePrivate(path, key);
    } catch (error) {
      throw new Error(`save credential key: ${(error as Error).message}`);
    }
    return key;
  }
}

export function validRef(ref: string): boolean {
  if (ref === "" || ref.length > 80) return false;
  return /^[A-Za-z0-9_-]+$/.test(ref);
}
