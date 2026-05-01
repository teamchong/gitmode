// End-to-end write test for the Artifacts integration.
//
// Stands up an in-memory Artifacts-shaped server that:
//   - serves a ref advertisement (empty repo — initial commit case)
//   - accepts POST /git-receive-pack, validates the wire format,
//     unpacks the received packfile, and verifies the new objects
//   - responds with "unpack ok" + "ok refs/heads/main"
//
// Then commitFileChange pushes a single new file. The test verifies:
//   - The pack the server receives is well-formed and contains the new
//     blob, all intermediate trees, and the new commit
//   - The new root tree contains the expected file at the right path
//   - The reported newCommitSha matches the commit we actually pushed

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WasmEngine, toHex } from "@gitmode/wasm-git";
import { commitFileChange } from "../src/coordinators/commit-file-change";
import { unpackPackfile } from "../src/protocol/packfile-reader";
import {
  encodePktLine,
  decodePktLine,
  FLUSH_PKT,
  concat,
} from "../src/protocol/pkt-line";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT } from "../src/pack-format";
import { parseTreeBytes } from "../src/protocol/tree-bytes";
import { parseCommitBody } from "../src/commit-parse";
import { PackWorkerDO } from "../src/index";

const decoder = new TextDecoder();

interface ServerState {
  refs: Map<string, string>;
  /** Captures everything the server received, indexed by sha. */
  receivedObjects: Map<string, { type: number; content: Uint8Array }>;
  /** Most recent push body we received (for test assertions). */
  lastPushBody: Uint8Array | null;
  /** Most recent ref-update lines we extracted from the push body. */
  lastRefUpdates: Array<{ oldSha: string; newSha: string; refName: string }>;
}

function makeArtifactsServer(state: ServerState, wasm: WasmEngine): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const lines: Uint8Array[] = [
        encodePktLine("# service=git-upload-pack\n"),
        FLUSH_PKT,
      ];
      if (state.refs.size === 0) {
        // Empty-repo advertisement: a single all-zeros line with caps.
        lines.push(encodePktLine(`${"0".repeat(40)} capabilities^{}\0multi_ack side-band-64k\n`));
      } else {
        let first = true;
        for (const [refName, sha] of state.refs) {
          const text = first
            ? `${sha} ${refName}\0multi_ack side-band-64k\n`
            : `${sha} ${refName}\n`;
          lines.push(encodePktLine(text));
          first = false;
        }
      }
      lines.push(FLUSH_PKT);
      return new Response(concat(lines), { status: 200 });
    }

    if (req.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
      state.lastPushBody = new Uint8Array(await req.arrayBuffer());
      const result = await processPushBody(state, wasm);
      return new Response(result, { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };
}

async function processPushBody(state: ServerState, wasm: WasmEngine): Promise<Uint8Array> {
  const body = state.lastPushBody!;

  // Walk pkt-lines until the first flush — those are the ref updates.
  state.lastRefUpdates = [];
  let offset = 0;
  while (offset < body.length) {
    const r = decodePktLine(body, offset);
    if (!r) break;
    if (r.type === "flush") {
      offset = r.nextOffset;
      break;
    }
    if (r.type === "data" && r.payload) {
      let text = decoder.decode(r.payload).replace(/\n$/, "");
      // First line carries capabilities after \0
      const nulIdx = text.indexOf("\0");
      if (nulIdx !== -1) text = text.slice(0, nulIdx);
      const parts = text.split(" ");
      if (parts.length >= 3) {
        state.lastRefUpdates.push({
          oldSha: parts[0]!,
          newSha: parts[1]!,
          refName: parts.slice(2).join(" "),
        });
      }
    }
    offset = r.nextOffset;
  }

  // Everything from `offset` onwards is the packfile.
  const packBytes = body.subarray(offset);

  // Unpack via our own reader to validate the pack and capture objects.
  const responseLines: Uint8Array[] = [];
  try {
    if (packBytes.length > 0) {
      const result = await unpackPackfile(wasm, packBytes);
      for (const [sha, obj] of result.objects) {
        state.receivedObjects.set(sha, obj);
      }
    }
    responseLines.push(encodePktLine("unpack ok\n"));
    for (const u of state.lastRefUpdates) {
      // Apply the ref update to our state.
      state.refs.set(u.refName, u.newSha);
      responseLines.push(encodePktLine(`ok ${u.refName}\n`));
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    responseLines.push(encodePktLine(`unpack ${err}\n`));
    for (const u of state.lastRefUpdates) {
      responseLines.push(encodePktLine(`ng ${u.refName} unpack failed\n`));
    }
  }
  responseLines.push(FLUSH_PKT);
  return concat(responseLines);
}

describe("commitFileChange (end-to-end push)", () => {
  it("creates an initial commit on an empty repo and pushes it cleanly", async () => {
    const state: ServerState = {
      refs: new Map(),
      receivedObjects: new Map(),
      lastPushBody: null,
      lastRefUpdates: [],
    };
    const wasm = await WasmEngine.create();
    const fetcher = makeArtifactsServer(state, wasm);

    const result = await commitFileChange({
      artifactsUrl: "https://x.artifacts.cloudflare.net/git/init.git",
      branch: "main",
      pathParts: ["README.md"],
      newContent: new TextEncoder().encode("# Hello\n\nFirst commit from gitmode.\n"),
      authorName: "Test",
      authorEmail: "test@example.com",
      authorTimestamp: 1700000000,
      message: "initial commit",
      bucket: env.OBJECTS,
      repoPath: "init-repo",
      wasm,
      fetcher,
    });

    // Push succeeded
    expect(result.pushResult.unpackOk).toBe(true);
    expect(result.pushResult.refResults).toEqual([{ ref: "refs/heads/main", ok: true }]);
    expect(result.oldCommitSha).toBe("0".repeat(40));

    // Server received exactly: 1 blob + 1 tree + 1 commit
    expect(state.receivedObjects.size).toBe(3);
    const types = [...state.receivedObjects.values()].map((o) => o.type).sort();
    expect(types).toEqual([OBJ_BLOB, OBJ_TREE, OBJ_COMMIT]);

    // The commit the server got matches the sha we reported
    const serverCommit = state.receivedObjects.get(result.newCommitSha);
    expect(serverCommit).toBeDefined();
    expect(serverCommit!.type).toBe(OBJ_COMMIT);

    // The commit's tree contains README.md pointing at our blob
    const commitInfo = parseCommitBody(result.newCommitSha, serverCommit!.content);
    expect(commitInfo.summary).toBe("initial commit");
    expect(commitInfo.parents).toEqual([]);

    const tree = state.receivedObjects.get(commitInfo.tree)!;
    expect(tree.type).toBe(OBJ_TREE);
    const entries = parseTreeBytes(tree.content);
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("README.md");
    expect(entries[0]!.mode).toBe("100644");

    const blob = state.receivedObjects.get(entries[0]!.sha)!;
    expect(blob.type).toBe(OBJ_BLOB);
    expect(new TextDecoder().decode(blob.content)).toBe("# Hello\n\nFirst commit from gitmode.\n");

    // Ref state on the server now points to our new commit
    expect(state.refs.get("refs/heads/main")).toBe(result.newCommitSha);
  });

  it("commits a deep-path file, generating intermediate trees correctly", async () => {
    const state: ServerState = {
      refs: new Map(),
      receivedObjects: new Map(),
      lastPushBody: null,
      lastRefUpdates: [],
    };
    const wasm = await WasmEngine.create();
    const fetcher = makeArtifactsServer(state, wasm);

    const result = await commitFileChange({
      artifactsUrl: "https://x.artifacts.cloudflare.net/git/deep.git",
      branch: "main",
      pathParts: ["a", "b", "c", "deep.txt"],
      newContent: new TextEncoder().encode("nested content\n"),
      authorName: "T",
      authorEmail: "t@e",
      authorTimestamp: 1,
      message: "deep file",
      bucket: env.OBJECTS,
      repoPath: "deep-repo",
      wasm,
      fetcher,
    });

    expect(result.pushResult.unpackOk).toBe(true);

    // 1 blob + 4 trees (a/b/c, a/b, a, root) + 1 commit = 6
    expect(state.receivedObjects.size).toBe(6);

    const trees = [...state.receivedObjects.entries()].filter(([, o]) => o.type === OBJ_TREE);
    expect(trees.length).toBe(4);

    // Walk down to verify the structure
    const commit = state.receivedObjects.get(result.newCommitSha)!;
    const commitInfo = parseCommitBody(result.newCommitSha, commit.content);
    let currentTreeSha = commitInfo.tree;
    for (const segment of ["a", "b", "c"]) {
      const tree = state.receivedObjects.get(currentTreeSha)!;
      const entries = parseTreeBytes(tree.content);
      const entry = entries.find((e) => e.name === segment)!;
      expect(entry).toBeDefined();
      expect(entry.mode).toBe("040000");
      currentTreeSha = entry.sha;
    }
    // Final tree should contain deep.txt
    const leafTree = state.receivedObjects.get(currentTreeSha)!;
    const leafEntries = parseTreeBytes(leafTree.content);
    expect(leafEntries.find((e) => e.name === "deep.txt")?.mode).toBe("100644");
  });

  it("emits the right wire format (refUpdate line + pack body)", async () => {
    const state: ServerState = {
      refs: new Map(),
      receivedObjects: new Map(),
      lastPushBody: null,
      lastRefUpdates: [],
    };
    const wasm = await WasmEngine.create();
    const fetcher = makeArtifactsServer(state, wasm);

    await commitFileChange({
      artifactsUrl: "https://x.artifacts.cloudflare.net/git/wire.git",
      branch: "main",
      pathParts: ["x"],
      newContent: new TextEncoder().encode("y"),
      authorName: "T",
      authorEmail: "t@e",
      authorTimestamp: 1,
      message: "m",
      bucket: env.OBJECTS,
      repoPath: "wire-repo",
      wasm,
      fetcher,
    });

    expect(state.lastRefUpdates.length).toBe(1);
    expect(state.lastRefUpdates[0]).toMatchObject({
      oldSha: "0".repeat(40),
      refName: "refs/heads/main",
    });
    expect(state.lastRefUpdates[0]!.newSha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.lastRefUpdates[0]!.newSha).not.toBe("0".repeat(40));
  });

  it("propagates server-side ng errors", async () => {
    // Custom server that always rejects.
    const wasm = await WasmEngine.create();
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as string, init);
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
        return new Response(
          concat([
            encodePktLine("# service=git-upload-pack\n"),
            FLUSH_PKT,
            encodePktLine(`${"0".repeat(40)} capabilities^{}\0\n`),
            FLUSH_PKT,
          ]),
        );
      }
      if (req.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
        return new Response(
          concat([
            encodePktLine("unpack ok\n"),
            encodePktLine("ng refs/heads/main hooks/pre-receive blocked\n"),
            FLUSH_PKT,
          ]),
        );
      }
      return new Response("404", { status: 404 });
    };

    const result = await commitFileChange({
      artifactsUrl: "https://x.artifacts.cloudflare.net/git/blocked.git",
      branch: "main",
      pathParts: ["x"],
      newContent: new TextEncoder().encode("y"),
      authorName: "T",
      authorEmail: "t@e",
      authorTimestamp: 1,
      message: "m",
      bucket: env.OBJECTS,
      repoPath: "blocked-repo",
      wasm,
      fetcher,
    });

    expect(result.pushResult.unpackOk).toBe(true);
    expect(result.pushResult.refResults).toEqual([
      { ref: "refs/heads/main", ok: false, error: "hooks/pre-receive blocked" },
    ]);
  });
});

void PackWorkerDO;
