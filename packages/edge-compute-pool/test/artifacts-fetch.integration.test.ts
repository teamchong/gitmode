// End-to-end Artifacts integration test.
//
// Stands up an in-memory Artifacts-shaped server (responding to GET
// /info/refs and POST /git-upload-pack), runs `fetchArtifactsCommit`
// through it, and then verifies that the existing PackWorkerDO actions
// (parse-commits, read-blobs) succeed against the staged R2 objects.
//
// This is the actual proof that the toolkit works with a Cloudflare
// Artifacts-shaped server, not just with synthetic fixtures we control.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { WasmEngine } from "@gitmode/wasm-git";
import {
  PackWorkerDO,
  fetchArtifactsCommit,
  discoverArtifactsRefs,
} from "../src/index";
import {
  encodePktLine,
  encodePktLineBytes,
  FLUSH_PKT,
  concat,
} from "../src/protocol/pkt-line";

// ---------- Pack-builder for fixture responses ------------------------

function writeUint32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
}

function writeTypeSizeHeader(type: number, size: number): Uint8Array {
  const out: number[] = [];
  let s = size;
  let byte = ((type & 0x07) << 4) | (s & 0x0f);
  s >>= 4;
  if (s > 0) byte |= 0x80;
  out.push(byte);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    out.push(b);
  }
  return new Uint8Array(out);
}

async function sha1Bytes(buf: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
}

async function gitObjectSha(typeName: string, content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${typeName} ${content.length}\0`);
  const buf = new Uint8Array(header.length + content.length);
  buf.set(header, 0);
  buf.set(content, header.length);
  const hash = await sha1Bytes(buf);
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildPackfile(
  objects: Array<{ type: number; content: Uint8Array }>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [
    new TextEncoder().encode("PACK"),
    writeUint32BE(2),
    writeUint32BE(objects.length),
  ];
  for (const obj of objects) {
    parts.push(writeTypeSizeHeader(obj.type, obj.content.length));
    const def = deflateSync(obj.content);
    parts.push(new Uint8Array(def.buffer, def.byteOffset, def.byteLength));
  }
  const body = concat(parts);
  const trailer = await sha1Bytes(body);
  const result = new Uint8Array(body.length + 20);
  result.set(body, 0);
  result.set(trailer, body.length);
  return result;
}

// Wrap raw packfile bytes in a sideband-multiplexed git-upload-pack response.
function wrapAsSidebandResponse(pack: Uint8Array): Uint8Array {
  const ack = encodePktLine("NAK\n");
  const CHUNK = 8000;
  const chunks: Uint8Array[] = [ack];
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    const sideband = new Uint8Array(slice.length + 1);
    sideband[0] = 0x01;
    sideband.set(slice, 1);
    chunks.push(encodePktLineBytes(sideband));
  }
  chunks.push(FLUSH_PKT);
  return concat(chunks);
}

// ---------- Synthetic Artifacts repo -----------------------------------

const REPO_PATH = "artifacts-fetch-test";

const BLOB1 = new TextEncoder().encode("// hello from artifacts\n");
const BLOB2 = new TextEncoder().encode("README content\n");

let TREE_BYTES: Uint8Array;
let COMMIT_BYTES: Uint8Array;
let BLOB1_SHA: string;
let BLOB2_SHA: string;
let TREE_SHA: string;
let COMMIT_SHA: string;

async function buildTestRepoFixture(): Promise<void> {
  BLOB1_SHA = await gitObjectSha("blob", BLOB1);
  BLOB2_SHA = await gitObjectSha("blob", BLOB2);

  // Tree with two blob entries (sorted by name)
  function shaToBytes(sha: string): Uint8Array {
    const b = new Uint8Array(20);
    for (let i = 0; i < 20; i++) b[i] = parseInt(sha.substr(i * 2, 2), 16);
    return b;
  }
  const entries = [
    {
      mode: "100644",
      name: "README.md",
      sha: BLOB2_SHA,
    },
    { mode: "100644", name: "src.txt", sha: BLOB1_SHA },
  ].sort((a, b) => (a.name < b.name ? -1 : 1));

  const treeParts: Uint8Array[] = [];
  for (const e of entries) {
    treeParts.push(new TextEncoder().encode(`${e.mode} ${e.name}\0`));
    treeParts.push(shaToBytes(e.sha));
  }
  TREE_BYTES = concat(treeParts);
  TREE_SHA = await gitObjectSha("tree", TREE_BYTES);

  const commitText =
    `tree ${TREE_SHA}\n` +
    `author Tester <tester@example.com> 1700000000 +0000\n` +
    `committer Tester <tester@example.com> 1700000000 +0000\n` +
    `\n` +
    `initial commit from artifacts fixture\n`;
  COMMIT_BYTES = new TextEncoder().encode(commitText);
  COMMIT_SHA = await gitObjectSha("commit", COMMIT_BYTES);
}

function makeArtifactsServer(packBody: Uint8Array): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const adv = concat([
        encodePktLine("# service=git-upload-pack\n"),
        FLUSH_PKT,
        encodePktLine(`${COMMIT_SHA} HEAD\0multi_ack thin-pack side-band-64k\n`),
        encodePktLine(`${COMMIT_SHA} refs/heads/main\n`),
        FLUSH_PKT,
      ]);
      return new Response(adv, { status: 200 });
    }

    if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
      // We don't validate the request body; we just return our pre-built pack.
      return new Response(wrapAsSidebandResponse(packBody), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };
}

// ---------- Tests ----------------------------------------------------

describe("fetchArtifactsCommit (end-to-end Artifacts integration)", () => {
  it("discovers refs from an Artifacts-shaped server", async () => {
    await buildTestRepoFixture();
    const pack = await buildPackfile([
      { type: 3, content: BLOB1 },
      { type: 3, content: BLOB2 },
      { type: 2, content: TREE_BYTES },
      { type: 1, content: COMMIT_BYTES },
    ]);
    const fetcher = makeArtifactsServer(pack);

    const adv = await discoverArtifactsRefs({
      artifactsUrl: "https://x.artifacts.cloudflare.net/git/test.git",
      token: "fake-token",
      fetcher,
    });
    expect(adv.head).toBe(COMMIT_SHA);
    expect(adv.refs.get("refs/heads/main")).toBe(COMMIT_SHA);
    expect(adv.capabilities.has("side-band-64k")).toBe(true);
  });

  it("fetches a commit closure, stages all objects in R2, and the pool can read them", async () => {
    await buildTestRepoFixture();

    const pack = await buildPackfile([
      { type: 3, content: BLOB1 },
      { type: 3, content: BLOB2 },
      { type: 2, content: TREE_BYTES },
      { type: 1, content: COMMIT_BYTES },
    ]);
    const fetcher = makeArtifactsServer(pack);
    const wasm = await WasmEngine.create();

    const result = await fetchArtifactsCommit({
      artifactsUrl: "https://x.artifacts.cloudflare.net/git/test.git",
      token: "fake-token",
      commitSha: COMMIT_SHA,
      repoPath: REPO_PATH,
      bucket: env.OBJECTS,
      wasm,
      fetcher,
    });

    expect(result.objectsWritten).toBe(4);
    expect(new Set(result.shas)).toEqual(new Set([BLOB1_SHA, BLOB2_SHA, TREE_SHA, COMMIT_SHA]));

    // Now the existing pool actions should work against the staged objects.
    // First, parse-commits on the commit we fetched.
    const parseRes = await env.PACK_WORKER.get(env.PACK_WORKER.idFromName("artifacts-test")).fetch(
      "http://do/",
      {
        method: "POST",
        headers: { "x-action": "parse-commits", "content-type": "application/json" },
        body: JSON.stringify({
          repoPath: REPO_PATH,
          commits: [{ sha: COMMIT_SHA, looseKey: `${REPO_PATH}/loose/${COMMIT_SHA}` }],
        }),
      },
    );
    expect(parseRes.status).toBe(200);
    const parseBody = (await parseRes.json()) as {
      results: Array<{ sha: string; tree: string; author: string; summary: string }>;
    };
    expect(parseBody.results).toHaveLength(1);
    expect(parseBody.results[0]!.tree).toBe(TREE_SHA);
    expect(parseBody.results[0]!.author).toBe("Tester");
    expect(parseBody.results[0]!.summary).toBe("initial commit from artifacts fixture");

    // And read-blobs on the blob we fetched.
    const readRes = await env.PACK_WORKER.get(env.PACK_WORKER.idFromName("artifacts-test")).fetch(
      "http://do/",
      {
        method: "POST",
        headers: { "x-action": "read-blobs", "content-type": "application/json" },
        body: JSON.stringify({
          repoPath: REPO_PATH,
          blobs: [{ sha: BLOB1_SHA, looseKey: `${REPO_PATH}/loose/${BLOB1_SHA}` }],
        }),
      },
    );
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as {
      results: Array<{ sha: string; size: number; contentBase64: string }>;
    };
    expect(readBody.results).toHaveLength(1);
    expect(readBody.results[0]!.size).toBe(BLOB1.length);
    const decoded = new Uint8Array(Buffer.from(readBody.results[0]!.contentBase64, "base64"));
    expect(new TextDecoder().decode(decoded)).toBe("// hello from artifacts\n");
  });

  it("rejects a bad commit sha shape before hitting the network", async () => {
    const wasm = await WasmEngine.create();
    await expect(
      fetchArtifactsCommit({
        artifactsUrl: "https://example.com/git/repo.git",
        commitSha: "not-a-sha",
        repoPath: "x",
        bucket: env.OBJECTS,
        wasm,
        fetcher: () => Promise.reject(new Error("should not be called")),
      }),
    ).rejects.toThrow(/invalid commit sha/);
  });

  it("surfaces server-side errors emitted on sideband channel 3", async () => {
    await buildTestRepoFixture();
    const errFetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as string, init);
      if (req.url.includes("git-upload-pack") && req.method === "POST") {
        const errMsg = "remote: object missing\n";
        const errPayload = new Uint8Array(1 + new TextEncoder().encode(errMsg).length);
        errPayload[0] = 0x03;
        errPayload.set(new TextEncoder().encode(errMsg), 1);
        const body = concat([
          encodePktLine("NAK\n"),
          encodePktLineBytes(errPayload),
          FLUSH_PKT,
        ]);
        return new Response(body, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const wasm = await WasmEngine.create();
    await expect(
      fetchArtifactsCommit({
        artifactsUrl: "https://example.com/git/repo.git",
        commitSha: COMMIT_SHA,
        repoPath: "errtest",
        bucket: env.OBJECTS,
        wasm,
        fetcher: errFetcher,
      }),
    ).rejects.toThrow(/Artifacts server reported errors/);
  });
});

void PackWorkerDO;
