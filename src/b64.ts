/** Go's base64.RawStdEncoding: standard alphabet, no padding. */
export function encodeRawStd(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

export function decodeRawStd(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
