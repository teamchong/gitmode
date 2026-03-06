// Comprehensive integration tests for gitmode
//
// Runs inside the Cloudflare Workers runtime via @cloudflare/vitest-pool-workers.
// Uses real miniflare-backed R2 and Durable Objects — no mocking.
//
// Architecture: all git operations route through the RepoStore DO which
// owns per-repo SQLite (refs, metadata). Object storage uses R2 directly.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { GitEngine, OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "../src/git-engine";
import { WasmEngine } from "../src/wasm-engine";
import {
  encodePktLine,
  encodePktLineBytes,
  decodePktLine,
  parsePktLines,
  FLUSH_PKT,
} from "../src/pkt-line";
import { parseSSHCommand } from "../src/ssh-handler";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Helper: get a RepoStore DO handle for direct DO operations
function getStore(repoPath: string) {
  const id = env.REPO_STORE.idFromName(repoPath);
  return env.REPO_STORE.get(id);
}

// Helper: store an object through the DO
async function storeObjectViaDO(repoPath: string, type: number, content: Uint8Array): Promise<string> {
  const store = getStore(repoPath);
  const resp = await store.fetch(new Request("http://do/store-object", {
    method: "POST",
    body: content,
    headers: {
      "x-action": "store-object",
      "x-repo-path": repoPath,
      "x-object-type": String(type),
    },
  }));
  const { sha } = await resp.json() as { sha: string };
  return sha;
}

// Helper: read an object through the DO
async function readObjectViaDO(repoPath: string, sha: string) {
  const store = getStore(repoPath);
  const resp = await store.fetch(new Request(`http://do/read-object?sha=${sha}`, {
    method: "GET",
    headers: { "x-action": "read-object", "x-repo-path": repoPath },
  }));
  if (resp.status === 404) return null;
  return {
    type: parseInt(resp.headers.get("x-object-type") ?? "0", 10),
    content: new Uint8Array(await resp.arrayBuffer()),
  };
}

// Helper: set a ref through the DO
async function setRefViaDO(repoPath: string, name: string, sha: string) {
  const store = getStore(repoPath);
  await store.fetch(new Request("http://do/set-ref", {
    method: "POST",
    body: JSON.stringify({ name, sha }),
    headers: { "x-action": "set-ref", "x-repo-path": repoPath, "content-type": "application/json" },
  }));
}

// Helper: get a ref through the DO
async function getRefViaDO(repoPath: string, name: string): Promise<string | null> {
  const store = getStore(repoPath);
  const resp = await store.fetch(new Request(`http://do/get-ref?name=${name}`, {
    method: "GET",
    headers: { "x-action": "get-ref", "x-repo-path": repoPath },
  }));
  const { sha } = await resp.json() as { sha: string | null };
  return sha;
}

// Helper: delete a ref through the DO
async function deleteRefViaDO(repoPath: string, name: string) {
  const store = getStore(repoPath);
  await store.fetch(new Request("http://do/delete-ref", {
    method: "POST",
    body: JSON.stringify({ name }),
    headers: { "x-action": "delete-ref", "x-repo-path": repoPath, "content-type": "application/json" },
  }));
}

// Helper: list refs through the DO
async function listRefsViaDO(repoPath: string): Promise<Map<string, string>> {
  const store = getStore(repoPath);
  const resp = await store.fetch(new Request("http://do/list-refs", {
    method: "GET",
    headers: { "x-action": "list-refs", "x-repo-path": repoPath },
  }));
  const obj = await resp.json() as Record<string, string>;
  return new Map(Object.entries(obj));
}

// Helper: set HEAD through the DO
async function setHeadViaDO(repoPath: string, value: string) {
  const store = getStore(repoPath);
  await store.fetch(new Request("http://do/head", {
    method: "POST",
    body: JSON.stringify({ value }),
    headers: { "x-action": "set-head", "x-repo-path": repoPath, "content-type": "application/json" },
  }));
}

// ============================================================
// WASM Engine
// ============================================================
describe("WasmEngine", () => {
  let wasm: WasmEngine;

  beforeAll(async () => {
    wasm = await WasmEngine.create();
  });

  it("should instantiate WASM module", () => {
    expect(wasm).toBeDefined();
    expect(wasm.exports.memory).toBeDefined();
  });

  it("should allocate and free heap memory", () => {
    wasm.exports.resetHeap();
    const before = wasm.exports.getHeapUsed();
    expect(before).toBe(0);

    const ptr = wasm.exports.alloc(1024);
    expect(ptr).toBeGreaterThan(0);
    expect(wasm.exports.getHeapUsed()).toBeGreaterThan(before);

    wasm.exports.resetHeap();
    expect(wasm.exports.getHeapUsed()).toBe(0);
  });

  it("should write and read bytes from WASM memory", () => {
    wasm.exports.resetHeap();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const ptr = wasm.writeBytes(data);
    const result = wasm.readBytes(ptr, 5);
    expect(result).toEqual(data);
  });

  it("should compute SHA-1 hash", () => {
    const data = encoder.encode("hello world");
    const hex = wasm.sha1Hex(data);
    expect(hex).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });

  it("should compute git object hash (blob)", () => {
    const content = encoder.encode("hello world");
    const digest = wasm.hashObject(OBJ_BLOB, content);
    const hex = Array.from(digest)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex.length).toBe(40);
    expect(hex).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
  });

  it("should compress and decompress with zlib", () => {
    const original = encoder.encode(
      "AAAA BBBB CCCC DDDD ".repeat(500)
    );
    const compressed = wasm.zlibDeflate(original);
    expect(compressed.length).toBeGreaterThan(0);
    const decompressed = wasm.zlibInflate(compressed, original.length + 1024);
    expect(decompressed).toEqual(original);
  });

  it("should track consumed bytes in zlib inflate", () => {
    const original = encoder.encode("tracked inflate test data");
    const compressed = wasm.zlibDeflate(original);
    const withTrailing = new Uint8Array(compressed.length + 10);
    withTrailing.set(compressed);
    withTrailing.fill(0xff, compressed.length);
    const { data, consumed } = wasm.zlibInflateTracked(withTrailing, 1024);
    expect(data).toEqual(original);
    expect(consumed).toBe(compressed.length);
  });

  it("should create and apply deltas", () => {
    const base = encoder.encode("base content for delta testing " + "x".repeat(100));
    const target = encoder.encode("base content for delta testing " + "y".repeat(100));
    const delta = wasm.deltaCreate(base, target);
    expect(delta.length).toBeGreaterThan(0);
    expect(delta.length).toBeLessThan(target.length);
    const reconstructed = wasm.deltaApply(base, delta, target.length + 64);
    expect(reconstructed).toEqual(target);
  });
});

// ============================================================
// pkt-line encoding/decoding
// ============================================================
describe("pkt-line", () => {
  it("should encode pkt-line", () => {
    const encoded = encodePktLine("hello\n");
    const text = decoder.decode(encoded);
    expect(text).toBe("000ahello\n");
  });

  it("should encode binary pkt-line", () => {
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    const encoded = encodePktLineBytes(data);
    expect(decoder.decode(encoded.slice(0, 4))).toBe("0007");
    expect(encoded.slice(4)).toEqual(data);
  });

  it("should decode pkt-line", () => {
    const input = encoder.encode("000ahello\n0000");
    const result = decodePktLine(input, 0);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("data");
    expect(decoder.decode(result!.payload!)).toBe("hello\n");
    expect(result!.nextOffset).toBe(10);
  });

  it("should decode flush pkt", () => {
    const input = encoder.encode("0000");
    const result = decodePktLine(input, 0);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("flush");
    expect(result!.nextOffset).toBe(4);
  });

  it("should parse multiple pkt-lines with flush separators", () => {
    const input = encoder.encode("000ahello\n000aworld\n00000008bye\n0000");
    const sections = parsePktLines(input);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(decoder.decode(sections[0][0])).toBe("hello\n");
    expect(decoder.decode(sections[0][1])).toBe("world\n");
    expect(decoder.decode(sections[1][0])).toBe("bye\n");
  });
});

// ============================================================
// GitEngine — R2 object operations (no DO needed)
// ============================================================
describe("GitEngine objects", () => {
  let engine: GitEngine;

  beforeEach(async () => {
    engine = new GitEngine(env.OBJECTS, "objtest/repo");
    const listed = await env.OBJECTS.list({ prefix: "objtest/repo/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
  });

  it("should store and retrieve a blob", async () => {
    const content = encoder.encode("file content");
    const sha = await engine.storeObject(OBJ_BLOB, content);
    expect(sha.length).toBe(40);
    expect(await engine.hasObject(sha)).toBe(true);
    const obj = await engine.readObject(sha);
    expect(obj).not.toBeNull();
    expect(obj!.type).toBe(OBJ_BLOB);
    expect(obj!.content).toEqual(content);
  });

  it("should return null for missing objects", async () => {
    const obj = await engine.readObject("0".repeat(40));
    expect(obj).toBeNull();
  });

  it("should store and read a commit object", async () => {
    const blobContent = encoder.encode("test file");
    const blobSha = await engine.storeObject(OBJ_BLOB, blobContent);
    const blobShaBytes = hexToBytes(blobSha);
    const treeContent = buildTreeEntry("100644", "test.txt", blobShaBytes);
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);
    const commitContent = encoder.encode(
      `tree ${treeSha}\nauthor Test <test@test.com> 1700000000 +0000\ncommitter Test <test@test.com> 1700000000 +0000\n\nInitial commit\n`
    );
    const commitSha = await engine.storeObject(OBJ_COMMIT, commitContent);
    const obj = await engine.readObject(commitSha);
    expect(obj).not.toBeNull();
    expect(obj!.type).toBe(OBJ_COMMIT);
    const text = decoder.decode(obj!.content);
    expect(text).toContain(`tree ${treeSha}`);
    expect(text).toContain("Initial commit");
  });
});

// ============================================================
// GitEngine — DO SQLite ref operations (via DO handle)
// ============================================================
describe("GitEngine refs (via DO)", () => {
  const repo = "reftest/repo";

  it("should set, get, and delete refs", async () => {
    await setRefViaDO(repo, "heads/main", "abc123" + "0".repeat(34));
    const ref = await getRefViaDO(repo, "heads/main");
    expect(ref).toBe("abc123" + "0".repeat(34));
    await deleteRefViaDO(repo, "heads/main");
    const deleted = await getRefViaDO(repo, "heads/main");
    expect(deleted).toBeNull();
  });

  it("should list all refs", async () => {
    await setRefViaDO(repo, "heads/main", "a".repeat(40));
    await setRefViaDO(repo, "heads/dev", "b".repeat(40));
    await setRefViaDO(repo, "tags/v1", "c".repeat(40));
    const refs = await listRefsViaDO(repo);
    expect(refs.size).toBeGreaterThanOrEqual(3);
    expect(refs.get("heads/main")).toBe("a".repeat(40));
    expect(refs.get("heads/dev")).toBe("b".repeat(40));
    expect(refs.get("tags/v1")).toBe("c".repeat(40));
  });

  it("should set and get HEAD", async () => {
    await setHeadViaDO(repo, "ref: refs/heads/main");
    const store = getStore(repo);
    const resp = await store.fetch(new Request("http://do/head", {
      method: "GET",
      headers: { "x-action": "head", "x-repo-path": repo },
    }));
    const text = await resp.text();
    expect(text.trim()).toBe("ref: refs/heads/main");
  });
});

// ============================================================
// HTTP Git Protocol (info-refs, upload-pack, receive-pack)
// ============================================================
describe("Git Protocol", () => {
  it("should return empty ref advertisement for new repo", async () => {
    const response = await SELF.fetch(
      "http://localhost/proto/newrepo.git/info/refs?service=git-upload-pack"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-git-upload-pack-advertisement"
    );
    const body = new Uint8Array(await response.arrayBuffer());
    const sections = parsePktLines(body);
    expect(decoder.decode(sections[0][0])).toContain("# service=git-upload-pack");
    const capLine = decoder.decode(sections[1][0]);
    expect(capLine).toContain("0".repeat(40));
    expect(capLine).toContain("report-status");
  });

  it("should advertise refs after push", async () => {
    const repo = "proto/advrefs";
    const blobSha = await storeObjectViaDO(repo, OBJ_BLOB, encoder.encode("hello"));
    const treeBytes = buildTreeEntry("100644", "file.txt", hexToBytes(blobSha));
    const treeSha = await storeObjectViaDO(repo, OBJ_TREE, treeBytes);
    const commitContent = encoder.encode(
      `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\ntest\n`
    );
    const commitSha = await storeObjectViaDO(repo, OBJ_COMMIT, commitContent);
    await setRefViaDO(repo, "heads/main", commitSha);
    await setHeadViaDO(repo, "ref: refs/heads/main");

    const response = await SELF.fetch(
      `http://localhost/${repo}.git/info/refs?service=git-upload-pack`
    );
    const body = new Uint8Array(await response.arrayBuffer());
    const text = decoder.decode(body);
    expect(text).toContain(commitSha);
    expect(text).toContain("HEAD");
    expect(text).toContain("refs/heads/main");
  });

  it("should reject unsupported services", async () => {
    const response = await SELF.fetch(
      "http://localhost/proto/repo.git/info/refs?service=git-archive"
    );
    expect(response.status).toBe(403);
  });

  it("should return HEAD for repo", async () => {
    const repo = "proto/headtest";
    await setHeadViaDO(repo, "ref: refs/heads/main");
    const response = await SELF.fetch(`http://localhost/${repo}.git/HEAD`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.trim()).toBe("ref: refs/heads/main");
  });

  it("should return default HEAD for empty repo", async () => {
    const response = await SELF.fetch(
      "http://localhost/proto/emptyhead.git/HEAD"
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.trim()).toBe("ref: refs/heads/main");
  });
});

// ============================================================
// End-to-end: push + clone cycle
// ============================================================
describe("Push and Clone", () => {
  it("should store objects and read them back", async () => {
    const repo = "e2e/testrepo";
    const blobContent = encoder.encode("Hello from gitmode!\n");
    const blobSha = await storeObjectViaDO(repo, OBJ_BLOB, blobContent);
    const treeContent = buildTreeEntry("100644", "README.md", hexToBytes(blobSha));
    const treeSha = await storeObjectViaDO(repo, OBJ_TREE, treeContent);
    const commitText = [
      `tree ${treeSha}`,
      "author Test User <test@example.com> 1700000000 +0000",
      "committer Test User <test@example.com> 1700000000 +0000",
      "",
      "Initial commit\n",
    ].join("\n");
    const commitSha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commitText));
    await setRefViaDO(repo, "heads/main", commitSha);

    const commit = await readObjectViaDO(repo, commitSha);
    expect(commit).not.toBeNull();
    expect(commit!.type).toBe(OBJ_COMMIT);
    const commitContent = decoder.decode(commit!.content);
    const treeMatch = commitContent.match(/^tree ([0-9a-f]{40})/m);
    expect(treeMatch).not.toBeNull();
    expect(treeMatch![1]).toBe(treeSha);
  });

  it("should handle multiple commits with parent references", async () => {
    const repo = "e2e/multicommit";
    const blob1Sha = await storeObjectViaDO(repo, OBJ_BLOB, encoder.encode("v1"));
    const tree1Content = buildTreeEntry("100644", "file.txt", hexToBytes(blob1Sha));
    const tree1Sha = await storeObjectViaDO(repo, OBJ_TREE, tree1Content);
    const commit1Text = `tree ${tree1Sha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nFirst commit\n`;
    const commit1Sha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commit1Text));

    const blob2Sha = await storeObjectViaDO(repo, OBJ_BLOB, encoder.encode("v2"));
    const tree2Content = buildTreeEntry("100644", "file.txt", hexToBytes(blob2Sha));
    const tree2Sha = await storeObjectViaDO(repo, OBJ_TREE, tree2Content);
    const commit2Text = `tree ${tree2Sha}\nparent ${commit1Sha}\nauthor A <a@a.com> 1700001000 +0000\ncommitter A <a@a.com> 1700001000 +0000\n\nSecond commit\n`;
    const commit2Sha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commit2Text));
    await setRefViaDO(repo, "heads/main", commit2Sha);

    const commit2 = await readObjectViaDO(repo, commit2Sha);
    const text2 = decoder.decode(commit2!.content);
    expect(text2).toContain(`parent ${commit1Sha}`);

    const commit1 = await readObjectViaDO(repo, commit1Sha);
    const text1 = decoder.decode(commit1!.content);
    expect(text1).not.toContain("parent");
  });
});

// ============================================================
// Worktree materialization
// ============================================================
describe("Worktree", () => {
  it("should materialize worktree files to R2", async () => {
    const { materializeWorktree } = await import("../src/checkout");
    const repo = "wt/flat";
    const blobContent = encoder.encode("file content here");
    const blobSha = await storeObjectViaDO(repo, OBJ_BLOB, blobContent);
    const treeContent = buildTreeEntry("100644", "README.md", hexToBytes(blobSha));
    const treeSha = await storeObjectViaDO(repo, OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\ntest\n`;
    const commitSha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commitText));

    const engine = new GitEngine(env.OBJECTS, repo);
    await materializeWorktree(engine, env, repo, "main", commitSha);

    const worktreeObj = await env.OBJECTS.get(`${repo}/worktrees/main/README.md`);
    expect(worktreeObj).not.toBeNull();
    const worktreeContent = await worktreeObj!.text();
    expect(worktreeContent).toBe("file content here");
  });

  it("should materialize nested directories", async () => {
    const { materializeWorktree } = await import("../src/checkout");
    const repo = "wt/nested";
    const blob1Sha = await storeObjectViaDO(repo, OBJ_BLOB, encoder.encode("package.json content"));
    const blob2Sha = await storeObjectViaDO(repo, OBJ_BLOB, encoder.encode("main.ts content"));

    const subTreeContent = buildTreeEntry("100644", "main.ts", hexToBytes(blob2Sha));
    const subTreeSha = await storeObjectViaDO(repo, OBJ_TREE, subTreeContent);

    const rootTreeContent = concatBytes(
      buildTreeEntry("100644", "package.json", hexToBytes(blob1Sha)),
      buildTreeEntry("40000", "src", hexToBytes(subTreeSha))
    );
    const rootTreeSha = await storeObjectViaDO(repo, OBJ_TREE, rootTreeContent);

    const commitText = `tree ${rootTreeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\ntest\n`;
    const commitSha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commitText));

    const engine = new GitEngine(env.OBJECTS, repo);
    await materializeWorktree(engine, env, repo, "main", commitSha);

    const pkg = await env.OBJECTS.get(`${repo}/worktrees/main/package.json`);
    expect(pkg).not.toBeNull();
    expect(await pkg!.text()).toBe("package.json content");

    const main = await env.OBJECTS.get(`${repo}/worktrees/main/src/main.ts`);
    expect(main).not.toBeNull();
    expect(await main!.text()).toBe("main.ts content");
  });
});

// ============================================================
// DO Metadata
// ============================================================
describe("DO Metadata", () => {
  it("should create repo in DO", async () => {
    const repo = "meta/testrepo";
    const store = getStore(repo);
    const resp = await store.fetch(new Request("http://do/ensure-repo", {
      method: "POST",
      headers: { "x-action": "ensure-repo", "x-repo-path": repo },
    }));
    expect(resp.status).toBe(200);

    // Verify idempotent
    const resp2 = await store.fetch(new Request("http://do/ensure-repo", {
      method: "POST",
      headers: { "x-action": "ensure-repo", "x-repo-path": repo },
    }));
    expect(resp2.status).toBe(200);
  });

  it("should index commits in DO", async () => {
    const repo = "meta/commitrepo";
    const store = getStore(repo);
    const body = JSON.stringify({
      sha: "a".repeat(40),
      author: "Test Author",
      message: "Add feature",
      timestamp: 1700000000,
    });
    const resp = await store.fetch(new Request("http://do/index-commit", {
      method: "POST",
      body,
      headers: {
        "x-action": "index-commit",
        "x-repo-path": repo,
        "content-type": "application/json",
      },
    }));
    expect(resp.status).toBe(200);

    // Idempotent via INSERT OR IGNORE
    const resp2 = await store.fetch(new Request("http://do/index-commit", {
      method: "POST",
      body,
      headers: {
        "x-action": "index-commit",
        "x-repo-path": repo,
        "content-type": "application/json",
      },
    }));
    expect(resp2.status).toBe(200);
  });
});

// ============================================================
// Packfile roundtrip (build + parse)
// ============================================================
describe("Packfile", () => {
  it("should build a packfile and unpack it back", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");
    const { unpackPackfile } = await import("../src/packfile-reader");

    const engine = new GitEngine(env.OBJECTS, "pack/repo");
    const blob1Content = encoder.encode("file one content");
    const blob1Sha = await engine.storeObject(OBJ_BLOB, blob1Content);
    const blob2Content = encoder.encode("file two content");
    const blob2Sha = await engine.storeObject(OBJ_BLOB, blob2Content);
    const treeContent = concatBytes(
      buildTreeEntry("100644", "one.txt", hexToBytes(blob1Sha)),
      buildTreeEntry("100644", "two.txt", hexToBytes(blob2Sha))
    );
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\npack test\n`;
    const commitSha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commitText));

    const pack = await buildPackfile(engine, [commitSha, treeSha, blob1Sha, blob2Sha]);
    expect(pack.length).toBeGreaterThan(32);
    expect(decoder.decode(pack.slice(0, 4))).toBe("PACK");
    const version = (pack[4] << 24) | (pack[5] << 16) | (pack[6] << 8) | pack[7];
    expect(version).toBe(2);
    const numObjects = (pack[8] << 24) | (pack[9] << 16) | (pack[10] << 8) | pack[11];
    expect(numObjects).toBe(4);

    const engine2 = new GitEngine(env.OBJECTS, "pack/repo2");
    await unpackPackfile(engine2, pack);

    const blob1 = await engine2.readObject(blob1Sha);
    expect(blob1).not.toBeNull();
    expect(blob1!.type).toBe(OBJ_BLOB);
    expect(decoder.decode(blob1!.content)).toBe("file one content");

    const blob2 = await engine2.readObject(blob2Sha);
    expect(blob2).not.toBeNull();
    expect(decoder.decode(blob2!.content)).toBe("file two content");
  });
});

// ============================================================
// HTTP receive-pack (push via HTTP POST)
// ============================================================
describe("HTTP receive-pack", () => {
  it("should accept a push with packfile and update refs", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");
    const repo = "push/repo";

    const tmpEngine = new GitEngine(env.OBJECTS, "push/tmp");
    const blobContent = encoder.encode("pushed file\n");
    const blobSha = await tmpEngine.storeObject(OBJ_BLOB, blobContent);
    const treeContent = buildTreeEntry("100644", "hello.txt", hexToBytes(blobSha));
    const treeSha = await tmpEngine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor Push User <push@test.com> 1700000000 +0000\ncommitter Push User <push@test.com> 1700000000 +0000\n\npush test\n`;
    const commitSha = await tmpEngine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    const packData = await buildPackfile(tmpEngine, [commitSha, treeSha, blobSha]);

    const ZERO = "0".repeat(40);
    const refLine = `${ZERO} ${commitSha} refs/heads/main\0report-status side-band-64k\n`;
    const body = concatBytes(encodePktLine(refLine), FLUSH_PKT, packData);

    const response = await SELF.fetch(
      `http://localhost/${repo}.git/git-receive-pack`,
      { method: "POST", body, headers: { "Content-Type": "application/x-git-receive-pack-request" } }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-git-receive-pack-result");

    const responseBody = new Uint8Array(await response.arrayBuffer());
    const responseText = decoder.decode(responseBody);
    expect(responseText).toContain("unpack ok");
    expect(responseText).toContain("ok refs/heads/main");

    const ref = await getRefViaDO(repo, "heads/main");
    expect(ref).toBe(commitSha);
  });

  it("should reject non-fast-forward push", async () => {
    const repo = "push/nff";
    const engine = new GitEngine(env.OBJECTS, repo);
    const blobSha = await engine.storeObject(OBJ_BLOB, encoder.encode("existing"));
    const treeContent = buildTreeEntry("100644", "f.txt", hexToBytes(blobSha));
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nexisting\n`;
    const existingSha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    await setRefViaDO(repo, "heads/main", existingSha);

    const wrongOld = "f".repeat(40);
    const newSha = "a".repeat(40);
    const refLine = `${wrongOld} ${newSha} refs/heads/main\0report-status\n`;
    const body = concatBytes(encodePktLine(refLine), FLUSH_PKT);

    const response = await SELF.fetch(
      `http://localhost/${repo}.git/git-receive-pack`,
      { method: "POST", body }
    );
    const responseText = decoder.decode(new Uint8Array(await response.arrayBuffer()));
    expect(responseText).toContain("non-fast-forward");

    const ref = await getRefViaDO(repo, "heads/main");
    expect(ref).toBe(existingSha);
  });
});

// ============================================================
// HTTP upload-pack (clone/fetch via HTTP POST)
// ============================================================
describe("HTTP upload-pack", () => {
  let commitSha: string;
  let blobSha: string;
  const repo = "clone/repo";

  beforeAll(async () => {
    const content = encoder.encode("cloned content\n");
    blobSha = await storeObjectViaDO(repo, OBJ_BLOB, content);
    const treeContent = buildTreeEntry("100644", "file.txt", hexToBytes(blobSha));
    const treeSha = await storeObjectViaDO(repo, OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nclone test\n`;
    commitSha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commitText));
    await setRefViaDO(repo, "heads/main", commitSha);
    await setHeadViaDO(repo, "ref: refs/heads/main");
  });

  it("should serve objects in a packfile for clone", async () => {
    const wantLine = `want ${commitSha} side-band-64k\n`;
    const body = concatBytes(
      encodePktLine(wantLine), FLUSH_PKT,
      encodePktLine("done\n"), FLUSH_PKT
    );
    const response = await SELF.fetch(
      `http://localhost/${repo}.git/git-upload-pack`,
      { method: "POST", body }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-git-upload-pack-result");

    const responseBody = new Uint8Array(await response.arrayBuffer());
    const responseText = decoder.decode(responseBody);
    expect(responseText).toContain("NAK");

    let packFound = false;
    for (let i = 0; i < responseBody.length - 4; i++) {
      if (responseBody[i] === 0x50 && responseBody[i + 1] === 0x41 &&
          responseBody[i + 2] === 0x43 && responseBody[i + 3] === 0x4b) {
        packFound = true;
        break;
      }
    }
    expect(packFound).toBe(true);
  });

  it("should return error for empty wants", async () => {
    const response = await SELF.fetch(
      `http://localhost/${repo}.git/git-upload-pack`,
      { method: "POST", body: concatBytes(FLUSH_PKT, encodePktLine("done\n"), FLUSH_PKT) }
    );
    expect(response.status).toBe(400);
  });
});

// ============================================================
// Full push → info-refs → clone cycle (end-to-end HTTP)
// ============================================================
describe("Full HTTP push-clone cycle", () => {
  it("should push objects, advertise refs, then clone them back", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");
    const { unpackPackfile } = await import("../src/packfile-reader");
    const repoName = "cycle/fulltest";

    const tmpEngine = new GitEngine(env.OBJECTS, "cycle/tmp");
    const fileContent = encoder.encode("full cycle test content\n");
    const blobSha = await tmpEngine.storeObject(OBJ_BLOB, fileContent);
    const treeContent = buildTreeEntry("100644", "readme.txt", hexToBytes(blobSha));
    const treeSha = await tmpEngine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor Cycle <c@c.com> 1700000000 +0000\ncommitter Cycle <c@c.com> 1700000000 +0000\n\nfull cycle\n`;
    const commitSha = await tmpEngine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    const packData = await buildPackfile(tmpEngine, [commitSha, treeSha, blobSha]);

    const ZERO = "0".repeat(40);
    const pushBody = concatBytes(
      encodePktLine(`${ZERO} ${commitSha} refs/heads/main\0report-status side-band-64k\n`),
      FLUSH_PKT, packData
    );
    const pushResp = await SELF.fetch(
      `http://localhost/${repoName}.git/git-receive-pack`,
      { method: "POST", body: pushBody }
    );
    expect(pushResp.status).toBe(200);
    const pushText = decoder.decode(new Uint8Array(await pushResp.arrayBuffer()));
    expect(pushText).toContain("unpack ok");
    expect(pushText).toContain("ok refs/heads/main");

    const infoResp = await SELF.fetch(
      `http://localhost/${repoName}.git/info/refs?service=git-upload-pack`
    );
    expect(infoResp.status).toBe(200);
    const infoText = decoder.decode(new Uint8Array(await infoResp.arrayBuffer()));
    expect(infoText).toContain(commitSha);

    const cloneBody = concatBytes(
      encodePktLine(`want ${commitSha} side-band-64k\n`),
      FLUSH_PKT, encodePktLine("done\n"), FLUSH_PKT
    );
    const cloneResp = await SELF.fetch(
      `http://localhost/${repoName}.git/git-upload-pack`,
      { method: "POST", body: cloneBody }
    );
    expect(cloneResp.status).toBe(200);

    const cloneData = new Uint8Array(await cloneResp.arrayBuffer());
    const extractedPack = extractPackFromSideband(cloneData);
    expect(extractedPack).not.toBeNull();
    expect(extractedPack!.length).toBeGreaterThan(20);

    const cloneEngine = new GitEngine(env.OBJECTS, "cycle/cloned");
    await unpackPackfile(cloneEngine, extractedPack!);

    const clonedBlob = await cloneEngine.readObject(blobSha);
    expect(clonedBlob).not.toBeNull();
    expect(clonedBlob!.type).toBe(OBJ_BLOB);
    expect(decoder.decode(clonedBlob!.content)).toBe("full cycle test content\n");

    const clonedCommit = await cloneEngine.readObject(commitSha);
    expect(clonedCommit).not.toBeNull();
    expect(clonedCommit!.type).toBe(OBJ_COMMIT);
    const clonedCommitText = decoder.decode(clonedCommit!.content);
    expect(clonedCommitText).toContain(`tree ${treeSha}`);
    expect(clonedCommitText).toContain("full cycle");
  });
});

// ============================================================
// libgit2 WASM exports
// ============================================================
describe("libgit2 exports", () => {
  let wasm: WasmEngine;

  beforeAll(async () => {
    wasm = await WasmEngine.create();
  });

  it("should have libgit2_init export", () => {
    expect(typeof wasm.exports.libgit2_init).toBe("function");
  });
  it("should have libgit2_shutdown export", () => {
    expect(typeof wasm.exports.libgit2_shutdown).toBe("function");
  });
  it("should have libgit2_diff export", () => {
    expect(typeof wasm.exports.libgit2_diff).toBe("function");
  });
  it("should have libgit2_revwalk export", () => {
    expect(typeof wasm.exports.libgit2_revwalk).toBe("function");
  });
  it("should have libgit2_blame export", () => {
    expect(typeof wasm.exports.libgit2_blame).toBe("function");
  });
  it("should initialize libgit2 without crashing", () => {
    const result = wasm.exports.libgit2_init();
    expect(typeof result).toBe("number");
  });
});

// ============================================================
// Worktree after push (via receive-pack)
// ============================================================
describe("Worktree via push", () => {
  it("should materialize worktree files after receive-pack", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");
    const repo = "wtp/repo";
    const tmpEngine = new GitEngine(env.OBJECTS, "wtp/tmp");
    const fileContent = encoder.encode("worktree pushed content\n");
    const blobSha = await tmpEngine.storeObject(OBJ_BLOB, fileContent);
    const treeContent = buildTreeEntry("100644", "index.html", hexToBytes(blobSha));
    const treeSha = await tmpEngine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor W <w@w.com> 1700000000 +0000\ncommitter W <w@w.com> 1700000000 +0000\n\nwt push\n`;
    const commitSha = await tmpEngine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    const packData = await buildPackfile(tmpEngine, [commitSha, treeSha, blobSha]);

    const ZERO = "0".repeat(40);
    const pushBody = concatBytes(
      encodePktLine(`${ZERO} ${commitSha} refs/heads/main\0report-status side-band-64k\n`),
      FLUSH_PKT, packData
    );
    const response = await SELF.fetch(
      `http://localhost/${repo}.git/git-receive-pack`,
      { method: "POST", body: pushBody }
    );
    expect(response.status).toBe(200);

    const worktreeFile = await env.OBJECTS.get(`${repo}/worktrees/main/index.html`);
    expect(worktreeFile).not.toBeNull();
    expect(await worktreeFile!.text()).toBe("worktree pushed content\n");
  });
});

// ============================================================
// Tag objects
// ============================================================
describe("Tag objects", () => {
  it("should store and read a tag object", async () => {
    const repo = "tag/store";
    const blobSha = await storeObjectViaDO(repo, OBJ_BLOB, encoder.encode("tagged"));
    const treeContent = buildTreeEntry("100644", "f.txt", hexToBytes(blobSha));
    const treeSha = await storeObjectViaDO(repo, OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\ntagged commit\n`;
    const commitSha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commitText));

    const tagContent = encoder.encode(
      `object ${commitSha}\ntype commit\ntag v1.0\ntagger A <a@a.com> 1700000000 +0000\n\nRelease v1.0\n`
    );
    const tagSha = await storeObjectViaDO(repo, OBJ_TAG, tagContent);

    const obj = await readObjectViaDO(repo, tagSha);
    expect(obj).not.toBeNull();
    expect(obj!.type).toBe(OBJ_TAG);
    const text = decoder.decode(obj!.content);
    expect(text).toContain(`object ${commitSha}`);
    expect(text).toContain("tag v1.0");
    expect(text).toContain("Release v1.0");
  });
});

// ============================================================
// Ref deletion via push
// ============================================================
describe("Ref deletion via push", () => {
  it("should delete a ref when new SHA is zero", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");
    const repo = "del/repo";
    const engine = new GitEngine(env.OBJECTS, repo);
    const blobSha = await engine.storeObject(OBJ_BLOB, encoder.encode("delete me"));
    const treeContent = buildTreeEntry("100644", "f.txt", hexToBytes(blobSha));
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nto delete\n`;
    const commitSha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commitText));

    const packData = await buildPackfile(engine, [commitSha, treeSha, blobSha]);
    const ZERO = "0".repeat(40);
    const pushBody = concatBytes(
      encodePktLine(`${ZERO} ${commitSha} refs/heads/feature\0report-status side-band-64k\n`),
      FLUSH_PKT, packData
    );
    await SELF.fetch(`http://localhost/${repo}.git/git-receive-pack`, {
      method: "POST", body: pushBody,
    });

    expect(await getRefViaDO(repo, "heads/feature")).toBe(commitSha);

    const deleteBody = concatBytes(
      encodePktLine(`${commitSha} ${ZERO} refs/heads/feature\0report-status side-band-64k\n`),
      FLUSH_PKT
    );
    const delResp = await SELF.fetch(`http://localhost/${repo}.git/git-receive-pack`, {
      method: "POST", body: deleteBody,
    });
    expect(delResp.status).toBe(200);
    const delText = decoder.decode(new Uint8Array(await delResp.arrayBuffer()));
    expect(delText).toContain("ok refs/heads/feature");
    expect(await getRefViaDO(repo, "heads/feature")).toBeNull();
  });
});

// ============================================================
// Multiple ref updates in single push
// ============================================================
describe("Multiple ref updates", () => {
  it("should update multiple refs in a single receive-pack", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");
    const repo = "multi/repo";
    const engine = new GitEngine(env.OBJECTS, repo);
    const blobSha = await engine.storeObject(OBJ_BLOB, encoder.encode("multi ref test"));
    const treeContent = buildTreeEntry("100644", "f.txt", hexToBytes(blobSha));
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nmulti\n`;
    const commitSha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    const packData = await buildPackfile(engine, [commitSha, treeSha, blobSha]);
    const ZERO = "0".repeat(40);

    const body = concatBytes(
      encodePktLine(`${ZERO} ${commitSha} refs/heads/main\0report-status side-band-64k\n`),
      encodePktLine(`${ZERO} ${commitSha} refs/heads/dev\n`),
      FLUSH_PKT, packData
    );
    const resp = await SELF.fetch(`http://localhost/${repo}.git/git-receive-pack`, {
      method: "POST", body,
    });
    expect(resp.status).toBe(200);
    const text = decoder.decode(new Uint8Array(await resp.arrayBuffer()));
    expect(text).toContain("ok refs/heads/main");
    expect(text).toContain("ok refs/heads/dev");
    expect(await getRefViaDO(repo, "heads/main")).toBe(commitSha);
    expect(await getRefViaDO(repo, "heads/dev")).toBe(commitSha);
  });
});

// ============================================================
// info-refs for git-receive-pack service
// ============================================================
describe("info-refs receive-pack", () => {
  it("should return receive-pack advertisement", async () => {
    const response = await SELF.fetch(
      "http://localhost/irp/repo.git/info/refs?service=git-receive-pack"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-git-receive-pack-advertisement"
    );
    const body = new Uint8Array(await response.arrayBuffer());
    const sections = parsePktLines(body);
    expect(decoder.decode(sections[0][0])).toContain("# service=git-receive-pack");
  });
});

// ============================================================
// Incremental fetch (have lines in upload-pack)
// ============================================================
describe("Incremental fetch with haves", () => {
  const repo = "fetch/repo";
  let commit1Sha: string;
  let commit2Sha: string;

  beforeAll(async () => {
    const blob1Sha = await storeObjectViaDO(repo, OBJ_BLOB, encoder.encode("v1"));
    const tree1Content = buildTreeEntry("100644", "f.txt", hexToBytes(blob1Sha));
    const tree1Sha = await storeObjectViaDO(repo, OBJ_TREE, tree1Content);
    const commit1Text = `tree ${tree1Sha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nfirst\n`;
    commit1Sha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commit1Text));

    const blob2Sha = await storeObjectViaDO(repo, OBJ_BLOB, encoder.encode("v2"));
    const tree2Content = buildTreeEntry("100644", "f.txt", hexToBytes(blob2Sha));
    const tree2Sha = await storeObjectViaDO(repo, OBJ_TREE, tree2Content);
    const commit2Text = `tree ${tree2Sha}\nparent ${commit1Sha}\nauthor A <a@a.com> 1700001000 +0000\ncommitter A <a@a.com> 1700001000 +0000\n\nsecond\n`;
    commit2Sha = await storeObjectViaDO(repo, OBJ_COMMIT, encoder.encode(commit2Text));
    await setRefViaDO(repo, "heads/main", commit2Sha);
    await setHeadViaDO(repo, "ref: refs/heads/main");
  });

  it("should exclude objects reachable from haves", async () => {
    const { unpackPackfile } = await import("../src/packfile-reader");
    const body = concatBytes(
      encodePktLine(`want ${commit2Sha} side-band-64k\n`),
      FLUSH_PKT,
      encodePktLine(`have ${commit1Sha}\n`),
      encodePktLine("done\n"),
      FLUSH_PKT
    );
    const resp = await SELF.fetch(`http://localhost/${repo}.git/git-upload-pack`, {
      method: "POST", body,
    });
    expect(resp.status).toBe(200);

    const respData = new Uint8Array(await resp.arrayBuffer());
    const pack = extractPackFromSideband(respData);
    expect(pack).not.toBeNull();

    const fetchEngine = new GitEngine(env.OBJECTS, "fetch/cloned");
    await unpackPackfile(fetchEngine, pack!);
    expect(await fetchEngine.hasObject(commit2Sha)).toBe(true);
    expect(await fetchEngine.hasObject(commit1Sha)).toBe(false);
  });
});

// ============================================================
// SSH command parsing
// ============================================================
describe("SSH command parsing", () => {
  it("should parse git-upload-pack with quotes", () => {
    const cmd = parseSSHCommand("git-upload-pack '/owner/repo.git'");
    expect(cmd).not.toBeNull();
    expect(cmd!.service).toBe("git-upload-pack");
    expect(cmd!.repoPath).toBe("owner/repo");
  });
  it("should parse git-receive-pack with quotes", () => {
    const cmd = parseSSHCommand("git-receive-pack '/owner/repo.git'");
    expect(cmd).not.toBeNull();
    expect(cmd!.service).toBe("git-receive-pack");
    expect(cmd!.repoPath).toBe("owner/repo");
  });
  it("should parse space-separated format", () => {
    const cmd = parseSSHCommand("git upload-pack '/owner/repo.git'");
    expect(cmd).not.toBeNull();
    expect(cmd!.service).toBe("git-upload-pack");
    expect(cmd!.repoPath).toBe("owner/repo");
  });
  it("should parse without .git suffix", () => {
    const cmd = parseSSHCommand("git-upload-pack '/owner/repo'");
    expect(cmd).not.toBeNull();
    expect(cmd!.repoPath).toBe("owner/repo");
  });
  it("should return null for invalid commands", () => {
    expect(parseSSHCommand("ls -la")).toBeNull();
    expect(parseSSHCommand("git status")).toBeNull();
    expect(parseSSHCommand("")).toBeNull();
  });
});

// ============================================================
// Helpers
// ============================================================

function extractPackFromSideband(data: Uint8Array): Uint8Array | null {
  const packChunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length) {
    const pkt = decodePktLine(data, offset);
    if (!pkt) break;
    offset = pkt.nextOffset;
    if (pkt.type === "flush") continue;
    if (pkt.type !== "data" || !pkt.payload || pkt.payload.length === 0) continue;
    const channel = pkt.payload[0];
    if (channel === 0x01) {
      packChunks.push(pkt.payload.slice(1));
    }
  }
  if (packChunks.length === 0) return null;
  return concatBytes(...packChunks);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function buildTreeEntry(mode: string, name: string, sha: Uint8Array): Uint8Array {
  const modeBytes = encoder.encode(mode);
  const nameBytes = encoder.encode(name);
  const entry = new Uint8Array(modeBytes.length + 1 + nameBytes.length + 1 + 20);
  let offset = 0;
  entry.set(modeBytes, offset); offset += modeBytes.length;
  entry[offset++] = 0x20;
  entry.set(nameBytes, offset); offset += nameBytes.length;
  entry[offset++] = 0x00;
  entry.set(sha, offset);
  return entry;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
