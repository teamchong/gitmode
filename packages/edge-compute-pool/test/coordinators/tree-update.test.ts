// Tests for applyTreeChange. Uses an in-memory loader/hasher rather than
// dragging in WASM + R2 — the coordinator is pure data flow.

import { describe, expect, it } from "vitest";
import { applyTreeChange, type TreeLoader, type ObjectHasher } from "../../src/coordinators/tree-update";
import { encodeTreeBytes, parseTreeBytes, type TreeEntry } from "../../src/protocol/tree-bytes";
import { OBJ_BLOB, OBJ_TREE } from "../../src/pack-format";

const TYPE_NAMES: Record<number, string> = {
  [OBJ_BLOB]: "blob",
  [OBJ_TREE]: "tree",
};

function makeHasher(): ObjectHasher {
  return async (type: number, content: Uint8Array) => {
    const typeName = TYPE_NAMES[type] ?? "unknown";
    const header = new TextEncoder().encode(`${typeName} ${content.length}\0`);
    const buf = new Uint8Array(header.length + content.length);
    buf.set(header, 0);
    buf.set(content, header.length);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
    let s = "";
    for (let i = 0; i < hash.length; i++) s += hash[i]!.toString(16).padStart(2, "0");
    return s;
  };
}

function makeStore(): { loader: TreeLoader; put(sha: string, content: Uint8Array): void; size(): number } {
  const m = new Map<string, Uint8Array>();
  return {
    loader: async (sha) => m.get(sha) ?? null,
    put(sha, content) {
      m.set(sha, content);
    },
    size() {
      return m.size;
    },
  };
}

describe("applyTreeChange", () => {
  it("creates a single-file tree from scratch (empty repo)", async () => {
    const hasher = makeHasher();
    const store = makeStore();

    const result = await applyTreeChange({
      baseTreeSha: null,
      pathParts: ["README.md"],
      newBlob: { mode: "100644", content: new TextEncoder().encode("hello\n") },
      loader: store.loader,
      hasher,
    });

    // Should produce: 1 blob + 1 root tree
    expect(result.newObjects.length).toBe(2);
    const blob = result.newObjects.find((o) => o.type === OBJ_BLOB)!;
    const tree = result.newObjects.find((o) => o.type === OBJ_TREE)!;
    expect(new TextDecoder().decode(blob.content)).toBe("hello\n");
    expect(tree.sha).toBe(result.newRootSha);

    const entries = parseTreeBytes(tree.content);
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("README.md");
    expect(entries[0]!.sha).toBe(blob.sha);
  });

  it("adds a file to an existing tree without disturbing other entries", async () => {
    const hasher = makeHasher();
    const store = makeStore();

    // Start with a tree containing one file
    const existingBlobSha = await hasher(OBJ_BLOB, new TextEncoder().encode("existing\n"));
    const existingEntries: TreeEntry[] = [
      { mode: "100644", name: "existing.txt", sha: existingBlobSha },
    ];
    const existingTreeBytes = encodeTreeBytes(existingEntries);
    const existingTreeSha = await hasher(OBJ_TREE, existingTreeBytes);
    store.put(existingTreeSha, existingTreeBytes);

    const result = await applyTreeChange({
      baseTreeSha: existingTreeSha,
      pathParts: ["new.txt"],
      newBlob: { mode: "100644", content: new TextEncoder().encode("new\n") },
      loader: store.loader,
      hasher,
    });

    const tree = result.newObjects.find((o) => o.type === OBJ_TREE && o.sha === result.newRootSha)!;
    const entries = parseTreeBytes(tree.content);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.name).sort()).toEqual(["existing.txt", "new.txt"]);
    // Existing entry should keep its sha
    expect(entries.find((e) => e.name === "existing.txt")?.sha).toBe(existingBlobSha);
  });

  it("replaces an existing file's content (same path, new sha)", async () => {
    const hasher = makeHasher();
    const store = makeStore();

    const oldBlobSha = await hasher(OBJ_BLOB, new TextEncoder().encode("old\n"));
    const tree = encodeTreeBytes([{ mode: "100644", name: "file.txt", sha: oldBlobSha }]);
    const treeSha = await hasher(OBJ_TREE, tree);
    store.put(treeSha, tree);

    const result = await applyTreeChange({
      baseTreeSha: treeSha,
      pathParts: ["file.txt"],
      newBlob: { mode: "100644", content: new TextEncoder().encode("new\n") },
      loader: store.loader,
      hasher,
    });

    const newTree = result.newObjects.find((o) => o.type === OBJ_TREE && o.sha === result.newRootSha)!;
    const entries = parseTreeBytes(newTree.content);
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("file.txt");
    expect(entries[0]!.sha).not.toBe(oldBlobSha);
  });

  it("creates intermediate directories for a deep path", async () => {
    const hasher = makeHasher();
    const store = makeStore();

    const result = await applyTreeChange({
      baseTreeSha: null,
      pathParts: ["src", "lib", "deep.ts"],
      newBlob: { mode: "100644", content: new TextEncoder().encode("export {}\n") },
      loader: store.loader,
      hasher,
    });

    // 1 blob + 3 trees (deep.ts's parent, src/lib, src, root) — actually 3 trees total
    // Wait: deep.ts is a leaf, the trees are "lib", "src", "root" → 3 trees + 1 blob = 4
    const trees = result.newObjects.filter((o) => o.type === OBJ_TREE);
    const blobs = result.newObjects.filter((o) => o.type === OBJ_BLOB);
    expect(blobs.length).toBe(1);
    expect(trees.length).toBe(3);

    // Walk down to verify
    const root = trees.find((t) => t.sha === result.newRootSha)!;
    const rootEntries = parseTreeBytes(root.content);
    expect(rootEntries.length).toBe(1);
    expect(rootEntries[0]!.name).toBe("src");
    expect(rootEntries[0]!.mode).toBe("040000");
  });

  it("modifies a file deep in an existing tree without touching siblings", async () => {
    const hasher = makeHasher();
    const store = makeStore();

    // Build: src/{a.ts, b.ts}, README.md
    const aBlob = await hasher(OBJ_BLOB, new TextEncoder().encode("a\n"));
    const bBlob = await hasher(OBJ_BLOB, new TextEncoder().encode("b\n"));
    const readmeBlob = await hasher(OBJ_BLOB, new TextEncoder().encode("hi\n"));

    const srcTree = encodeTreeBytes([
      { mode: "100644", name: "a.ts", sha: aBlob },
      { mode: "100644", name: "b.ts", sha: bBlob },
    ]);
    const srcTreeSha = await hasher(OBJ_TREE, srcTree);
    store.put(srcTreeSha, srcTree);

    const rootTree = encodeTreeBytes([
      { mode: "040000", name: "src", sha: srcTreeSha },
      { mode: "100644", name: "README.md", sha: readmeBlob },
    ]);
    const rootTreeSha = await hasher(OBJ_TREE, rootTree);
    store.put(rootTreeSha, rootTree);

    // Modify src/a.ts
    const result = await applyTreeChange({
      baseTreeSha: rootTreeSha,
      pathParts: ["src", "a.ts"],
      newBlob: { mode: "100644", content: new TextEncoder().encode("a-new\n") },
      loader: store.loader,
      hasher,
    });

    // Should produce: 1 new blob (a.ts), 1 new src tree, 1 new root tree
    expect(result.newObjects.length).toBe(3);

    // Walk: root → src → a.ts (new) and b.ts (unchanged)
    const newRoot = result.newObjects.find((o) => o.sha === result.newRootSha)!;
    const rootEntries = parseTreeBytes(newRoot.content);
    expect(rootEntries.find((e) => e.name === "README.md")?.sha).toBe(readmeBlob); // unchanged
    const newSrcSha = rootEntries.find((e) => e.name === "src")!.sha;
    const newSrc = result.newObjects.find((o) => o.sha === newSrcSha)!;
    const srcEntries = parseTreeBytes(newSrc.content);
    expect(srcEntries.find((e) => e.name === "b.ts")?.sha).toBe(bBlob); // unchanged
    expect(srcEntries.find((e) => e.name === "a.ts")?.sha).not.toBe(aBlob); // changed
  });

  it("deletes a file by passing newBlob: null", async () => {
    const hasher = makeHasher();
    const store = makeStore();

    const aBlob = await hasher(OBJ_BLOB, new TextEncoder().encode("a\n"));
    const bBlob = await hasher(OBJ_BLOB, new TextEncoder().encode("b\n"));
    const tree = encodeTreeBytes([
      { mode: "100644", name: "a.txt", sha: aBlob },
      { mode: "100644", name: "b.txt", sha: bBlob },
    ]);
    const treeSha = await hasher(OBJ_TREE, tree);
    store.put(treeSha, tree);

    const result = await applyTreeChange({
      baseTreeSha: treeSha,
      pathParts: ["a.txt"],
      newBlob: null,
      loader: store.loader,
      hasher,
    });

    const newRoot = result.newObjects.find((o) => o.sha === result.newRootSha)!;
    const entries = parseTreeBytes(newRoot.content);
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("b.txt");
  });

  it("rejects path traversal through a file", async () => {
    const hasher = makeHasher();
    const store = makeStore();

    const blob = await hasher(OBJ_BLOB, new TextEncoder().encode("x\n"));
    const tree = encodeTreeBytes([{ mode: "100644", name: "file.txt", sha: blob }]);
    const treeSha = await hasher(OBJ_TREE, tree);
    store.put(treeSha, tree);

    await expect(
      applyTreeChange({
        baseTreeSha: treeSha,
        pathParts: ["file.txt", "child"],
        newBlob: { mode: "100644", content: new TextEncoder().encode("nope") },
        loader: store.loader,
        hasher,
      }),
    ).rejects.toThrow(/path traverses through a file/);
  });

  it("rejects empty pathParts", async () => {
    const hasher = makeHasher();
    const store = makeStore();
    await expect(
      applyTreeChange({
        baseTreeSha: null,
        pathParts: [],
        newBlob: null,
        loader: store.loader,
        hasher,
      }),
    ).rejects.toThrow(/pathParts must be non-empty/);
  });
});
