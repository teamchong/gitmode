// Integration test for the logWalk coordinator.
//
// Builds a linear-then-branched commit history and walks it via real
// PackWorkerDO + parse-commits, verifying BFS traversal, filter
// predicates, limit, and depth cap.

import { env } from "cloudflare:test";
import { describe, expect, it, beforeAll } from "vitest";
import { deflateSync } from "node:zlib";
import {
  PackWorkerDO,
  logWalk,
  type CommitLookup,
  type CommitInfo,
} from "../src/index";

const REPO = "log-walk-repo";
const TREE = "0".repeat(40);

function encodeCommitObject(opts: {
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  message: string;
}): Uint8Array {
  const lines: string[] = [`tree ${TREE}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.authorName} <${opts.authorEmail}> ${opts.authorTs} +0000`);
  lines.push(`committer ${opts.authorName} <${opts.authorEmail}> ${opts.authorTs} +0000`);
  const body = lines.join("\n") + "\n\n" + opts.message;
  const bodyBytes = new TextEncoder().encode(body);
  const header = new TextEncoder().encode(`commit ${bodyBytes.length}\0`);
  const obj = new Uint8Array(header.length + bodyBytes.length);
  obj.set(header, 0);
  obj.set(bodyBytes, header.length);
  const compressed = deflateSync(obj);
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

// Synthetic graph:
//
//        A (root, Alice, "initial")
//        |
//        B (Bob, "fix bug TODO")
//        |
//        C (Alice, "add feature")
//        |
//        D (Bob, "another TODO refactor")
//
// All commits are authored at increasing timestamps so chronological-ish
// BFS order is D, C, B, A from D as seed.
const SHAS = ["a", "b", "c", "d"].map((c) => c.repeat(40));
const [A, B, C, D] = SHAS;

const DATA: Array<{
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  message: string;
}> = [
  { sha: A, parents: [], authorName: "Alice", authorEmail: "alice@e.com", authorTs: 1700000000, message: "initial commit" },
  { sha: B, parents: [A], authorName: "Bob", authorEmail: "bob@e.com", authorTs: 1700000100, message: "fix bug TODO" },
  { sha: C, parents: [B], authorName: "Alice", authorEmail: "alice@e.com", authorTs: 1700000200, message: "add feature" },
  { sha: D, parents: [C], authorName: "Bob", authorEmail: "bob@e.com", authorTs: 1700000300, message: "another TODO refactor" },
];

const PARENTS = new Set(SHAS);
const lookup: CommitLookup = (sha) =>
  PARENTS.has(sha) ? { looseKey: `${REPO}/loose/${sha}` } : null;

beforeAll(async () => {
  for (const c of DATA) {
    const obj = encodeCommitObject(c);
    await env.OBJECTS.put(`${REPO}/loose/${c.sha}`, obj);
  }
});

describe("logWalk", () => {
  it("returns all reachable commits when filter is the default", async () => {
    const out = await logWalk({
      seeds: [D],
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(out.map((c) => c.sha)).toEqual([D, C, B, A]);
  });

  it("returns an empty array when seeds is empty", async () => {
    const out = await logWalk({
      seeds: [],
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(out).toEqual([]);
  });

  it("respects limit", async () => {
    const out = await logWalk({
      seeds: [D],
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
      limit: 2,
    });
    expect(out.map((c) => c.sha)).toEqual([D, C]);
  });

  it("filters by author email", async () => {
    const out = await logWalk({
      seeds: [D],
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
      filter: (c) => c.authorEmail === "bob@e.com",
    });
    expect(out.map((c) => c.sha)).toEqual([D, B]);
    expect(out.every((c) => c.author === "Bob")).toBe(true);
  });

  it("filters by message regex (git log -S equivalent)", async () => {
    const todoRe = /TODO/;
    const out = await logWalk({
      seeds: [D],
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
      filter: (c: CommitInfo) => todoRe.test(c.message),
    });
    expect(out.map((c) => c.sha)).toEqual([D, B]);
  });

  it("respects maxDepth and stops walking", async () => {
    // depth=1: only the seed level (D itself); D has parent C but we never
    // process C as it's in next-frontier.
    const out = await logWalk({
      seeds: [D],
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
      maxDepth: 1,
    });
    expect(out.map((c) => c.sha)).toEqual([D]);
  });
});

void PackWorkerDO;
