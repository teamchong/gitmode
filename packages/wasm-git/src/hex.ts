// Fast hex encoding using a lookup table — avoids Array.from().map().join()
// which creates intermediate arrays and strings per byte.

const HEX_TABLE: string[] = new Array(256);
for (let i = 0; i < 256; i++) {
  HEX_TABLE[i] = i.toString(16).padStart(2, "0");
}

/** Convert a byte array to a hex string using a pre-computed lookup table. */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX_TABLE[bytes[i]];
  }
  return hex;
}
