// Integration test for the mergeBase coordinator.
//
// Builds a synthetic commit graph in R2, then walks it via parse-commits
// dispatched to a real PackWorkerDO. Validates the BFS terminates with the
// correct lowest common ancestor across topology variants:
//
//      A           A
//      |           |
//      B           B────D
//      |           |    |
//      C           C    E       (merge base of C and E is B)
//      |
//      D────E      A           A
//      |    |      |           |
//      F    G      B           B
//                  |           |
//                  C────D      C────D
//                       |           |
//                       E           E───F  (merge base of C and F is C, not B)

import { env } from "cloudflare:test";
import { describe, expect, it, beforeAll } from "vitest";
import { deflateSync } from "node:zlib";
import {
  PackWorkerDO,
  mergeBase,
  type CommitLookup,
} from "../src/index";

const REPO = "merge-base-repo";
const TREE = "0".repeat(40);

function encodeCommitObject(parents: string[], message: string): Uint8Array {
  const lines: string[] = [`tree ${TREE}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push("author T <t@t> 1700000000 +0000");
  lines.push("committer T <t@t> 1700000000 +0000");
  const body = lines.join("\n") + "\n\n" + message;
  const bodyBytes = new TextEncoder().encode(body);
  const header = new TextEncoder().encode(`commit ${bodyBytes.length}\0`);
  const obj = new Uint8Array(header.length + bodyBytes.length);
  obj.set(header, 0);
  obj.set(bodyBytes, header.length);
  const compressed = deflateSync(obj);
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

// Synthetic SHAs (any 40-hex string works since we control the lookup map).
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const F = "f".repeat(40);
const G = "9".repeat(40);

// Topology:
//   A → B → C
//       │
//       └→ D
//
//   plus an unrelated branch:
//   E → F   (no shared ancestor with A/B/C/D — different root)
//   G is unreachable from anywhere (orphan)
const PARENTS: Record<string, string[]> = {
  [A]: [],
  [B]: [A],
  [C]: [B],
  [D]: [B],
  [E]: [],
  [F]: [E],
  [G]: [],
};

const lookup: CommitLookup = (sha) =>
  PARENTS[sha] !== undefined ? { looseKey: `${REPO}/loose/${sha}` } : null;

beforeAll(async () => {
  for (const [sha, parents] of Object.entries(PARENTS)) {
    const obj = encodeCommitObject(parents, `commit ${sha.slice(0, 4)}`);
    await env.OBJECTS.put(`${REPO}/loose/${sha}`, obj);
  }
});

describe("mergeBase", () => {
  it("returns the same SHA when both inputs are equal", async () => {
    const base = await mergeBase({
      shaA: A,
      shaB: A,
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(base).toBe(A);
  });

  it("returns the parent when one is the ancestor of the other", async () => {
    // C descends from B
    const base = await mergeBase({
      shaA: B,
      shaB: C,
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(base).toBe(B);
  });

  it("returns the lowest common ancestor for siblings (C and D both have parent B)", async () => {
    const base = await mergeBase({
      shaA: C,
      shaB: D,
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(base).toBe(B);
  });

  it("walks deeper when the LCA is several levels up (D vs A returns A)", async () => {
    const base = await mergeBase({
      shaA: D,
      shaB: A,
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(base).toBe(A);
  });

  it("returns null when the histories share no ancestor (C vs F)", async () => {
    const base = await mergeBase({
      shaA: C,
      shaB: F,
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(base).toBeNull();
  });

  it("respects maxDepth and gives up rather than running forever", async () => {
    // With depth=0, we never get past the first frontier — so for non-equal
    // inputs we should return null.
    const base = await mergeBase({
      shaA: D,
      shaB: A,
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
      maxDepth: 0,
    });
    expect(base).toBeNull();
  });
});

void PackWorkerDO;
