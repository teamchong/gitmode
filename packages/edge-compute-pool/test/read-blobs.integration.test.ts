// Integration test for the read-blobs pool action.
//
// Pre-encodes blob objects with `blob <size>\0<content>` framing + zlib
// (via node:zlib), writes them to R2, calls the action, verifies the
// returned base64 round-trips back to the original bytes.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { PackWorkerDO } from "../src/index";

const REPO = "read-blobs-repo";

function encodeBlobObject(content: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const obj = new Uint8Array(header.length + content.length);
  obj.set(header, 0);
  obj.set(content, header.length);
  const compressed = deflateSync(obj);
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

function encodeCommitObject(): Uint8Array {
  // Used to test that read-blobs rejects non-blob types.
  const body = `tree ${"0".repeat(40)}\nauthor X <x@x> 1 +0000\ncommitter X <x@x> 1 +0000\n\nx`;
  const bodyBytes = new TextEncoder().encode(body);
  const header = new TextEncoder().encode(`commit ${bodyBytes.length}\0`);
  const obj = new Uint8Array(header.length + bodyBytes.length);
  obj.set(header, 0);
  obj.set(bodyBytes, header.length);
  const compressed = deflateSync(obj);
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

const SHA_TEXT = "1".repeat(40);
const SHA_BIN = "2".repeat(40);
const SHA_LARGE = "3".repeat(40);
const SHA_COMMIT = "4".repeat(40);

const TEXT_CONTENT = new TextEncoder().encode("hello world\nthis is a text blob\n");
const BIN_CONTENT = new Uint8Array(256);
for (let i = 0; i < 256; i++) BIN_CONTENT[i] = i;
const LARGE_CONTENT = new Uint8Array(2 * 1024 * 1024); // 2MB
for (let i = 0; i < LARGE_CONTENT.length; i++) LARGE_CONTENT[i] = i & 0xff;

async function callReadBlobs(
  body: object,
): Promise<{ status: number; data: any }> {
  const id = env.PACK_WORKER.idFromName("test-read-blobs-slot");
  const worker = env.PACK_WORKER.get(id);
  const res = await worker.fetch("http://do/", {
    method: "POST",
    headers: { "x-action": "read-blobs", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // leave as text for plain error responses
  }
  return { status: res.status, data };
}

function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

beforeAll(async () => {
  await env.OBJECTS.put(`${REPO}/loose/${SHA_TEXT}`, encodeBlobObject(TEXT_CONTENT));
  await env.OBJECTS.put(`${REPO}/loose/${SHA_BIN}`, encodeBlobObject(BIN_CONTENT));
  await env.OBJECTS.put(`${REPO}/loose/${SHA_LARGE}`, encodeBlobObject(LARGE_CONTENT));
  await env.OBJECTS.put(`${REPO}/loose/${SHA_COMMIT}`, encodeCommitObject());
});

describe("read-blobs action (integration)", () => {
  it("returns base64 content that decodes to the original text blob", async () => {
    const { status, data } = await callReadBlobs({
      repoPath: REPO,
      blobs: [{ sha: SHA_TEXT, looseKey: `${REPO}/loose/${SHA_TEXT}` }],
    });
    expect(status).toBe(200);
    expect(data.results).toHaveLength(1);
    const r = data.results[0];
    expect(r.sha).toBe(SHA_TEXT);
    expect(r.size).toBe(TEXT_CONTENT.length);

    const decoded = decodeBase64(r.contentBase64);
    expect(decoded.length).toBe(TEXT_CONTENT.length);
    expect(new TextDecoder().decode(decoded)).toBe(new TextDecoder().decode(TEXT_CONTENT));
  });

  it("preserves binary content (full byte range 0..255)", async () => {
    const { status, data } = await callReadBlobs({
      repoPath: REPO,
      blobs: [{ sha: SHA_BIN, looseKey: `${REPO}/loose/${SHA_BIN}` }],
    });
    expect(status).toBe(200);
    const decoded = decodeBase64(data.results[0].contentBase64);
    expect(decoded.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(decoded[i]).toBe(i);
    }
  });

  it("batches multiple blobs in one call", async () => {
    const { status, data } = await callReadBlobs({
      repoPath: REPO,
      blobs: [
        { sha: SHA_TEXT, looseKey: `${REPO}/loose/${SHA_TEXT}` },
        { sha: SHA_BIN, looseKey: `${REPO}/loose/${SHA_BIN}` },
      ],
    });
    expect(status).toBe(200);
    expect(data.results).toHaveLength(2);
    expect(data.results.map((r: any) => r.sha)).toEqual([SHA_TEXT, SHA_BIN]);
  });

  it("rejects oversized blobs against maxBlobBytes (default 1MB)", async () => {
    const { status, data } = await callReadBlobs({
      repoPath: REPO,
      blobs: [{ sha: SHA_LARGE, looseKey: `${REPO}/loose/${SHA_LARGE}` }],
    });
    expect(status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].error).toContain("exceeds maxBlobBytes");
  });

  it("accepts oversized blobs when maxBlobBytes is raised", async () => {
    const { status, data } = await callReadBlobs({
      repoPath: REPO,
      blobs: [{ sha: SHA_LARGE, looseKey: `${REPO}/loose/${SHA_LARGE}` }],
      maxBlobBytes: 4 * 1024 * 1024,
    });
    expect(status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].size).toBe(LARGE_CONTENT.length);
    const decoded = decodeBase64(data.results[0].contentBase64);
    expect(decoded.length).toBe(LARGE_CONTENT.length);
    // Spot-check the round-trip on a sample of bytes
    for (const idx of [0, 100, 1000, 100_000, LARGE_CONTENT.length - 1]) {
      expect(decoded[idx]).toBe(LARGE_CONTENT[idx]);
    }
  });

  it("rejects non-blob object types (returns error, not result)", async () => {
    const { status, data } = await callReadBlobs({
      repoPath: REPO,
      blobs: [{ sha: SHA_COMMIT, looseKey: `${REPO}/loose/${SHA_COMMIT}` }],
    });
    expect(status).toBe(200);
    expect(data.results).toEqual([]);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].sha).toBe(SHA_COMMIT);
    expect(data.errors[0].error).toContain("not a blob");
  });

  it("reports missing objects without aborting the batch", async () => {
    const missingSha = "f".repeat(40);
    const { status, data } = await callReadBlobs({
      repoPath: REPO,
      blobs: [
        { sha: SHA_TEXT, looseKey: `${REPO}/loose/${SHA_TEXT}` },
        { sha: missingSha, looseKey: `${REPO}/loose/${missingSha}` },
      ],
    });
    expect(status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].error).toContain("not found");
  });

  it("rejects keys outside the repo prefix", async () => {
    const { status, data } = await callReadBlobs({
      repoPath: REPO,
      blobs: [{ sha: SHA_TEXT, looseKey: "other-repo/loose/" + SHA_TEXT }],
    });
    expect(status).toBe(400);
    expect(data).toContain("Invalid key scope");
  });

  it("rejects missing repoPath", async () => {
    const { status, data } = await callReadBlobs({
      blobs: [{ sha: SHA_TEXT, looseKey: `${REPO}/loose/${SHA_TEXT}` }],
    });
    expect(status).toBe(400);
    expect(data).toContain("Missing repoPath");
  });
});

void PackWorkerDO;
