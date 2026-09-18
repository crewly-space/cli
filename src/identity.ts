import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeRawStd, encodeRawStd } from "./b64.ts";
import { isNotFound, writePrivate } from "./fsx.ts";

const SEED_BYTES = 32;
const PUBLIC_BYTES = 32;
/** Go's ed25519.PrivateKeySize — seed followed by the public key. */
const PRIVATE_BYTES = SEED_BYTES + PUBLIC_BYTES;

// Fixed ASN.1 headers for raw Ed25519 keys, so the on-disk format stays a bare seed.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Identity {
  deviceId: string;
  publicKey: Uint8Array;
  publicKeyString(): string;
  sign(payload: Uint8Array): string;
}

interface DiskIdentity {
  privateKey: string;
}

export async function loadOrCreate(dir: string): Promise<Identity> {
  const path = join(dir, "device-key.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw new Error(`read device key: ${(error as Error).message}`);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-SEED_BYTES);
    const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-PUBLIC_BYTES);
    const payload: DiskIdentity = { privateKey: encodeRawStd(Buffer.concat([seed, pub])) };
    try {
      await writePrivate(path, `${JSON.stringify(payload)}\n`);
    } catch (saveError) {
      throw new Error(`save device key: ${(saveError as Error).message}`);
    }
    return fromSeed(seed, pub);
  }

  let disk: DiskIdentity;
  try {
    disk = JSON.parse(raw) as DiskIdentity;
  } catch (error) {
    throw new Error(`decode device key: ${(error as Error).message}`);
  }
  const decoded = Buffer.from(decodeRawStd(disk.privateKey ?? ""));
  if (decoded.length !== PRIVATE_BYTES) throw new Error("device key is invalid");
  return fromSeed(decoded.subarray(0, SEED_BYTES), decoded.subarray(SEED_BYTES));
}

function fromSeed(seed: Buffer, publicKey: Buffer): Identity {
  const key: KeyObject = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const digest = createHash("sha256").update(publicKey).digest();
  return {
    deviceId: `dev_${digest.subarray(0, 10).toString("hex")}`,
    publicKey: new Uint8Array(publicKey),
    publicKeyString: () => encodeRawStd(publicKey),
    sign: (payload: Uint8Array) => encodeRawStd(sign(null, Buffer.from(payload), key)),
  };
}

export function spkiFor(publicKey: Uint8Array): Buffer {
  return Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]);
}
