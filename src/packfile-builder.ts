// Build a packfile from a list of object SHA-1s
//
// Two modes:
//   1. Local — reads objects from R2, compresses with WASM, assembles locally
//   2. Fan-out — distributes work to PackWorkerDO pool for parallel assembly
//
// Fan-out activates when PACK_WORKER binding is available and object count
// exceeds FANOUT_THRESHOLD. Each worker reads its own R2 slice, decompresses
// and re-compresses independently, returning a packfile segment.

import type { GitEngine } from "./git-engine";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";

const PACK_SIGNATURE = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"

/** Fan out when object count exceeds this (below this, local is faster). */
const FANOUT_THRESHOLD = 200;

/** Max objects per PackWorkerDO batch. */
const FANOUT_BATCH_SIZE = 500;

/** Max concurrent PackWorkerDO slots. */
const FANOUT_POOL_SIZE = 20;

/** Convert internal object type to packfile type number. */
export function objectToPackType(objType: number): number {
  switch (objType) {
    case OBJ_COMMIT: return 1; // PACK_OBJ_COMMIT
    case OBJ_TREE: return 2;   // PACK_OBJ_TREE
    case OBJ_BLOB: return 3;   // PACK_OBJ_BLOB
    case OBJ_TAG: return 4;    // PACK_OBJ_TAG
    default: throw new Error(`Unknown object type: ${objType}`);
  }
}

export async function buildPackfile(
  engine: GitEngine,
  objectShas: string[],
  packWorker?: DurableObjectNamespace
): Promise<Uint8Array> {
  // Fan-out path: distribute to PackWorkerDO pool
  if (packWorker && objectShas.length > FANOUT_THRESHOLD) {
    return buildPackfileFanout(engine, objectShas, packWorker);
  }

  const wasm = await engine.getWasmPublic();

  // Collect output as array of chunks to avoid buffer-doubling memory spikes.
  // Each batch produces one chunk; final concatenation happens once at the end.
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  let objectCount = 0;

  // Reserve 12 bytes for the header (patched after all objects are counted)
  const header = new Uint8Array(12);
  header.set(PACK_SIGNATURE, 0);
  writeUint32BE(header, 4, 2); // version
  // bytes 8-11 (count) written after loop
  chunks.push(header);
  totalSize += 12;

  // Read objects in batches of 500 to bound memory
  const BATCH = 500;
  for (let i = 0; i < objectShas.length; i += BATCH) {
    const batchShas = objectShas.slice(i, i + BATCH);
    const batchObjects = await engine.readObjects(batchShas);

    for (const sha1 of batchShas) {
      const obj = batchObjects.get(sha1);
      if (!obj) {
        console.error(`buildPackfile: missing object ${sha1}, skipping`);
        continue;
      }

      let compressed: Uint8Array;
      try {
        compressed = wasm.zlibDeflate(obj.content);
      } catch {
        console.error(`buildPackfile: deflate crashed for ${sha1} (${obj.content.length} bytes)`);
        continue;
      }
      if (compressed.length === 0) {
        console.error(`buildPackfile: deflate returned 0 bytes for ${sha1} (${obj.content.length} bytes)`);
        continue;
      }

      const packType = objectToPackType(obj.type);
      const headerLen = typeSizeHeaderLen(obj.content.length);
      const entry = new Uint8Array(headerLen + compressed.length);
      writeTypeSizeHeader(entry, 0, packType, obj.content.length);
      entry.set(compressed, headerLen);
      chunks.push(entry);
      totalSize += entry.length;
      objectCount++;
    }
    // batchObjects goes out of scope here — GC can reclaim decompressed data
  }

  // Write final object count into header
  writeUint32BE(header, 8, objectCount);

  // Concatenate all chunks into final packfile buffer
  const pack = new Uint8Array(totalSize + 20); // +20 for SHA-1 trailer
  let offset = 0;
  for (const chunk of chunks) {
    pack.set(chunk, offset);
    offset += chunk.length;
  }

  // Trailer: SHA-1 of pack content
  const hashBuf = await crypto.subtle.digest("SHA-1", pack.subarray(0, offset));
  pack.set(new Uint8Array(hashBuf), offset);
  offset += 20;

  return pack.subarray(0, offset);
}

export function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >> 24) & 0xff;
  buf[offset + 1] = (value >> 16) & 0xff;
  buf[offset + 2] = (value >> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

export function writeTypeSizeHeader(
  buf: Uint8Array,
  offset: number,
  type: number,
  size: number
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

export function typeSizeHeaderLen(size: number): number {
  let s = size >> 4;
  let len = 1;
  while (s > 0) {
    s >>= 7;
    len++;
  }
  return len;
}

/** Fan-out packfile assembly: scatter object batches to PackWorkerDO pool, gather segments. */
async function buildPackfileFanout(
  engine: GitEngine,
  objectShas: string[],
  packWorker: DurableObjectNamespace
): Promise<Uint8Array> {
  // Look up R2 chunk metadata for all SHAs so workers know where to read
  const descriptors = engine.lookupChunkMeta(objectShas);

  // Split into batches, assign round-robin to pool slots
  const batches: Array<{ slotIndex: number; objects: typeof descriptors }> = [];
  for (let i = 0; i < descriptors.length; i += FANOUT_BATCH_SIZE) {
    const slotIndex = batches.length % FANOUT_POOL_SIZE;
    batches.push({ slotIndex, objects: descriptors.slice(i, i + FANOUT_BATCH_SIZE) });
  }

  // Fan out to PackWorkerDO pool via Promise.allSettled
  const results = await Promise.allSettled(
    batches.map(async ({ slotIndex, objects }) => {
      const id = packWorker.idFromName(`pack-slot-${slotIndex}`);
      const worker = packWorker.get(id);
      const resp = await worker.fetch("https://pack-worker/build", {
        method: "POST",
        headers: { "x-action": "build-segment" },
        body: JSON.stringify({ repoPath: engine.repoPath, objects }),
      });
      if (!resp.ok) throw new Error(`PackWorkerDO slot ${slotIndex}: ${resp.status}`);
      const count = parseInt(resp.headers.get("x-object-count") ?? "0", 10);
      const segment = new Uint8Array(await resp.arrayBuffer());
      return { segment, count };
    })
  );

  // Gather segments, log failures
  const segments: Uint8Array[] = [];
  let objectCount = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      segments.push(r.value.segment);
      objectCount += r.value.count;
    } else {
      console.error(`PackWorkerDO batch ${i} failed: ${r.reason}`);
    }
  }

  // Assemble final packfile: header + segments + SHA-1 trailer
  let totalSize = 12; // header
  for (const seg of segments) totalSize += seg.length;

  const pack = new Uint8Array(totalSize + 20); // +20 for SHA-1 trailer
  pack.set(PACK_SIGNATURE, 0);
  writeUint32BE(pack, 4, 2); // version 2
  writeUint32BE(pack, 8, objectCount);

  let offset = 12;
  for (const seg of segments) {
    pack.set(seg, offset);
    offset += seg.length;
  }

  // SHA-1 trailer over pack content
  const hashBuf = await crypto.subtle.digest("SHA-1", pack.subarray(0, offset));
  pack.set(new Uint8Array(hashBuf), offset);
  offset += 20;

  return pack.subarray(0, offset);
}
