// Pack-format encoding helpers and git object type constants.
//
// Extracted from the original gitmode `git-engine.ts` and `packfile-builder.ts`
// so that `pack-worker.ts` can be packaged without dragging in the full
// orchestration layer that gets retired in Phase 5.

/** Internal git object type codes — used by both R2 storage and pack workers. */
export const OBJ_BLOB = 1;
export const OBJ_TREE = 2;
export const OBJ_COMMIT = 3;
export const OBJ_TAG = 4;

/**
 * Convert internal object type code to packfile entry type number.
 * Packfile types differ from internal codes: commit=1, tree=2, blob=3, tag=4.
 */
export function objectToPackType(objType: number): number {
  switch (objType) {
    case OBJ_COMMIT:
      return 1;
    case OBJ_TREE:
      return 2;
    case OBJ_BLOB:
      return 3;
    case OBJ_TAG:
      return 4;
    default:
      throw new Error(`Unknown object type: ${objType}`);
  }
}

/**
 * Write a packfile entry header (type + variable-length size) into `buf` at
 * `offset`. Returns the number of bytes written.
 */
export function writeTypeSizeHeader(
  buf: Uint8Array,
  offset: number,
  type: number,
  size: number,
): number {
  let s = size;
  let byte = ((type & 0x07) << 4) | (s & 0x0f);
  s >>= 4;

  let pos = 0;
  if (s > 0) byte |= 0x80;
  buf[offset + pos] = byte;
  pos++;

  while (s > 0) {
    byte = s & 0x7f;
    s >>= 7;
    if (s > 0) byte |= 0x80;
    buf[offset + pos] = byte;
    pos++;
  }

  return pos;
}

/** Compute how many bytes `writeTypeSizeHeader` will produce for a given size. */
export function typeSizeHeaderLen(size: number): number {
  let s = size >> 4;
  let len = 1;
  while (s > 0) {
    s >>= 7;
    len++;
  }
  return len;
}

/** Big-endian uint32 write helper, used by packfile builders. */
export function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >> 24) & 0xff;
  buf[offset + 1] = (value >> 16) & 0xff;
  buf[offset + 2] = (value >> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}
