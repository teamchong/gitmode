// Integration test for the blameWalk coordinator.
//
// Builds a synthetic repo with multiple commits, tree objects, and blob
// objects all written to R2, then runs blameWalk against a real
// PackWorkerDO. The test fixture takes care to put REAL commit/tree/blob
// content in R2 (not just commits like the other tests) so the full
// resolveBlobAtPath → readBlobText → parse-commits chain is exercised.

import { env } from "cloudflare:test";
import { describe, expect, it, beforeAll } from "vitest";
import { deflateSync } from "node:zlib";
import {
  PackWorkerDO,
  blameWalk,
  type CommitLookup,
} from "../src/index";

const REPO = "blame-repo";

// --- Object encoders -------------------------------------------------

function compress(obj: Uint8Array): Uint8Array {
  const c = deflateSync(obj);
  return new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
}

function withGitHeader(type: string, body: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`${type} ${body.length}\0`);
  const obj = new Uint8Array(header.length + body.length);
  obj.set(header, 0);
  obj.set(body, header.length);
  return obj;
}

function encodeBlob(content: string): Uint8Array {
  return compress(withGitHeader("blob", new TextEncoder().encode(content)));
}

function hexShaToBytes(sha: string): Uint8Array {
  if (sha.length !== 40) throw new Error(`bad sha: ${sha}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = parseInt(sha.substr(i * 2, 2), 16);
  }
  return out;
}

interface TreeEntry {
  mode: string; // "100644" for files, "040000" for directories
  name: string;
  sha: string;
}

function encodeTree(entries: TreeEntry[]): Uint8Array {
  // Git requires entries sorted by name, with a quirk for directories
  // (they sort as if they had a trailing "/"). For our flat test fixture
  // names don't collide, so plain sort is fine.
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(new TextEncoder().encode(`${e.mode} ${e.name}\0`));
    parts.push(hexShaToBytes(e.sha));
  }
  let totalSize = 0;
  for (const p of parts) totalSize += p.length;
  const body = new Uint8Array(totalSize);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  return compress(withGitHeader("tree", body));
}

function encodeCommit(opts: {
  tree: string;
  parents: string[];
  authorName?: string;
  authorEmail?: string;
  authorTs?: number;
  message?: string;
}): Uint8Array {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  const aName = opts.authorName ?? "Author";
  const aEmail = opts.authorEmail ?? "author@example.com";
  const aTs = opts.authorTs ?? 1700000000;
  lines.push(`author ${aName} <${aEmail}> ${aTs} +0000`);
  lines.push(`committer ${aName} <${aEmail}> ${aTs} +0000`);
  const body = lines.join("\n") + "\n\n" + (opts.message ?? "commit");
  return compress(withGitHeader("commit", new TextEncoder().encode(body)));
}

// --- Synthetic repo --------------------------------------------------
//
// Three-commit linear history modifying a single file at "src/foo.txt":
//
//   A → adds file with content "line one\nline two\n"
//   B → appends a line: "line one\nline two\nline three\n"
//   C → modifies middle line: "line one\nline two CHANGED\nline three\n"
//
// Plus a separate scenario "deep/path/foo.txt" for nested-tree coverage.

// Blob SHAs (synthetic; chosen to be valid hex). These act as both the
// in-storage key and the value `git hash-object` would compute against —
// but for tests we don't need them to match actual hashes since both the
// lookup map and the tree references use the same synthetic identifiers.
const BLOB_A = "1aaa1aaa1aaa1aaa1aaa1aaa1aaa1aaa1aaa1aaa";
const BLOB_B = "2bbb2bbb2bbb2bbb2bbb2bbb2bbb2bbb2bbb2bbb";
const BLOB_C = "3ccc3ccc3ccc3ccc3ccc3ccc3ccc3ccc3ccc3ccc";

const TREE_SRC_A = "4111111111111111111111111111111111111111";
const TREE_ROOT_A = "4222222222222222222222222222222222222222";
const TREE_SRC_B = "4333333333333333333333333333333333333333";
const TREE_ROOT_B = "4444444444444444444444444444444444444444";
const TREE_SRC_C = "4555555555555555555555555555555555555555";
const TREE_ROOT_C = "4666666666666666666666666666666666666666";

const COMMIT_A = "5111111111111111111111111111111111111111";
const COMMIT_B = "5222222222222222222222222222222222222222";
const COMMIT_C = "5333333333333333333333333333333333333333";

// Deep-path fixture
const BLOB_DEEP = "6111111111111111111111111111111111111111";
const TREE_DEEP_INNER = "6222222222222222222222222222222222222222";
const TREE_DEEP_MID = "6333333333333333333333333333333333333333";
const TREE_DEEP_ROOT = "6444444444444444444444444444444444444444";
const COMMIT_DEEP = "6555555555555555555555555555555555555555";

const CONTENT_A = "line one\nline two\n";
const CONTENT_B = "line one\nline two\nline three\n";
const CONTENT_C = "line one\nline two CHANGED\nline three\n";
const CONTENT_DEEP = "alpha\nbeta\ngamma\n";

const ALL_OBJECTS = new Set<string>([
  BLOB_A, BLOB_B, BLOB_C,
  TREE_SRC_A, TREE_ROOT_A,
  TREE_SRC_B, TREE_ROOT_B,
  TREE_SRC_C, TREE_ROOT_C,
  COMMIT_A, COMMIT_B, COMMIT_C,
  BLOB_DEEP,
  TREE_DEEP_INNER, TREE_DEEP_MID, TREE_DEEP_ROOT,
  COMMIT_DEEP,
]);

const lookup: CommitLookup = (sha) =>
  ALL_OBJECTS.has(sha) ? { looseKey: `${REPO}/loose/${sha}` } : null;

beforeAll(async () => {
  // Blobs
  await env.OBJECTS.put(`${REPO}/loose/${BLOB_A}`, encodeBlob(CONTENT_A));
  await env.OBJECTS.put(`${REPO}/loose/${BLOB_B}`, encodeBlob(CONTENT_B));
  await env.OBJECTS.put(`${REPO}/loose/${BLOB_C}`, encodeBlob(CONTENT_C));
  await env.OBJECTS.put(`${REPO}/loose/${BLOB_DEEP}`, encodeBlob(CONTENT_DEEP));

  // Trees: src/foo.txt at each version
  await env.OBJECTS.put(`${REPO}/loose/${TREE_SRC_A}`, encodeTree([
    { mode: "100644", name: "foo.txt", sha: BLOB_A },
  ]));
  await env.OBJECTS.put(`${REPO}/loose/${TREE_SRC_B}`, encodeTree([
    { mode: "100644", name: "foo.txt", sha: BLOB_B },
  ]));
  await env.OBJECTS.put(`${REPO}/loose/${TREE_SRC_C}`, encodeTree([
    { mode: "100644", name: "foo.txt", sha: BLOB_C },
  ]));

  // Root trees: src/ → src tree at each version
  await env.OBJECTS.put(`${REPO}/loose/${TREE_ROOT_A}`, encodeTree([
    { mode: "040000", name: "src", sha: TREE_SRC_A },
  ]));
  await env.OBJECTS.put(`${REPO}/loose/${TREE_ROOT_B}`, encodeTree([
    { mode: "040000", name: "src", sha: TREE_SRC_B },
  ]));
  await env.OBJECTS.put(`${REPO}/loose/${TREE_ROOT_C}`, encodeTree([
    { mode: "040000", name: "src", sha: TREE_SRC_C },
  ]));

  // Commits forming linear chain A ← B ← C
  await env.OBJECTS.put(`${REPO}/loose/${COMMIT_A}`, encodeCommit({
    tree: TREE_ROOT_A, parents: [], message: "add foo.txt", authorTs: 1700000000,
  }));
  await env.OBJECTS.put(`${REPO}/loose/${COMMIT_B}`, encodeCommit({
    tree: TREE_ROOT_B, parents: [COMMIT_A], message: "append line three", authorTs: 1700000100,
  }));
  await env.OBJECTS.put(`${REPO}/loose/${COMMIT_C}`, encodeCommit({
    tree: TREE_ROOT_C, parents: [COMMIT_B], message: "modify line two", authorTs: 1700000200,
  }));

  // Deep-path fixture: a/b/c/foo.txt, single commit
  await env.OBJECTS.put(`${REPO}/loose/${TREE_DEEP_INNER}`, encodeTree([
    { mode: "100644", name: "foo.txt", sha: BLOB_DEEP },
  ]));
  await env.OBJECTS.put(`${REPO}/loose/${TREE_DEEP_MID}`, encodeTree([
    { mode: "040000", name: "c", sha: TREE_DEEP_INNER },
  ]));
  await env.OBJECTS.put(`${REPO}/loose/${TREE_DEEP_ROOT}`, encodeTree([
    { mode: "040000", name: "b", sha: TREE_DEEP_MID },
  ]));
  await env.OBJECTS.put(`${REPO}/loose/${COMMIT_DEEP}`, encodeCommit({
    tree: TREE_DEEP_ROOT, parents: [], message: "deep path", authorTs: 1700000300,
  }));
});

// --- Tests -----------------------------------------------------------

describe("blameWalk", () => {
  it("attributes lines to their introducing commit across linear history", async () => {
    const result = await blameWalk({
      startSha: COMMIT_C,
      filePath: "src/foo.txt",
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(result).not.toBeNull();
    const blame = result!;
    expect(blame.length).toBe(3);

    // line "line one" — present in A, B, C unchanged → A
    expect(blame[0]).toEqual({ lineNumber: 1, line: "line one", commit: COMMIT_A });

    // line "line two CHANGED" — only in C (replaced original "line two") → C
    expect(blame[1]).toEqual({ lineNumber: 2, line: "line two CHANGED", commit: COMMIT_C });

    // line "line three" — added in B, kept in C → B
    expect(blame[2]).toEqual({ lineNumber: 3, line: "line three", commit: COMMIT_B });
  });

  it("attributes everything to the start commit when there are no parents", async () => {
    const result = await blameWalk({
      startSha: COMMIT_A,
      filePath: "src/foo.txt",
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(result).not.toBeNull();
    expect(result!.every((l) => l.commit === COMMIT_A)).toBe(true);
    expect(result!.map((l) => l.line)).toEqual(["line one", "line two"]);
  });

  it("walks the chain and attributes the appended line to its introducing commit", async () => {
    const result = await blameWalk({
      startSha: COMMIT_B,
      filePath: "src/foo.txt",
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    // "line one" and "line two" existed in A → attributed to A
    expect(result![0]!.commit).toBe(COMMIT_A);
    expect(result![1]!.commit).toBe(COMMIT_A);
    // "line three" was added in B → attributed to B
    expect(result![2]!.commit).toBe(COMMIT_B);
  });

  it("returns null when the file does not exist at startSha", async () => {
    const result = await blameWalk({
      startSha: COMMIT_C,
      filePath: "src/missing.txt",
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(result).toBeNull();
  });

  it("resolves nested tree paths (a/b/c/foo.txt)", async () => {
    const result = await blameWalk({
      startSha: COMMIT_DEEP,
      filePath: "b/c/foo.txt",
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result!.map((l) => l.line)).toEqual(["alpha", "beta", "gamma"]);
    expect(result!.every((l) => l.commit === COMMIT_DEEP)).toBe(true);
  });

  it("respects maxDepth and stops walking before reaching the root", async () => {
    // With depth=0 we never walk past the start commit, so the unchanged
    // line that "would" be attributed to A stays at the start commit C.
    const result = await blameWalk({
      startSha: COMMIT_C,
      filePath: "src/foo.txt",
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
      maxDepth: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.every((l) => l.commit === COMMIT_C)).toBe(true);
  });

  it("returns null for invalid file paths (empty)", async () => {
    const result = await blameWalk({
      startSha: COMMIT_A,
      filePath: "",
      repoPath: REPO,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(result).toBeNull();
  });
});

void PackWorkerDO;
