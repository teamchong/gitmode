// Cross-package end-to-end test: the full toolkit composing.
//
// Demonstrates the envisioned production pipeline:
//   1. fetchArtifactsCommit  → stage commit closure in R2
//   2. blameWalk             → per-line attribution
//   3. PROMPT_BLAME_DB join  → enrich each line's commit with prompt provenance
//
// The README's "Full toolkit composing against an Artifacts repo" snippet is
// implemented and tested here. This is the only test that exercises all three
// packages (@gitmode/wasm-git, @gitmode/edge-compute-pool, prompt-blame schema)
// in one Worker context.

import { env } from "cloudflare:test";
import { describe, expect, it, beforeAll } from "vitest";
import { deflateSync } from "node:zlib";
import { WasmEngine, toHex } from "@gitmode/wasm-git";
import {
  PackWorkerDO,
  fetchArtifactsCommit,
  blameWalk,
  type CommitLookup,
} from "../src/index";
import {
  encodePktLine,
  encodePktLineBytes,
  FLUSH_PKT,
  concat,
} from "../src/protocol/pkt-line";

// ---------- prompt-blame schema (mirrors @gitmode/prompt-blame migrations) ----------

const PROMPT_BLAME_SCHEMA = `
CREATE TABLE IF NOT EXISTS commit_metadata (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  prompt_id TEXT,
  model TEXT,
  agent TEXT,
  session_id TEXT,
  parent_session_id TEXT,
  human_edited INTEGER NOT NULL DEFAULT 0,
  human_author_email TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_sha)
);
`;

// ---------- pack & object encoders ----------

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
  return toHex(await sha1Bytes(buf));
}

async function buildPackfile(objs: Array<{ type: number; content: Uint8Array }>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [
    new TextEncoder().encode("PACK"),
    writeUint32BE(2),
    writeUint32BE(objs.length),
  ];
  for (const o of objs) {
    parts.push(writeTypeSizeHeader(o.type, o.content.length));
    const def = deflateSync(o.content);
    parts.push(new Uint8Array(def.buffer, def.byteOffset, def.byteLength));
  }
  const body = concat(parts);
  const trailer = await sha1Bytes(body);
  const out = new Uint8Array(body.length + 20);
  out.set(body, 0);
  out.set(trailer, body.length);
  return out;
}

function shaToBytes(sha: string): Uint8Array {
  const b = new Uint8Array(20);
  for (let i = 0; i < 20; i++) b[i] = parseInt(sha.substr(i * 2, 2), 16);
  return b;
}

function encodeTreeBody(entries: Array<{ mode: string; name: string; sha: string }>): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(new TextEncoder().encode(`${e.mode} ${e.name}\0`));
    parts.push(shaToBytes(e.sha));
  }
  return concat(parts);
}

function encodeCommitBody(opts: {
  tree: string;
  parents: string[];
  authorTs: number;
  message: string;
}): Uint8Array {
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author Tester <t@e> ${opts.authorTs} +0000`);
  lines.push(`committer Tester <t@e> ${opts.authorTs} +0000`);
  return new TextEncoder().encode(lines.join("\n") + "\n\n" + opts.message);
}

// ---------- in-memory Artifacts server ----------

function makeArtifactsServer(packBody: Uint8Array, headSha: string): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      return new Response(
        concat([
          encodePktLine("# service=git-upload-pack\n"),
          FLUSH_PKT,
          encodePktLine(`${headSha} HEAD\0multi_ack thin-pack side-band-64k\n`),
          encodePktLine(`${headSha} refs/heads/main\n`),
          FLUSH_PKT,
        ]),
        { status: 200 },
      );
    }

    if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
      const ack = encodePktLine("NAK\n");
      const sideband = new Uint8Array(packBody.length + 1);
      sideband[0] = 0x01;
      sideband.set(packBody, 1);
      return new Response(
        concat([ack, encodePktLineBytes(sideband), FLUSH_PKT]),
        { status: 200 },
      );
    }

    return new Response("not found", { status: 404 });
  };
}

// ---------- fixture: 3-commit repo modifying a single file ----------
//
// COMMIT_A (root)         — adds foo.txt = "line one\nline two\n"
// COMMIT_B parent=A       — appends "line three"
// COMMIT_C parent=B       — modifies "line two" → "line two CHANGED"
//
// Each commit was authored by a different "agent" — recorded in PROMPT_BLAME_DB
// so that the joined blame output shows attribution + provenance.

const REPO_PATH = "full-pipeline-repo";
const REPO_ID = "https://x.artifacts.cloudflare.net/git/full-pipeline.git";

interface Fixture {
  blobA: string;
  blobB: string;
  blobC: string;
  treeA: string;
  treeB: string;
  treeC: string;
  rootA: string;
  rootB: string;
  rootC: string;
  commitA: string;
  commitB: string;
  commitC: string;
  pack: Uint8Array;
}

let fx: Fixture;

async function buildFixture(): Promise<Fixture> {
  const blobAContent = new TextEncoder().encode("line one\nline two\n");
  const blobBContent = new TextEncoder().encode("line one\nline two\nline three\n");
  const blobCContent = new TextEncoder().encode("line one\nline two CHANGED\nline three\n");

  const blobA = await gitObjectSha("blob", blobAContent);
  const blobB = await gitObjectSha("blob", blobBContent);
  const blobC = await gitObjectSha("blob", blobCContent);

  const treeABody = encodeTreeBody([{ mode: "100644", name: "foo.txt", sha: blobA }]);
  const treeBBody = encodeTreeBody([{ mode: "100644", name: "foo.txt", sha: blobB }]);
  const treeCBody = encodeTreeBody([{ mode: "100644", name: "foo.txt", sha: blobC }]);
  const treeA = await gitObjectSha("tree", treeABody);
  const treeB = await gitObjectSha("tree", treeBBody);
  const treeC = await gitObjectSha("tree", treeCBody);

  const rootABody = encodeTreeBody([{ mode: "040000", name: "src", sha: treeA }]);
  const rootBBody = encodeTreeBody([{ mode: "040000", name: "src", sha: treeB }]);
  const rootCBody = encodeTreeBody([{ mode: "040000", name: "src", sha: treeC }]);
  const rootA = await gitObjectSha("tree", rootABody);
  const rootB = await gitObjectSha("tree", rootBBody);
  const rootC = await gitObjectSha("tree", rootCBody);

  const commitABody = encodeCommitBody({ tree: rootA, parents: [], authorTs: 1, message: "add foo.txt" });
  const commitA = await gitObjectSha("commit", commitABody);
  const commitBBody = encodeCommitBody({ tree: rootB, parents: [commitA], authorTs: 2, message: "append" });
  const commitB = await gitObjectSha("commit", commitBBody);
  const commitCBody = encodeCommitBody({ tree: rootC, parents: [commitB], authorTs: 3, message: "modify" });
  const commitC = await gitObjectSha("commit", commitCBody);

  const pack = await buildPackfile([
    { type: 3, content: blobAContent },
    { type: 3, content: blobBContent },
    { type: 3, content: blobCContent },
    { type: 2, content: treeABody },
    { type: 2, content: treeBBody },
    { type: 2, content: treeCBody },
    { type: 2, content: rootABody },
    { type: 2, content: rootBBody },
    { type: 2, content: rootCBody },
    { type: 1, content: commitABody },
    { type: 1, content: commitBBody },
    { type: 1, content: commitCBody },
  ]);

  return {
    blobA, blobB, blobC,
    treeA, treeB, treeC,
    rootA, rootB, rootC,
    commitA, commitB, commitC,
    pack,
  };
}

beforeAll(async () => {
  // Apply prompt-blame schema to the local D1 binding.
  for (const stmt of PROMPT_BLAME_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.PROMPT_BLAME_DB.exec(stmt.replace(/\n/g, " "));
  }

  fx = await buildFixture();

  // Pre-populate prompt-blame metadata for each commit, simulating what
  // various agents would have recorded after producing each commit.
  const now = Date.now();
  const insert = env.PROMPT_BLAME_DB.prepare(
    `INSERT INTO commit_metadata (repo_id, commit_sha, prompt_id, model, agent, session_id, human_edited, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  await insert.bind(REPO_ID, fx.commitA, "prompt-init", "claude-opus-4-7", "claude-code", "session-A", now).run();
  await insert.bind(REPO_ID, fx.commitB, "prompt-append", "gpt-5", "cursor", "session-B", now).run();
  await insert.bind(REPO_ID, fx.commitC, "prompt-fix", "claude-opus-4-7", "claude-code", "session-C", now).run();
});

// ---------- the actual pipeline test ----------

interface EnrichedBlameLine {
  lineNumber: number;
  line: string;
  commit: string;
  prompt_id: string | null;
  model: string | null;
  agent: string | null;
  session_id: string | null;
}

async function enrichBlameWithProvenance(
  blame: Array<{ lineNumber: number; line: string; commit: string }>,
  repoId: string,
): Promise<EnrichedBlameLine[]> {
  // Distinct commit SHAs across all blame lines
  const uniqueCommits = [...new Set(blame.map((b) => b.commit))];
  if (uniqueCommits.length === 0) return [];

  // Single round-trip query for all needed metadata. For larger blame
  // outputs you'd batch in chunks (D1 has a 100-bind limit).
  const bindMarkers = uniqueCommits.map(() => "?").join(",");
  interface MetaRow {
    commit_sha: string;
    prompt_id: string | null;
    model: string | null;
    agent: string | null;
    session_id: string | null;
  }
  const stmt = env.PROMPT_BLAME_DB.prepare(
    `SELECT commit_sha, prompt_id, model, agent, session_id FROM commit_metadata
     WHERE repo_id = ? AND commit_sha IN (${bindMarkers})`,
  );
  const queryResult = await stmt.bind(repoId, ...uniqueCommits).all<MetaRow>();
  const rows = queryResult.results as MetaRow[];

  const byCommit = new Map<string, MetaRow>(rows.map((r) => [r.commit_sha, r]));
  return blame.map((b) => {
    const meta = byCommit.get(b.commit);
    return {
      ...b,
      prompt_id: meta?.prompt_id ?? null,
      model: meta?.model ?? null,
      agent: meta?.agent ?? null,
      session_id: meta?.session_id ?? null,
    };
  });
}

describe("full toolkit pipeline (Artifacts fetch + blame + prompt-blame join)", () => {
  it("fetches commits from an Artifacts-shaped server, blames a file, and enriches each line with provenance", async () => {
    const fetcher = makeArtifactsServer(fx.pack, fx.commitC);
    const wasm = await WasmEngine.create();

    // === Step 1: stage the commit closure in R2 via Artifacts smart HTTP ===
    const fetchResult = await fetchArtifactsCommit({
      artifactsUrl: "https://x.artifacts.cloudflare.net/git/full-pipeline.git",
      token: "fake-token",
      commitSha: fx.commitC,
      repoPath: REPO_PATH,
      bucket: env.OBJECTS,
      wasm,
      fetcher,
    });
    expect(fetchResult.objectsWritten).toBe(12);

    // === Step 2: blame foo.txt at HEAD using the staged objects ===
    const lookup: CommitLookup = (sha) => ({ looseKey: `${REPO_PATH}/loose/${sha}` });
    const blame = await blameWalk({
      startSha: fx.commitC,
      filePath: "src/foo.txt",
      repoPath: REPO_PATH,
      lookup,
      pool: env.PACK_WORKER,
    });
    expect(blame).not.toBeNull();
    expect(blame!.length).toBe(3);
    // line one - existed in A → attributed to A
    expect(blame![0]!.commit).toBe(fx.commitA);
    // line two CHANGED - introduced in C
    expect(blame![1]!.commit).toBe(fx.commitC);
    // line three - introduced in B
    expect(blame![2]!.commit).toBe(fx.commitB);

    // === Step 3: enrich blame with prompt-blame metadata ===
    const enriched = await enrichBlameWithProvenance(blame!, REPO_ID);
    expect(enriched.length).toBe(3);

    expect(enriched[0]).toMatchObject({
      lineNumber: 1,
      line: "line one",
      commit: fx.commitA,
      prompt_id: "prompt-init",
      model: "claude-opus-4-7",
      agent: "claude-code",
      session_id: "session-A",
    });
    expect(enriched[1]).toMatchObject({
      lineNumber: 2,
      line: "line two CHANGED",
      commit: fx.commitC,
      prompt_id: "prompt-fix",
      model: "claude-opus-4-7",
      agent: "claude-code",
      session_id: "session-C",
    });
    expect(enriched[2]).toMatchObject({
      lineNumber: 3,
      line: "line three",
      commit: fx.commitB,
      prompt_id: "prompt-append",
      model: "gpt-5",
      agent: "cursor",
      session_id: "session-B",
    });
  });

  it("returns null prompt fields for commits without prompt-blame metadata", async () => {
    const fetcher = makeArtifactsServer(fx.pack, fx.commitC);
    const wasm = await WasmEngine.create();
    const altRepoPath = "full-pipeline-repo-2";

    await fetchArtifactsCommit({
      artifactsUrl: "https://x.artifacts.cloudflare.net/git/full-pipeline.git",
      token: "fake-token",
      commitSha: fx.commitC,
      repoPath: altRepoPath,
      bucket: env.OBJECTS,
      wasm,
      fetcher,
    });

    const lookup: CommitLookup = (sha) => ({ looseKey: `${altRepoPath}/loose/${sha}` });
    const blame = await blameWalk({
      startSha: fx.commitC,
      filePath: "src/foo.txt",
      repoPath: altRepoPath,
      lookup,
      pool: env.PACK_WORKER,
    });

    // Query against an unrelated repo_id — no metadata exists for these commits there
    const enriched = await enrichBlameWithProvenance(blame!, "https://no-metadata.example.com/x.git");
    expect(enriched.length).toBe(3);
    for (const e of enriched) {
      expect(e.prompt_id).toBeNull();
      expect(e.agent).toBeNull();
    }
  });
});

void PackWorkerDO;
