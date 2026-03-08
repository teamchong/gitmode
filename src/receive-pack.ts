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
import { unpackPackfile, type ObjectCache } from "./packfile-reader";
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
): Promise<{ response: Response; backgroundWork?: Promise<void> }> {
  // Parse ref update commands and capabilities
  const updates: RefUpdate[] = [];
  let offset = 0;
  let useSideband = false;

  while (offset < body.length) {
    const pkt = decodePktLine(body, offset);
    if (!pkt) break;
    offset = pkt.nextOffset;

    if (pkt.type === "flush") break;
    if (pkt.type !== "data" || !pkt.payload) continue;

    let line = decoder.decode(pkt.payload).trimEnd();
    // Parse capabilities from first line
    const nullIdx = line.indexOf("\0");
    if (nullIdx !== -1) {
      const caps = line.slice(nullIdx + 1);
      if (caps.includes("side-band-64k")) useSideband = true;
      line = line.slice(0, nullIdx);
    }

    if (line.length >= 85) {
      updates.push({
        oldSha: line.slice(0, 40),
        newSha: line.slice(41, 81),
        refname: line.slice(82),
      });
    }
  }

  // Remaining bytes are the packfile
  const packData = body.subarray(offset);

  // Unpack objects from packfile into R2, keep in-memory cache for worktree
  let objectCache: ObjectCache | undefined;
  if (packData.length > 0) {
    objectCache = await unpackPackfile(engine, packData);
  }

  // Apply ref updates
  const results: string[] = [];
  for (const update of updates) {
    try {
      if (update.newSha === ZERO_SHA) {
        // Delete ref
        engine.deleteRef(update.refname.replace(/^refs\//, ""));
        results.push(`ok ${update.refname}`);
      } else {
        // Verify old SHA matches (fast-forward check)
        const currentRef = update.refname.replace(/^refs\//, "");
        const currentSha = engine.getRef(currentRef);

        if (update.oldSha !== ZERO_SHA && currentSha !== update.oldSha) {
          results.push(`ng ${update.refname} non-fast-forward`);
          continue;
        }

        engine.setRef(currentRef, update.newSha);

        // Update HEAD for first push
        if (
          update.refname === "refs/heads/main" ||
          update.refname === "refs/heads/master"
        ) {
          engine.setHead(`ref: ${update.refname}`);
        }

        results.push(`ok ${update.refname}`);
      }
    } catch (err) {
      results.push(`ng ${update.refname} ${err}`);
    }
  }

  // Ensure repo metadata exists
  try {
    engine.ensureRepo();
  } catch {
    // ignore if already exists
  }

  // Index new commits (sync — fast SQLite inserts) and schedule worktree
  // materialization (async — runs after response is sent to unblock git client).
  const worktreePromises: Promise<void>[] = [];
  if (env && repoPath) {
    for (const update of updates) {
      if (update.newSha === ZERO_SHA) continue;
      if (!update.refname.startsWith("refs/heads/")) continue;
      const resultLine = results.find((r) => r.startsWith(`ok ${update.refname}`));
      if (!resultLine) continue;

      // Index commits — fast, uses cached objects from unpack
      try {
        await indexNewCommits(engine, update.oldSha, update.newSha);
      } catch (err) {
        console.error(`commit indexing failed for ${update.refname}: ${err}`);
      }

      // Schedule worktree materialization (non-blocking)
      const branch = update.refname.replace(/^refs\/heads\//, "");
      const oldSha = update.oldSha !== ZERO_SHA ? update.oldSha : undefined;
      worktreePromises.push(
        materializeWorktree(engine, env, repoPath, branch, update.newSha, oldSha, objectCache)
          .catch(err => console.error(`checkout failed for ${branch}: ${err}`))
      );
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

  let responseBody: Uint8Array;
  if (useSideband) {
    const sidebandPkt = wrapSideband(reportBuf);
    responseBody = new Uint8Array(sidebandPkt.length + FLUSH_PKT.length);
    responseBody.set(sidebandPkt);
    responseBody.set(FLUSH_PKT, sidebandPkt.length);
  } else {
    responseBody = reportBuf;
  }

  const response = new Response(responseBody, {
    headers: {
      "Content-Type": "application/x-git-receive-pack-result",
      "Cache-Control": "no-cache",
    },
  });

  // Worktree materialization: defer for large repos (>500 objects),
  // run inline for small pushes to maintain test consistency
  const isLargePush = objectCache ? objectCache.size > 500 : false;

  if (!isLargePush && worktreePromises.length > 0) {
    await Promise.all(worktreePromises);
  }

  const backgroundWork = isLargePush && worktreePromises.length > 0
    ? Promise.all(worktreePromises).then(() => {})
    : undefined;

  return { response, backgroundWork };
}

/** Walk commits from newSha back to oldSha and index each one. */
async function indexNewCommits(
  engine: GitEngine,
  oldSha: string,
  newSha: string,
): Promise<void> {
  const visited = new Set<string>();
  let frontier = [newSha];
  const stopAt = oldSha === ZERO_SHA ? null : oldSha;
  const MAX_COMMITS = 10000;

  while (frontier.length > 0 && visited.size < MAX_COMMITS) {
    // Deduplicate frontier
    const batch: string[] = [];
    for (const sha of frontier) {
      if (!visited.has(sha) && sha !== stopAt) {
        visited.add(sha);
        batch.push(sha);
      }
    }
    if (batch.length === 0) break;

    // Batch read commits (up to 500 at a time)
    const objects = await engine.readObjects(batch);
    const nextFrontier: string[] = [];

    for (const sha of batch) {
      const obj = objects.get(sha);
      if (!obj) continue;

      const raw = decoder.decode(obj.content);
      const authorLine = raw.match(/^author (.+?) <(.+?)> (\d+)/m);
      const msgStart = raw.indexOf("\n\n");
      const message = msgStart >= 0 ? raw.slice(msgStart + 2).trim() : "";
      const author = authorLine ? `${authorLine[1]} <${authorLine[2]}>` : "unknown";
      const timestamp = authorLine ? parseInt(authorLine[3], 10) : 0;

      engine.indexCommit(sha, author, message, timestamp);

      const parentMatches = raw.matchAll(/^parent ([0-9a-f]{40})/gm);
      for (const m of parentMatches) {
        nextFrontier.push(m[1]);
      }
    }

    frontier = nextFrontier;
  }
}
