// Comprehensive integration tests for gitmode
//
// Runs inside the Cloudflare Workers runtime via @cloudflare/vitest-pool-workers.
// Uses real miniflare-backed R2, KV, D1 bindings — no mocking.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { GitEngine, OBJ_BLOB, OBJ_TREE, OBJ_COMMIT } from "../src/git-engine";
import { WasmEngine } from "../src/wasm-engine";
import {
  encodePktLine,
  encodePktLineBytes,
  decodePktLine,
  parsePktLines,
  FLUSH_PKT,
} from "../src/pkt-line";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    // SHA-1 of "hello world"
    expect(hex).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });

  it("should compute git object hash (blob)", () => {
    const content = encoder.encode("hello world");
    const digest = wasm.hashObject(OBJ_BLOB, content);
    // git hash-object -t blob: "blob 11\0hello world"
    const hex = Array.from(digest)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // This should match `echo -n "hello world" | git hash-object --stdin`
    expect(hex.length).toBe(40);
    expect(hex).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
  });

  it("should compress and decompress with zlib", () => {
    const original = encoder.encode(
      "AAAA BBBB CCCC DDDD ".repeat(500)
    );
    const compressed = wasm.zlibDeflate(original);

    // Compressed should produce valid output
    expect(compressed.length).toBeGreaterThan(0);

    // Roundtrip: decompress should recover original data exactly
    const decompressed = wasm.zlibInflate(compressed, original.length + 1024);
    expect(decompressed).toEqual(original);
  });

  it("should track consumed bytes in zlib inflate", () => {
    const original = encoder.encode("tracked inflate test data");
    const compressed = wasm.zlibDeflate(original);

    // Append garbage after compressed data
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
    // Delta should be smaller than full target
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
    // 4 + 3 = 7 = 0x0007
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
    // parsePktLines starts with one section, adds a new one on each flush
    // Input: hello, world, FLUSH, bye, FLUSH → 2 data sections + 1 trailing empty
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(decoder.decode(sections[0][0])).toBe("hello\n");
    expect(decoder.decode(sections[0][1])).toBe("world\n");
    expect(decoder.decode(sections[1][0])).toBe("bye\n");
  });
});

// ============================================================
// GitEngine — R2/KV operations
// ============================================================
describe("GitEngine", () => {
  let engine: GitEngine;

  beforeEach(async () => {
    engine = new GitEngine(env, "test/repo");
    // Clean up R2 and KV between tests
    const listed = await env.OBJECTS.list({ prefix: "test/repo/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
    const kvList = await env.REFS.list({ prefix: "test/repo/" });
    for (const key of kvList.keys) {
      await env.REFS.delete(key.name);
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

  it("should set, get, and delete refs", async () => {
    await engine.setRef("heads/main", "abc123" + "0".repeat(34));
    const ref = await engine.getRef("heads/main");
    expect(ref).toBe("abc123" + "0".repeat(34));

    await engine.deleteRef("heads/main");
    const deleted = await engine.getRef("heads/main");
    expect(deleted).toBeNull();
  });

  it("should list all refs", async () => {
    await engine.setRef("heads/main", "a".repeat(40));
    await engine.setRef("heads/dev", "b".repeat(40));
    await engine.setRef("tags/v1", "c".repeat(40));

    const refs = await engine.listRefs();
    expect(refs.size).toBe(3);
    expect(refs.get("heads/main")).toBe("a".repeat(40));
    expect(refs.get("heads/dev")).toBe("b".repeat(40));
    expect(refs.get("tags/v1")).toBe("c".repeat(40));
  });

  it("should set and get HEAD", async () => {
    await engine.setHead("ref: refs/heads/main");
    const head = await engine.getHead();
    expect(head).toBe("ref: refs/heads/main");
  });

  it("should store and read a commit object", async () => {
    // Create a blob
    const blobContent = encoder.encode("test file");
    const blobSha = await engine.storeObject(OBJ_BLOB, blobContent);

    // Create a tree with the blob
    const blobShaBytes = hexToBytes(blobSha);
    const treeContent = buildTreeEntry("100644", "test.txt", blobShaBytes);
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);

    // Create a commit
    const commitContent = encoder.encode(
      `tree ${treeSha}\nauthor Test <test@test.com> 1700000000 +0000\ncommitter Test <test@test.com> 1700000000 +0000\n\nInitial commit\n`
    );
    const commitSha = await engine.storeObject(OBJ_COMMIT, commitContent);

    // Read it back
    const obj = await engine.readObject(commitSha);
    expect(obj).not.toBeNull();
    expect(obj!.type).toBe(OBJ_COMMIT);
    const text = decoder.decode(obj!.content);
    expect(text).toContain(`tree ${treeSha}`);
    expect(text).toContain("Initial commit");
  });
});

// ============================================================
// HTTP Git Protocol (info-refs, upload-pack, receive-pack)
// ============================================================
describe("Git Protocol", () => {
  beforeEach(async () => {
    // Clean up between tests
    const listed = await env.OBJECTS.list({ prefix: "alice/myproject/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
    const kvList = await env.REFS.list({ prefix: "alice/myproject/" });
    for (const key of kvList.keys) {
      await env.REFS.delete(key.name);
    }
  });

  it("should return empty ref advertisement for new repo", async () => {
    const response = await SELF.fetch(
      "http://localhost/alice/myproject.git/info/refs?service=git-upload-pack"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-git-upload-pack-advertisement"
    );

    const body = new Uint8Array(await response.arrayBuffer());
    const sections = parsePktLines(body);
    // First section: service announcement
    expect(decoder.decode(sections[0][0])).toContain("# service=git-upload-pack");
    // Second section: capabilities with zero-id
    const capLine = decoder.decode(sections[1][0]);
    expect(capLine).toContain("0".repeat(40));
    expect(capLine).toContain("report-status");
  });

  it("should advertise refs after push", async () => {
    // Seed an object and ref
    const engine = new GitEngine(env, "alice/myproject");
    const blobSha = await engine.storeObject(OBJ_BLOB, encoder.encode("hello"));
    const treeBytes = buildTreeEntry("100644", "file.txt", hexToBytes(blobSha));
    const treeSha = await engine.storeObject(OBJ_TREE, treeBytes);
    const commitContent = encoder.encode(
      `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\ntest\n`
    );
    const commitSha = await engine.storeObject(OBJ_COMMIT, commitContent);
    await engine.setRef("heads/main", commitSha);
    await engine.setHead("ref: refs/heads/main");

    const response = await SELF.fetch(
      "http://localhost/alice/myproject.git/info/refs?service=git-upload-pack"
    );
    const body = new Uint8Array(await response.arrayBuffer());
    const text = decoder.decode(body);
    expect(text).toContain(commitSha);
    expect(text).toContain("HEAD");
    expect(text).toContain("refs/heads/main");
  });

  it("should reject unsupported services", async () => {
    const response = await SELF.fetch(
      "http://localhost/alice/myproject.git/info/refs?service=git-archive"
    );
    expect(response.status).toBe(403);
  });

  it("should return HEAD for repo", async () => {
    const engine = new GitEngine(env, "alice/myproject");
    await engine.setHead("ref: refs/heads/main");

    const response = await SELF.fetch(
      "http://localhost/alice/myproject.git/HEAD"
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.trim()).toBe("ref: refs/heads/main");
  });

  it("should return default HEAD for empty repo", async () => {
    const response = await SELF.fetch(
      "http://localhost/alice/myproject.git/HEAD"
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
  let engine: GitEngine;

  beforeEach(async () => {
    engine = new GitEngine(env, "e2e/testrepo");
    const listed = await env.OBJECTS.list({ prefix: "e2e/testrepo/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
    const kvList = await env.REFS.list({ prefix: "e2e/testrepo/" });
    for (const key of kvList.keys) {
      await env.REFS.delete(key.name);
    }
  });

  it("should store objects and read them back via GitEngine", async () => {
    // Simulate a minimal push: store blob → tree → commit, set ref

    // 1. Blob
    const blobContent = encoder.encode("Hello from gitmode!\n");
    const blobSha = await engine.storeObject(OBJ_BLOB, blobContent);

    // 2. Tree
    const treeContent = buildTreeEntry("100644", "README.md", hexToBytes(blobSha));
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);

    // 3. Commit
    const commitText = [
      `tree ${treeSha}`,
      "author Test User <test@example.com> 1700000000 +0000",
      "committer Test User <test@example.com> 1700000000 +0000",
      "",
      "Initial commit\n",
    ].join("\n");
    const commitSha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commitText));

    // 4. Set ref
    await engine.setRef("heads/main", commitSha);

    // Verify: walk from commit → tree → blob
    const commit = await engine.readObject(commitSha);
    expect(commit).not.toBeNull();
    expect(commit!.type).toBe(OBJ_COMMIT);

    const commitContent = decoder.decode(commit!.content);
    const treeMatch = commitContent.match(/^tree ([0-9a-f]{40})/m);
    expect(treeMatch).not.toBeNull();
    expect(treeMatch![1]).toBe(treeSha);

    const tree = await engine.readObject(treeSha);
    expect(tree).not.toBeNull();
    expect(tree!.type).toBe(OBJ_TREE);

    const blob = await engine.readObject(blobSha);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe(OBJ_BLOB);
    expect(decoder.decode(blob!.content)).toBe("Hello from gitmode!\n");
  });

  it("should handle multiple commits with parent references", async () => {
    // First commit
    const blob1Sha = await engine.storeObject(OBJ_BLOB, encoder.encode("v1"));
    const tree1Content = buildTreeEntry("100644", "file.txt", hexToBytes(blob1Sha));
    const tree1Sha = await engine.storeObject(OBJ_TREE, tree1Content);
    const commit1Text = `tree ${tree1Sha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nFirst commit\n`;
    const commit1Sha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commit1Text));

    // Second commit (with parent)
    const blob2Sha = await engine.storeObject(OBJ_BLOB, encoder.encode("v2"));
    const tree2Content = buildTreeEntry("100644", "file.txt", hexToBytes(blob2Sha));
    const tree2Sha = await engine.storeObject(OBJ_TREE, tree2Content);
    const commit2Text = `tree ${tree2Sha}\nparent ${commit1Sha}\nauthor A <a@a.com> 1700001000 +0000\ncommitter A <a@a.com> 1700001000 +0000\n\nSecond commit\n`;
    const commit2Sha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commit2Text));

    await engine.setRef("heads/main", commit2Sha);

    // Verify chain
    const commit2 = await engine.readObject(commit2Sha);
    const text2 = decoder.decode(commit2!.content);
    expect(text2).toContain(`parent ${commit1Sha}`);

    const commit1 = await engine.readObject(commit1Sha);
    const text1 = decoder.decode(commit1!.content);
    expect(text1).not.toContain("parent");
  });
});

// ============================================================
// Worktree materialization
// ============================================================
describe("Worktree", () => {
  let engine: GitEngine;

  beforeEach(async () => {
    engine = new GitEngine(env, "wt/repo");
    const listed = await env.OBJECTS.list({ prefix: "wt/repo/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
    const kvList = await env.REFS.list({ prefix: "wt/repo/" });
    for (const key of kvList.keys) {
      await env.REFS.delete(key.name);
    }
  });

  it("should materialize worktree files to R2", async () => {
    const { materializeWorktree } = await import("../src/checkout");

    // Create blob + tree + commit
    const blobContent = encoder.encode("file content here");
    const blobSha = await engine.storeObject(OBJ_BLOB, blobContent);

    const treeContent = buildTreeEntry("100644", "README.md", hexToBytes(blobSha));
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);

    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\ntest\n`;
    const commitSha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commitText));

    // Materialize
    await materializeWorktree(engine, env, "wt/repo", "main", commitSha);

    // Verify worktree file in R2
    const worktreeObj = await env.OBJECTS.get("wt/repo/worktrees/main/README.md");
    expect(worktreeObj).not.toBeNull();
    const worktreeContent = await worktreeObj!.text();
    expect(worktreeContent).toBe("file content here");
  });

  it("should materialize nested directories", async () => {
    const { materializeWorktree } = await import("../src/checkout");

    // Create blobs
    const blob1Sha = await engine.storeObject(OBJ_BLOB, encoder.encode("package.json content"));
    const blob2Sha = await engine.storeObject(OBJ_BLOB, encoder.encode("main.ts content"));

    // Subtree: src/main.ts
    const subTreeContent = buildTreeEntry("100644", "main.ts", hexToBytes(blob2Sha));
    const subTreeSha = await engine.storeObject(OBJ_TREE, subTreeContent);

    // Root tree: package.json + src/
    const rootTreeContent = concatBytes(
      buildTreeEntry("100644", "package.json", hexToBytes(blob1Sha)),
      buildTreeEntry("40000", "src", hexToBytes(subTreeSha))
    );
    const rootTreeSha = await engine.storeObject(OBJ_TREE, rootTreeContent);

    const commitText = `tree ${rootTreeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\ntest\n`;
    const commitSha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commitText));

    await materializeWorktree(engine, env, "wt/repo", "main", commitSha);

    // Check both files
    const pkg = await env.OBJECTS.get("wt/repo/worktrees/main/package.json");
    expect(pkg).not.toBeNull();
    expect(await pkg!.text()).toBe("package.json content");

    const main = await env.OBJECTS.get("wt/repo/worktrees/main/src/main.ts");
    expect(main).not.toBeNull();
    expect(await main!.text()).toBe("main.ts content");
  });
});

// ============================================================
// D1 Metadata
// ============================================================
describe("D1 Metadata", () => {
  beforeAll(async () => {
    // Initialize D1 schema — exec() requires individual statements
    await env.META.exec(
      "CREATE TABLE IF NOT EXISTS repos (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', visibility TEXT DEFAULT 'public', default_branch TEXT DEFAULT 'main', created_at TEXT NOT NULL, updated_at TEXT, UNIQUE(owner, name));"
    );
    await env.META.exec(
      "CREATE TABLE IF NOT EXISTS commits (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, sha1 TEXT NOT NULL, author TEXT NOT NULL, message TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(repo, sha1));"
    );
    await env.META.exec(
      "CREATE TABLE IF NOT EXISTS ssh_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, title TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, created_at TEXT NOT NULL);"
    );
    await env.META.exec(
      "CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, UNIQUE(repo, username));"
    );
  });

  it("should create repo in D1", async () => {
    const engine = new GitEngine(env, "meta/testrepo");
    await engine.ensureRepo();

    const result = await env.META.prepare(
      "SELECT owner, name FROM repos WHERE owner = ? AND name = ?"
    )
      .bind("meta", "testrepo")
      .first<{ owner: string; name: string }>();

    expect(result).not.toBeNull();
    expect(result!.owner).toBe("meta");
    expect(result!.name).toBe("testrepo");
  });

  it("should index commits in D1", async () => {
    const engine = new GitEngine(env, "meta/testrepo");
    await engine.indexCommit(
      "a".repeat(40),
      "Test Author",
      "Add feature",
      1700000000
    );

    const result = await env.META.prepare(
      "SELECT sha1, author, message FROM commits WHERE repo = ?"
    )
      .bind("meta/testrepo")
      .first<{ sha1: string; author: string; message: string }>();

    expect(result).not.toBeNull();
    expect(result!.sha1).toBe("a".repeat(40));
    expect(result!.author).toBe("Test Author");
    expect(result!.message).toBe("Add feature");
  });

  it("should look up SSH key owner", async () => {
    await env.META.prepare(
      "INSERT INTO ssh_keys (owner, title, fingerprint, public_key, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("alice", "laptop", "SHA256:testfp123", "ssh-ed25519 AAAA...", new Date().toISOString())
      .run();

    const engine = new GitEngine(env, "alice/repo");
    const owner = await engine.getSSHKeyOwner("SHA256:testfp123");
    expect(owner).toBe("alice");

    const notFound = await engine.getSSHKeyOwner("SHA256:nonexistent");
    expect(notFound).toBeNull();
  });
});

// ============================================================
// Packfile roundtrip (build + parse)
// ============================================================
describe("Packfile", () => {
  let engine: GitEngine;

  beforeEach(async () => {
    engine = new GitEngine(env, "pack/repo");
    const listed = await env.OBJECTS.list({ prefix: "pack/repo/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
  });

  it("should build a packfile and unpack it back", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");
    const { unpackPackfile } = await import("../src/packfile-reader");

    // Store objects in R2
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

    // Build packfile
    const pack = await buildPackfile(engine, [commitSha, treeSha, blob1Sha, blob2Sha]);
    expect(pack.length).toBeGreaterThan(32);

    // Verify packfile header
    expect(decoder.decode(pack.slice(0, 4))).toBe("PACK");
    const version = (pack[4] << 24) | (pack[5] << 16) | (pack[6] << 8) | pack[7];
    expect(version).toBe(2);
    const numObjects = (pack[8] << 24) | (pack[9] << 16) | (pack[10] << 8) | pack[11];
    expect(numObjects).toBe(4);

    // Now unpack into a different repo to verify roundtrip
    const engine2 = new GitEngine(env, "pack/repo2");
    await unpackPackfile(engine2, pack);

    // Verify all objects survived the roundtrip
    const blob1 = await engine2.readObject(blob1Sha);
    expect(blob1).not.toBeNull();
    expect(blob1!.type).toBe(OBJ_BLOB);
    expect(decoder.decode(blob1!.content)).toBe("file one content");

    const blob2 = await engine2.readObject(blob2Sha);
    expect(blob2).not.toBeNull();
    expect(decoder.decode(blob2!.content)).toBe("file two content");

    const tree = await engine2.readObject(treeSha);
    expect(tree).not.toBeNull();
    expect(tree!.type).toBe(OBJ_TREE);

    const commit = await engine2.readObject(commitSha);
    expect(commit).not.toBeNull();
    expect(commit!.type).toBe(OBJ_COMMIT);
  });
});

// ============================================================
// HTTP receive-pack (push via HTTP POST)
// ============================================================
describe("HTTP receive-pack", () => {
  beforeEach(async () => {
    const listed = await env.OBJECTS.list({ prefix: "push/repo/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
    const kvList = await env.REFS.list({ prefix: "push/repo/" });
    for (const key of kvList.keys) {
      await env.REFS.delete(key.name);
    }
  });

  it("should accept a push with packfile and update refs", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");

    // First, store objects in a temp engine to build a valid packfile
    const tmpEngine = new GitEngine(env, "push/tmp");
    const blobContent = encoder.encode("pushed file\n");
    const blobSha = await tmpEngine.storeObject(OBJ_BLOB, blobContent);
    const treeContent = buildTreeEntry("100644", "hello.txt", hexToBytes(blobSha));
    const treeSha = await tmpEngine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor Push User <push@test.com> 1700000000 +0000\ncommitter Push User <push@test.com> 1700000000 +0000\n\npush test\n`;
    const commitSha = await tmpEngine.storeObject(OBJ_COMMIT, encoder.encode(commitText));

    const packData = await buildPackfile(tmpEngine, [commitSha, treeSha, blobSha]);

    // Build receive-pack body:
    //   pkt-line: "<old-sha> <new-sha> <refname>\0<capabilities>\n"
    //   flush
    //   packfile data
    const ZERO = "0".repeat(40);
    const refLine = `${ZERO} ${commitSha} refs/heads/main\0report-status side-band-64k\n`;
    const body = concatBytes(
      encodePktLine(refLine),
      FLUSH_PKT,
      packData
    );

    const response = await SELF.fetch(
      "http://localhost/push/repo.git/git-receive-pack",
      {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-git-receive-pack-result"
    );

    // Parse response — should contain "unpack ok" and "ok refs/heads/main"
    const responseBody = new Uint8Array(await response.arrayBuffer());
    const responseText = decoder.decode(responseBody);
    expect(responseText).toContain("unpack ok");
    expect(responseText).toContain("ok refs/heads/main");

    // Verify ref was updated in KV
    const pushEngine = new GitEngine(env, "push/repo");
    const ref = await pushEngine.getRef("heads/main");
    expect(ref).toBe(commitSha);

    // Verify objects are stored in R2
    const blob = await pushEngine.readObject(blobSha);
    expect(blob).not.toBeNull();
    expect(decoder.decode(blob!.content)).toBe("pushed file\n");
  });

  it("should reject non-fast-forward push", async () => {
    // Set up existing ref
    const pushEngine = new GitEngine(env, "push/repo");
    const blobSha = await pushEngine.storeObject(OBJ_BLOB, encoder.encode("existing"));
    const treeContent = buildTreeEntry("100644", "f.txt", hexToBytes(blobSha));
    const treeSha = await pushEngine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nexisting\n`;
    const existingSha = await pushEngine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    await pushEngine.setRef("heads/main", existingSha);

    // Try to push with wrong old SHA
    const wrongOld = "f".repeat(40);
    const newSha = "a".repeat(40);
    const refLine = `${wrongOld} ${newSha} refs/heads/main\0report-status\n`;
    const body = concatBytes(
      encodePktLine(refLine),
      FLUSH_PKT
      // no packfile needed — ref update will fail first
    );

    const response = await SELF.fetch(
      "http://localhost/push/repo.git/git-receive-pack",
      { method: "POST", body }
    );

    const responseText = decoder.decode(new Uint8Array(await response.arrayBuffer()));
    expect(responseText).toContain("non-fast-forward");

    // Ref should not have changed
    const ref = await pushEngine.getRef("heads/main");
    expect(ref).toBe(existingSha);
  });
});

// ============================================================
// HTTP upload-pack (clone/fetch via HTTP POST)
// ============================================================
describe("HTTP upload-pack", () => {
  let engine: GitEngine;
  let commitSha: string;
  let blobSha: string;

  beforeEach(async () => {
    engine = new GitEngine(env, "clone/repo");
    const listed = await env.OBJECTS.list({ prefix: "clone/repo/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
    const kvList = await env.REFS.list({ prefix: "clone/repo/" });
    for (const key of kvList.keys) {
      await env.REFS.delete(key.name);
    }

    // Seed a repo with objects
    const content = encoder.encode("cloned content\n");
    blobSha = await engine.storeObject(OBJ_BLOB, content);
    const treeContent = buildTreeEntry("100644", "file.txt", hexToBytes(blobSha));
    const treeSha = await engine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor A <a@a.com> 1700000000 +0000\ncommitter A <a@a.com> 1700000000 +0000\n\nclone test\n`;
    commitSha = await engine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    await engine.setRef("heads/main", commitSha);
    await engine.setHead("ref: refs/heads/main");
  });

  it("should serve objects in a packfile for clone", async () => {
    // Build upload-pack request: want <sha> + done
    const wantLine = `want ${commitSha} side-band-64k\n`;
    const body = concatBytes(
      encodePktLine(wantLine),
      FLUSH_PKT,
      encodePktLine("done\n"),
      FLUSH_PKT
    );

    const response = await SELF.fetch(
      "http://localhost/clone/repo.git/git-upload-pack",
      { method: "POST", body }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-git-upload-pack-result"
    );

    const responseBody = new Uint8Array(await response.arrayBuffer());
    const responseText = decoder.decode(responseBody);

    // Should contain NAK (no common objects with client)
    expect(responseText).toContain("NAK");

    // Extract sideband data — find PACK signature inside the response
    // The packfile is wrapped in sideband pkt-lines (channel 1)
    let packFound = false;
    for (let i = 0; i < responseBody.length - 4; i++) {
      if (
        responseBody[i] === 0x50 && // P
        responseBody[i + 1] === 0x41 && // A
        responseBody[i + 2] === 0x43 && // C
        responseBody[i + 3] === 0x4b // K
      ) {
        packFound = true;
        break;
      }
    }
    expect(packFound).toBe(true);
  });

  it("should return error for empty wants", async () => {
    const response = await SELF.fetch(
      "http://localhost/clone/repo.git/git-upload-pack",
      {
        method: "POST",
        body: concatBytes(FLUSH_PKT, encodePktLine("done\n"), FLUSH_PKT),
      }
    );
    expect(response.status).toBe(400);
  });
});

// ============================================================
// Full push → info-refs → clone cycle (end-to-end HTTP)
// ============================================================
describe("Full HTTP push-clone cycle", () => {
  const repoName = "cycle/fulltest";

  beforeEach(async () => {
    const listed = await env.OBJECTS.list({ prefix: `${repoName}/` });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
    const kvList = await env.REFS.list({ prefix: `${repoName}/` });
    for (const key of kvList.keys) {
      await env.REFS.delete(key.name);
    }
  });

  it("should push objects, advertise refs, then clone them back", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");
    const { unpackPackfile } = await import("../src/packfile-reader");

    // 1. Store objects locally and build a packfile
    const tmpEngine = new GitEngine(env, "cycle/tmp");
    const fileContent = encoder.encode("full cycle test content\n");
    const blobSha = await tmpEngine.storeObject(OBJ_BLOB, fileContent);
    const treeContent = buildTreeEntry("100644", "readme.txt", hexToBytes(blobSha));
    const treeSha = await tmpEngine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor Cycle <c@c.com> 1700000000 +0000\ncommitter Cycle <c@c.com> 1700000000 +0000\n\nfull cycle\n`;
    const commitSha = await tmpEngine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    const packData = await buildPackfile(tmpEngine, [commitSha, treeSha, blobSha]);

    // 2. PUSH via HTTP receive-pack
    const ZERO = "0".repeat(40);
    const pushBody = concatBytes(
      encodePktLine(`${ZERO} ${commitSha} refs/heads/main\0report-status side-band-64k\n`),
      FLUSH_PKT,
      packData
    );

    const pushResp = await SELF.fetch(
      `http://localhost/${repoName}.git/git-receive-pack`,
      { method: "POST", body: pushBody }
    );
    expect(pushResp.status).toBe(200);
    const pushText = decoder.decode(new Uint8Array(await pushResp.arrayBuffer()));
    expect(pushText).toContain("unpack ok");
    expect(pushText).toContain("ok refs/heads/main");

    // 3. INFO-REFS — verify the commit is advertised
    const infoResp = await SELF.fetch(
      `http://localhost/${repoName}.git/info/refs?service=git-upload-pack`
    );
    expect(infoResp.status).toBe(200);
    const infoText = decoder.decode(new Uint8Array(await infoResp.arrayBuffer()));
    expect(infoText).toContain(commitSha);

    // 4. CLONE via HTTP upload-pack
    const cloneBody = concatBytes(
      encodePktLine(`want ${commitSha} side-band-64k\n`),
      FLUSH_PKT,
      encodePktLine("done\n"),
      FLUSH_PKT
    );

    const cloneResp = await SELF.fetch(
      `http://localhost/${repoName}.git/git-upload-pack`,
      { method: "POST", body: cloneBody }
    );
    expect(cloneResp.status).toBe(200);

    // Extract the packfile from the sideband response
    const cloneData = new Uint8Array(await cloneResp.arrayBuffer());

    // Find PACK in the sideband-wrapped response and extract all pack data
    const extractedPack = extractPackFromSideband(cloneData);
    expect(extractedPack).not.toBeNull();
    expect(extractedPack!.length).toBeGreaterThan(20);

    // 5. Unpack the received packfile into a fresh engine
    const cloneEngine = new GitEngine(env, "cycle/cloned");
    await unpackPackfile(cloneEngine, extractedPack!);

    // 6. Verify all objects survived the full cycle
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
    // -1 = ODB host imports not wired, but the init itself should not crash
    // 0 = success, negative = expected failure without ODB
    expect(typeof result).toBe("number");
  });
});

// ============================================================
// Worktree after push (via receive-pack)
// ============================================================
describe("Worktree via push", () => {
  beforeEach(async () => {
    const listed = await env.OBJECTS.list({ prefix: "wtp/repo/" });
    for (const obj of listed.objects) {
      await env.OBJECTS.delete(obj.key);
    }
    const kvList = await env.REFS.list({ prefix: "wtp/repo/" });
    for (const key of kvList.keys) {
      await env.REFS.delete(key.name);
    }
  });

  it("should materialize worktree files after receive-pack", async () => {
    const { buildPackfile } = await import("../src/packfile-builder");

    // Build objects
    const tmpEngine = new GitEngine(env, "wtp/tmp");
    const fileContent = encoder.encode("worktree pushed content\n");
    const blobSha = await tmpEngine.storeObject(OBJ_BLOB, fileContent);
    const treeContent = buildTreeEntry("100644", "index.html", hexToBytes(blobSha));
    const treeSha = await tmpEngine.storeObject(OBJ_TREE, treeContent);
    const commitText = `tree ${treeSha}\nauthor W <w@w.com> 1700000000 +0000\ncommitter W <w@w.com> 1700000000 +0000\n\nwt push\n`;
    const commitSha = await tmpEngine.storeObject(OBJ_COMMIT, encoder.encode(commitText));
    const packData = await buildPackfile(tmpEngine, [commitSha, treeSha, blobSha]);

    // Push
    const ZERO = "0".repeat(40);
    const pushBody = concatBytes(
      encodePktLine(`${ZERO} ${commitSha} refs/heads/main\0report-status side-band-64k\n`),
      FLUSH_PKT,
      packData
    );

    const response = await SELF.fetch(
      "http://localhost/wtp/repo.git/git-receive-pack",
      { method: "POST", body: pushBody }
    );
    expect(response.status).toBe(200);

    // Verify worktree was materialized
    const worktreeFile = await env.OBJECTS.get("wtp/repo/worktrees/main/index.html");
    expect(worktreeFile).not.toBeNull();
    expect(await worktreeFile!.text()).toBe("worktree pushed content\n");
  });
});

// ============================================================
// Helpers
// ============================================================

/** Extract packfile data from a sideband-64k wrapped upload-pack response */
function extractPackFromSideband(data: Uint8Array): Uint8Array | null {
  const packChunks: Uint8Array[] = [];
  let offset = 0;

  while (offset < data.length) {
    const pkt = decodePktLine(data, offset);
    if (!pkt) break;
    offset = pkt.nextOffset;

    if (pkt.type === "flush") continue;
    if (pkt.type !== "data" || !pkt.payload || pkt.payload.length === 0) continue;

    // Check sideband channel
    const channel = pkt.payload[0];
    if (channel === 0x01) {
      // Data channel — pack data
      packChunks.push(pkt.payload.slice(1));
    }
    // channel 0x02 = progress, 0x03 = error — skip
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
  entry.set(modeBytes, offset);
  offset += modeBytes.length;
  entry[offset++] = 0x20; // space
  entry.set(nameBytes, offset);
  offset += nameBytes.length;
  entry[offset++] = 0x00; // null terminator
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
