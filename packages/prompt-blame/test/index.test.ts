import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const REPO = "https://github.com/user/repo.git";

const MIGRATION = `
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
CREATE INDEX IF NOT EXISTS idx_commit_metadata_session
  ON commit_metadata (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commit_metadata_prompt
  ON commit_metadata (prompt_id) WHERE prompt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commit_metadata_repo_agent
  ON commit_metadata (repo_id, agent) WHERE agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commit_metadata_repo_time
  ON commit_metadata (repo_id, created_at DESC);
`;

beforeAll(async () => {
  const stmts = MIGRATION.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of stmts) {
    await env.PROMPT_BLAME_DB.exec(stmt.replace(/\n/g, " "));
  }
});

async function postMetadata(body: object): Promise<Response> {
  return SELF.fetch("https://example.com/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getMetadata(repo: string, sha: string): Promise<Response> {
  const url = `https://example.com/metadata?repo=${encodeURIComponent(repo)}&sha=${sha}`;
  return SELF.fetch(url);
}

describe("POST /metadata", () => {
  it("creates a metadata row with all fields", async () => {
    const res = await postMetadata({
      repo_id: REPO,
      commit_sha: SHA_A,
      prompt_id: "prompt-1",
      model: "claude-opus-4-7",
      agent: "claude-code",
      session_id: "session-1",
      human_edited: false,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; commit_sha: string };
    expect(body.ok).toBe(true);
    expect(body.commit_sha).toBe(SHA_A);
  });

  it("creates a metadata row with only required fields", async () => {
    const res = await postMetadata({ repo_id: REPO, commit_sha: SHA_B });
    expect(res.status).toBe(201);
  });

  it("upserts on conflict", async () => {
    await postMetadata({ repo_id: REPO, commit_sha: SHA_C, agent: "cursor" });
    const res = await postMetadata({ repo_id: REPO, commit_sha: SHA_C, agent: "claude-code" });
    expect(res.status).toBe(201);

    const get = await getMetadata(REPO, SHA_C);
    const row = (await get.json()) as { agent: string };
    expect(row.agent).toBe("claude-code");
  });

  it("rejects invalid sha", async () => {
    const res = await postMetadata({ repo_id: REPO, commit_sha: "not-a-sha" });
    expect(res.status).toBe(400);
  });

  it("rejects missing repo_id", async () => {
    const res = await postMetadata({ commit_sha: SHA_A });
    expect(res.status).toBe(400);
  });

  it("rejects non-boolean human_edited", async () => {
    const res = await postMetadata({
      repo_id: REPO,
      commit_sha: "d".repeat(40),
      human_edited: "yes",
    });
    expect(res.status).toBe(400);
  });

  it("accepts metadata_json as object", async () => {
    const res = await postMetadata({
      repo_id: REPO,
      commit_sha: "e".repeat(40),
      metadata_json: { tokens_used: 1234, cache_hit: true },
    });
    expect(res.status).toBe(201);

    const get = await getMetadata(REPO, "e".repeat(40));
    const row = (await get.json()) as { metadata_json: { tokens_used: number } };
    expect(row.metadata_json.tokens_used).toBe(1234);
  });

  it("rejects invalid JSON body", async () => {
    const res = await SELF.fetch("https://example.com/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("normalizes repo_id to lowercase", async () => {
    const upper = "https://github.com/USER/Repo.git";
    const sha = "f".repeat(40);
    const post = await postMetadata({ repo_id: upper, commit_sha: sha });
    expect(post.status).toBe(201);

    const get = await getMetadata(upper.toLowerCase(), sha);
    expect(get.status).toBe(200);
  });
});

describe("GET /metadata", () => {
  it("returns 404 when not found", async () => {
    const res = await getMetadata("https://nope.example.com/x.git", "0".repeat(40));
    expect(res.status).toBe(404);
  });

  it("returns the row after POST", async () => {
    const sha = "1".repeat(40);
    await postMetadata({
      repo_id: REPO,
      commit_sha: sha,
      prompt_id: "prompt-1",
      model: "claude-opus-4-7",
      agent: "claude-code",
      session_id: "session-1",
      human_edited: false,
    });

    const res = await getMetadata(REPO, sha);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repo_id: string;
      commit_sha: string;
      agent: string;
      human_edited: boolean;
      created_at: number;
    };
    expect(body.repo_id).toBe(REPO);
    expect(body.commit_sha).toBe(sha);
    expect(body.agent).toBe("claude-code");
    expect(body.human_edited).toBe(false);
    expect(typeof body.created_at).toBe("number");
  });

  it("requires repo and sha params", async () => {
    const noRepo = await SELF.fetch(`https://example.com/metadata?sha=${SHA_A}`);
    expect(noRepo.status).toBe(400);

    const noSha = await SELF.fetch(`https://example.com/metadata?repo=${encodeURIComponent(REPO)}`);
    expect(noSha.status).toBe(400);
  });

  it("rejects invalid sha", async () => {
    const res = await SELF.fetch(
      `https://example.com/metadata?repo=${encodeURIComponent(REPO)}&sha=bad`,
    );
    expect(res.status).toBe(400);
  });
});

describe("misc", () => {
  it("healthz returns ok", async () => {
    const res = await SELF.fetch("https://example.com/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("unknown route returns 404", async () => {
    const res = await SELF.fetch("https://example.com/nope");
    expect(res.status).toBe(404);
  });

  it("disallowed method returns 405", async () => {
    const res = await SELF.fetch("https://example.com/metadata", { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});
