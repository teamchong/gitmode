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

  // Build packfile
  const packData = await buildPackfile(engine, needed);

  // Response: ACK (if common commits found) or NAK + packfile in sideband-64k
  const ackOrNak = commonSha
    ? encodePktLine(`ACK ${commonSha}\n`)
    : encodePktLine("NAK\n");

  // Split packfile into sideband pkt-lines
  // Git LARGE_PACKET_MAX = 65520 total, minus 4 header, minus 1 channel byte = 65515
  const MAX_SIDEBAND_DATA = 65515;
  const sidebandPkts: Uint8Array[] = [];
  let packOffset = 0;
  while (packOffset < packData.length) {
    const chunkLen = Math.min(packData.length - packOffset, MAX_SIDEBAND_DATA);
    const payload = new Uint8Array(1 + chunkLen);
    payload[0] = 0x01; // sideband channel 1 (pack data)
    payload.set(packData.subarray(packOffset, packOffset + chunkLen), 1);
    sidebandPkts.push(encodePktLineBytes(payload));
    packOffset += chunkLen;
  }

  // Total: ACK/NAK + sideband pkt-lines + flush
  const totalLen = ackOrNak.length
    + sidebandPkts.reduce((acc, p) => acc + p.length, 0)
    + FLUSH_PKT.length;
  const responseBody = new Uint8Array(totalLen);
  let pos = 0;
  responseBody.set(ackOrNak, pos);
  pos += ackOrNak.length;
  for (const pkt of sidebandPkts) {
    responseBody.set(pkt, pos);
    pos += pkt.length;
  }
  responseBody.set(FLUSH_PKT, pos);

  return new Response(responseBody, {
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

  while (frontier.length > 0) {
    // Deduplicate frontier against visited
    const batch: string[] = [];
    for (const sha1 of frontier) {
      if (!visited.has(sha1) && !haves.has(sha1)) {
        visited.add(sha1);
        batch.push(sha1);
      }
    }
    if (batch.length === 0) break;

    // Fetch batch in parallel (up to 50 concurrent R2 reads)
    const CONCURRENCY = 50;
    const nextFrontier: string[] = [];

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(
        chunk.map(sha1 => engine.readObject(sha1).then(obj => ({ sha1, obj })))
      );

      for (const { sha1, obj } of fetched) {
        if (!obj) continue;
        result.push(sha1);
        const { type, content } = obj;

        if (type === 3) {
          // Commit — parse tree and parent refs
          const text = new TextDecoder().decode(content);
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
        } else if (type === 2) {
          // Tree — parse entries for subtrees and blobs
          let pos = 0;
          while (pos < content.length) {
            while (pos < content.length && content[pos] !== 0x20) pos++;
            pos++;
            while (pos < content.length && content[pos] !== 0x00) pos++;
            pos++;
            if (pos + 20 <= content.length) {
              nextFrontier.push(toHex(content.subarray(pos, pos + 20)));
              pos += 20;
            } else {
              break;
            }
          }
        } else if (type === 4) {
          // Tag — parse object ref
          const text = new TextDecoder().decode(content);
          const objLine = text.split("\n").find((l) => l.startsWith("object "));
          if (objLine) nextFrontier.push(objLine.slice(7, 47));
        }
      }
    }

    frontier = nextFrontier;
  }

  return result;
}
