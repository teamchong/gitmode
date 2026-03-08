// POST /git-upload-pack — handles clone and fetch
//
// Client sends:
//   want <sha1> [capabilities]\n
//   want <sha1>\n
//   ...
//   0000 (flush)
//   have <sha1>\n  (for fetch, not clone)
//   ...
//   done\n
//   0000 (flush)
//
// Server responds with packfile containing requested objects.

import type { GitEngine } from "./git-engine";
import { OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";
import { decodePktLine, encodePktLine, encodePktLineBytes, FLUSH_PKT } from "./pkt-line";
import { buildPackfile } from "./packfile-builder";
import { toHex } from "./hex";

const decoder = new TextDecoder();

export async function handleUploadPack(
  engine: GitEngine,
  body: Uint8Array
): Promise<Response> {
  // Parse wants and haves from client request
  const wants: string[] = [];
  const haves = new Set<string>();
  let offset = 0;

  // Parse want lines
  while (offset < body.length) {
    const pkt = decodePktLine(body, offset);
    if (!pkt) break;
    offset = pkt.nextOffset;

    if (pkt.type === "flush") break;
    if (pkt.type !== "data" || !pkt.payload) continue;

    const line = decoder.decode(pkt.payload).trimEnd();
    if (line.startsWith("want ")) {
      // "want <sha1>" or "want <sha1> <capabilities>"
      const sha1 = line.slice(5, 45);
      wants.push(sha1);
    }
  }

  // Parse have lines
  while (offset < body.length) {
    const pkt = decodePktLine(body, offset);
    if (!pkt) break;
    offset = pkt.nextOffset;

    if (pkt.type === "flush") break;
    if (pkt.type !== "data" || !pkt.payload) continue;

    const line = decoder.decode(pkt.payload).trimEnd();
    if (line.startsWith("have ")) {
      haves.add(line.slice(5, 45));
    }
    if (line === "done") break;
  }

  if (wants.length === 0) {
    return new Response(encodePktLine("ERR no wants\n"), { status: 400 });
  }

  // Verify which haves the server actually knows about
  let commonSha: string | null = null;
  if (haves.size > 0) {
    const checks = await Promise.all(
      [...haves].map(sha => engine.hasObject(sha).then(exists => ({ sha, exists })))
    );
    const found = checks.find(c => c.exists);
    if (found) commonSha = found.sha;
  }

  // Collect all objects needed: walk from wants, stop at haves
  const needed = await collectObjects(engine, wants, haves);

  // Build packfile — reads objects in batches to bound memory
  const packData = await buildPackfile(engine, needed);

  // Response: ACK (if common commits found) or NAK + packfile in sideband-64k
  const ackOrNak = commonSha
    ? encodePktLine(`ACK ${commonSha}\n`)
    : encodePktLine("NAK\n");

  // Wrap packfile in sideband-64k framing via ReadableStream.
  // Note: start() enqueues all chunks synchronously, so peak memory is ~2x packData
  // (original + sideband-wrapped). The runtime drains the stream over the wire.
  const MAX_SIDEBAND_DATA = 65515;
  const readable = new ReadableStream({
    start(controller) {
      // ACK or NAK
      controller.enqueue(ackOrNak);

      // Packfile in sideband channel 1
      let packOffset = 0;
      while (packOffset < packData.length) {
        const chunkLen = Math.min(packData.length - packOffset, MAX_SIDEBAND_DATA);
        const payload = new Uint8Array(1 + chunkLen);
        payload[0] = 0x01;
        payload.set(packData.subarray(packOffset, packOffset + chunkLen), 1);
        controller.enqueue(encodePktLineBytes(payload));
        packOffset += chunkLen;
      }

      // Flush
      controller.enqueue(FLUSH_PKT);
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      "Cache-Control": "no-cache",
    },
  });
}

/** Walk object graph from tips, collecting all reachable objects not in haves. */
async function collectObjects(
  engine: GitEngine,
  wants: string[],
  haves: Set<string>
): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];
  let frontier = wants.filter(s => !haves.has(s));
  const MAX_OBJECTS = 500_000;

  while (frontier.length > 0 && visited.size < MAX_OBJECTS) {
    // Deduplicate frontier against visited
    const batch: string[] = [];
    for (const sha1 of frontier) {
      if (!visited.has(sha1) && !haves.has(sha1)) {
        visited.add(sha1);
        batch.push(sha1);
      }
    }
    if (batch.length === 0) break;

    // Read in sub-batches of 500 to bound memory — blobs at the frontier
    // level can number in the thousands and don't need their content walked.
    const SUB_BATCH = 500;
    const nextFrontier: string[] = [];

    for (let s = 0; s < batch.length; s += SUB_BATCH) {
      const subBatch = batch.slice(s, s + SUB_BATCH);
      const objects = await engine.readObjects(subBatch);

      for (const sha1 of subBatch) {
        const obj = objects.get(sha1);
        if (!obj) continue;
        result.push(sha1);
        const { type, content } = obj;

        if (type === OBJ_COMMIT) {
          // Commit — parse tree and parent refs
          const text = decoder.decode(content);
          const lines = text.split("\n");
          for (const line of lines) {
            if (line.startsWith("tree ")) {
              nextFrontier.push(line.slice(5, 45));
            } else if (line.startsWith("parent ")) {
              nextFrontier.push(line.slice(7, 47));
            } else if (line === "") {
              break;
            }
          }
        } else if (type === OBJ_TREE) {
          // Tree — parse entries: only walk subtrees, add blobs directly to result
          let pos = 0;
          while (pos < content.length) {
            const modeStart = pos;
            while (pos < content.length && content[pos] !== 0x20) pos++;
            const isTree = (pos - modeStart >= 5) && content[modeStart] === 0x34 && content[modeStart + 1] === 0x30; // "40..."
            pos++;
            while (pos < content.length && content[pos] !== 0x00) pos++;
            pos++;
            if (pos + 20 <= content.length) {
              const entrySha = toHex(content.subarray(pos, pos + 20));
              if (isTree) {
                nextFrontier.push(entrySha);
              } else if (!visited.has(entrySha) && !haves.has(entrySha)) {
                visited.add(entrySha);
                result.push(entrySha);
              }
              pos += 20;
            } else {
              break;
            }
          }
        } else if (type === OBJ_TAG) {
          // Tag — parse object ref
          const text = decoder.decode(content);
          const objLine = text.split("\n").find((l) => l.startsWith("object "));
          if (objLine) nextFrontier.push(objLine.slice(7, 47));
        }
      }
      // objects Map released here — GC can reclaim decompressed data per sub-batch
    }

    frontier = nextFrontier;
  }

  return result;
}
