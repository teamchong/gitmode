// POST /git-receive-pack — handles push
//
// Client sends:
//   <old-sha1> <new-sha1> <refname>\0<capabilities>\n  (ref updates)
//   ...
//   0000 (flush)
//   <packfile data>
//
// Server responds with report-status.

import type { GitEngine } from "./git-engine";
import type { Env } from "./env";
import { decodePktLine, encodePktLine, encodePktLineBytes, FLUSH_PKT } from "./pkt-line";
import { unpackPackfile } from "./packfile-reader";
import { materializeWorktree } from "./checkout";

const decoder = new TextDecoder();
const ZERO_SHA = "0".repeat(40);

/** Wrap data in a sideband-64k pkt-line on channel 1 (data channel). */
function wrapSideband(data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(1 + data.length);
  payload[0] = 0x01; // sideband channel 1
  payload.set(data, 1);
  return encodePktLineBytes(payload);
}

interface RefUpdate {
  oldSha: string;
  newSha: string;
  refname: string;
}

export async function handleReceivePack(
  engine: GitEngine,
  body: Uint8Array,
  env?: Env,
  repoPath?: string
): Promise<Response> {
  // Parse ref update commands
  const updates: RefUpdate[] = [];
  let offset = 0;

  while (offset < body.length) {
    const pkt = decodePktLine(body, offset);
    if (!pkt) break;
    offset = pkt.nextOffset;

    if (pkt.type === "flush") break;
    if (pkt.type !== "data" || !pkt.payload) continue;

    let line = decoder.decode(pkt.payload).trimEnd();
    // Strip capabilities from first line
    const nullIdx = line.indexOf("\0");
    if (nullIdx !== -1) line = line.slice(0, nullIdx);

    if (line.length >= 85) {
      updates.push({
        oldSha: line.slice(0, 40),
        newSha: line.slice(41, 81),
        refname: line.slice(82),
      });
    }
  }

  // Remaining bytes are the packfile
  const packData = body.slice(offset);

  // Unpack objects from packfile into R2
  if (packData.length > 0) {
    await unpackPackfile(engine, packData);
  }

  // Apply ref updates
  const results: string[] = [];
  for (const update of updates) {
    try {
      if (update.newSha === ZERO_SHA) {
        // Delete ref
        await engine.deleteRef(update.refname.replace(/^refs\//, ""));
        results.push(`ok ${update.refname}`);
      } else {
        // Verify old SHA matches (fast-forward check)
        const currentRef = update.refname.replace(/^refs\//, "");
        const currentSha = await engine.getRef(currentRef);

        if (update.oldSha !== ZERO_SHA && currentSha !== update.oldSha) {
          results.push(`ng ${update.refname} non-fast-forward`);
          continue;
        }

        await engine.setRef(currentRef, update.newSha);

        // Update HEAD for first push
        if (
          update.refname === "refs/heads/main" ||
          update.refname === "refs/heads/master"
        ) {
          await engine.setHead(`ref: ${update.refname}`);
        }

        results.push(`ok ${update.refname}`);
      }
    } catch (err) {
      results.push(`ng ${update.refname} ${err}`);
    }
  }

  // Materialize worktrees for successfully updated branch refs
  if (env && repoPath) {
    for (const update of updates) {
      if (update.newSha === ZERO_SHA) continue;
      if (!update.refname.startsWith("refs/heads/")) continue;
      const resultLine = results.find((r) => r.startsWith(`ok ${update.refname}`));
      if (!resultLine) continue;

      const branch = update.refname.replace(/^refs\/heads\//, "");
      try {
        await materializeWorktree(engine, env, repoPath, branch, update.newSha);
      } catch (err) {
        console.error(`checkout failed for ${branch}: ${err}`);
      }
    }
  }

  // Build report-status as a raw pkt-line byte stream
  const reportParts: Uint8Array[] = [];
  reportParts.push(encodePktLine("unpack ok\n"));
  for (const result of results) {
    reportParts.push(encodePktLine(result + "\n"));
  }
  reportParts.push(FLUSH_PKT);

  const reportLen = reportParts.reduce((acc, l) => acc + l.length, 0);
  const reportBuf = new Uint8Array(reportLen);
  let rpos = 0;
  for (const part of reportParts) {
    reportBuf.set(part, rpos);
    rpos += part.length;
  }

  // Wrap the report-status in sideband channel 1 and terminate with flush
  const sidebandPkt = wrapSideband(reportBuf);
  const responseBody = new Uint8Array(sidebandPkt.length + FLUSH_PKT.length);
  responseBody.set(sidebandPkt);
  responseBody.set(FLUSH_PKT, sidebandPkt.length);

  return new Response(responseBody, {
    headers: {
      "Content-Type": "application/x-git-receive-pack-result",
      "Cache-Control": "no-cache",
    },
  });
}
