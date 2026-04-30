// Integration test for the parse-commits pool action.
//
// Exercises the full chain: DO fetch → readRawObject (R2 + WASM zlib) →
// parseCommitFromRaw → JSON response. Uses node:zlib (available via
// nodejs_compat) to pre-encode commit objects, writes them as loose R2
// blobs, then dispatches to a pool slot.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { PackWorkerDO } from "../src/index";

const REPO = "test-repo";
const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const SHA_C = "3".repeat(40);
const TREE = "a".repeat(40);

function encodeCommitObject(opts: {
  tree: string;
  parents?: string[];
  authorName?: string;
  authorEmail?: string;
  authorTs?: number;
  message?: string;
}): Uint8Array {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents ?? []) lines.push(`parent ${p}`);
  const aName = opts.authorName ?? "Tester";
  const aEmail = opts.authorEmail ?? "tester@example.com";
  const aTs = opts.authorTs ?? 1700000000;
  lines.push(`author ${aName} <${aEmail}> ${aTs} +0000`);
  lines.push(`committer ${aName} <${aEmail}> ${aTs} +0000`);
  const body = lines.join("\n") + "\n\n" + (opts.message ?? "test commit");
  const bodyBytes = new TextEncoder().encode(body);

  const header = new TextEncoder().encode(`commit ${bodyBytes.length}\0`);
  const obj = new Uint8Array(header.length + bodyBytes.length);
  obj.set(header, 0);
  obj.set(bodyBytes, header.length);

  const compressed = deflateSync(obj);
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

async function writeLooseObject(sha: string, compressed: Uint8Array): Promise<string> {
  const key = `${REPO}/loose/${sha}`;
  await env.OBJECTS.put(key, compressed);
  return key;
}

async function callParseCommits(
  body: object,
): Promise<{ status: number; data: any }> {
  const id = env.PACK_WORKER.idFromName("test-slot-0");
  const worker = env.PACK_WORKER.get(id);
  const res = await worker.fetch("http://do/", {
    method: "POST",
    headers: { "x-action": "parse-commits", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // leave as text when the body is a plain error message
  }
  return { status: res.status, data };
}

beforeAll(async () => {
  // Pre-populate R2 with three loose commit objects.
  const a = encodeCommitObject({
    tree: TREE,
    parents: [],
    authorName: "Alice",
    authorEmail: "alice@example.com",
    authorTs: 1700000000,
    message: "initial commit\n\nfirst body line.",
  });
  const b = encodeCommitObject({
    tree: TREE,
    parents: [SHA_A],
    authorName: "Bob",
    authorEmail: "bob@example.com",
    authorTs: 1700000100,
    message: "second commit",
  });
  const c = encodeCommitObject({
    tree: TREE,
    parents: [SHA_A, SHA_B],
    authorName: "Carol",
    authorEmail: "carol@example.com",
    authorTs: 1700000200,
    message: "merge of two branches",
  });

  await writeLooseObject(SHA_A, a);
  await writeLooseObject(SHA_B, b);
  await writeLooseObject(SHA_C, c);
});

describe("parse-commits action (integration)", () => {
  it("returns parsed commits for a single root commit", async () => {
    const { status, data } = await callParseCommits({
      repoPath: REPO,
      commits: [{ sha: SHA_A, looseKey: `${REPO}/loose/${SHA_A}` }],
    });
    expect(status).toBe(200);
    expect(data.results).toHaveLength(1);
    const c = data.results[0];
    expect(c.sha).toBe(SHA_A);
    expect(c.tree).toBe(TREE);
    expect(c.parents).toEqual([]);
    expect(c.author).toBe("Alice");
    expect(c.authorEmail).toBe("alice@example.com");
    expect(c.authorTimestamp).toBe(1700000000);
    expect(c.summary).toBe("initial commit");
  });

  it("returns parents for a child commit", async () => {
    const { status, data } = await callParseCommits({
      repoPath: REPO,
      commits: [{ sha: SHA_B, looseKey: `${REPO}/loose/${SHA_B}` }],
    });
    expect(status).toBe(200);
    expect(data.results[0].parents).toEqual([SHA_A]);
    expect(data.results[0].author).toBe("Bob");
  });

  it("returns multiple parents for a merge commit", async () => {
    const { status, data } = await callParseCommits({
      repoPath: REPO,
      commits: [{ sha: SHA_C, looseKey: `${REPO}/loose/${SHA_C}` }],
    });
    expect(status).toBe(200);
    expect(data.results[0].parents).toEqual([SHA_A, SHA_B]);
    expect(data.results[0].summary).toBe("merge of two branches");
  });

  it("batches multiple commits in one call", async () => {
    const { status, data } = await callParseCommits({
      repoPath: REPO,
      commits: [
        { sha: SHA_A, looseKey: `${REPO}/loose/${SHA_A}` },
        { sha: SHA_B, looseKey: `${REPO}/loose/${SHA_B}` },
        { sha: SHA_C, looseKey: `${REPO}/loose/${SHA_C}` },
      ],
    });
    expect(status).toBe(200);
    expect(data.results).toHaveLength(3);
    expect(data.results.map((c: any) => c.sha)).toEqual([SHA_A, SHA_B, SHA_C]);
  });

  it("reports errors for missing objects without aborting the batch", async () => {
    const missingSha = "f".repeat(40);
    const { status, data } = await callParseCommits({
      repoPath: REPO,
      commits: [
        { sha: SHA_A, looseKey: `${REPO}/loose/${SHA_A}` },
        { sha: missingSha, looseKey: `${REPO}/loose/${missingSha}` },
      ],
    });
    expect(status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].sha).toBe(SHA_A);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].sha).toBe(missingSha);
    expect(data.errors[0].error).toContain("not found");
  });

  it("rejects keys outside the repo prefix (cross-repo isolation)", async () => {
    const { status, data } = await callParseCommits({
      repoPath: REPO,
      commits: [{ sha: SHA_A, looseKey: "other-repo/loose/" + SHA_A }],
    });
    expect(status).toBe(400);
    expect(data).toContain("Invalid key scope");
  });

  it("rejects missing repoPath", async () => {
    const { status, data } = await callParseCommits({
      commits: [{ sha: SHA_A, looseKey: `${REPO}/loose/${SHA_A}` }],
    });
    expect(status).toBe(400);
    expect(data).toContain("Missing repoPath");
  });

  it("returns empty results for empty input", async () => {
    const { status, data } = await callParseCommits({
      repoPath: REPO,
      commits: [],
    });
    expect(status).toBe(200);
    expect(data.results).toEqual([]);
  });
});

// Keep the symbol live so the binding resolves at miniflare load time.
void PackWorkerDO;
