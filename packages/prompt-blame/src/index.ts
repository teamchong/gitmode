export interface Env {
  PROMPT_BLAME_DB: D1Database;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_REPO_LEN = 1024;
const MAX_FIELD_LEN = 512;

const STRING_FIELDS = [
  "prompt_id",
  "model",
  "agent",
  "session_id",
  "parent_session_id",
  "human_author_email",
] as const;

type StringField = (typeof STRING_FIELDS)[number];

interface CommitMetadataInput {
  repo_id: string;
  commit_sha: string;
  prompt_id?: string;
  model?: string;
  agent?: string;
  session_id?: string;
  parent_session_id?: string;
  human_edited?: boolean;
  human_author_email?: string;
  metadata_json?: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

function notFound(): Response {
  return jsonResponse({ error: "not found" }, 404);
}

function validate(body: unknown): CommitMetadataInput | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;

  if (typeof b.repo_id !== "string" || b.repo_id.length === 0) {
    return "repo_id must be a non-empty string";
  }
  if (b.repo_id.length > MAX_REPO_LEN) {
    return `repo_id too long (max ${MAX_REPO_LEN})`;
  }
  if (typeof b.commit_sha !== "string" || !SHA_RE.test(b.commit_sha)) {
    return "commit_sha must be 40 lowercase hex characters";
  }

  const result: CommitMetadataInput = {
    repo_id: b.repo_id.toLowerCase(),
    commit_sha: b.commit_sha,
  };

  for (const field of STRING_FIELDS) {
    const value = b[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return `${field} must be a string`;
    if (value.length > MAX_FIELD_LEN) return `${field} too long (max ${MAX_FIELD_LEN})`;
    result[field as StringField] = value;
  }

  if (b.human_edited !== undefined && b.human_edited !== null) {
    if (typeof b.human_edited !== "boolean") return "human_edited must be boolean";
    result.human_edited = b.human_edited;
  }

  if (b.metadata_json !== undefined && b.metadata_json !== null) {
    if (typeof b.metadata_json === "string") {
      try {
        JSON.parse(b.metadata_json);
      } catch {
        return "metadata_json must be valid JSON when provided as a string";
      }
      result.metadata_json = b.metadata_json;
    } else if (typeof b.metadata_json === "object") {
      result.metadata_json = JSON.stringify(b.metadata_json);
    } else {
      return "metadata_json must be a JSON string or object";
    }
  }

  return result;
}

async function handlePost(req: Request, env: Env): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }

  const validated = validate(raw);
  if (typeof validated === "string") return badRequest(validated);

  const now = Date.now();

  await env.PROMPT_BLAME_DB.prepare(
    `INSERT INTO commit_metadata (
       repo_id, commit_sha,
       prompt_id, model, agent, session_id, parent_session_id,
       human_edited, human_author_email, metadata_json,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, commit_sha) DO UPDATE SET
       prompt_id = excluded.prompt_id,
       model = excluded.model,
       agent = excluded.agent,
       session_id = excluded.session_id,
       parent_session_id = excluded.parent_session_id,
       human_edited = excluded.human_edited,
       human_author_email = excluded.human_author_email,
       metadata_json = excluded.metadata_json`,
  )
    .bind(
      validated.repo_id,
      validated.commit_sha,
      validated.prompt_id ?? null,
      validated.model ?? null,
      validated.agent ?? null,
      validated.session_id ?? null,
      validated.parent_session_id ?? null,
      validated.human_edited ? 1 : 0,
      validated.human_author_email ?? null,
      validated.metadata_json ?? null,
      now,
    )
    .run();

  return jsonResponse(
    { ok: true, repo_id: validated.repo_id, commit_sha: validated.commit_sha },
    201,
  );
}

interface CommitMetadataRow {
  repo_id: string;
  commit_sha: string;
  prompt_id: string | null;
  model: string | null;
  agent: string | null;
  session_id: string | null;
  parent_session_id: string | null;
  human_edited: number;
  human_author_email: string | null;
  metadata_json: string | null;
  created_at: number;
}

async function handleGet(url: URL, env: Env): Promise<Response> {
  const repo = url.searchParams.get("repo");
  const sha = url.searchParams.get("sha");

  if (!repo) return badRequest("repo query param required");
  if (!sha) return badRequest("sha query param required");
  if (!SHA_RE.test(sha)) return badRequest("sha must be 40 lowercase hex characters");

  const row = await env.PROMPT_BLAME_DB.prepare(
    `SELECT repo_id, commit_sha, prompt_id, model, agent, session_id,
            parent_session_id, human_edited, human_author_email,
            metadata_json, created_at
     FROM commit_metadata
     WHERE repo_id = ? AND commit_sha = ?`,
  )
    .bind(repo.toLowerCase(), sha.toLowerCase())
    .first<CommitMetadataRow>();

  if (!row) return notFound();

  return jsonResponse({
    repo_id: row.repo_id,
    commit_sha: row.commit_sha,
    prompt_id: row.prompt_id,
    model: row.model,
    agent: row.agent,
    session_id: row.session_id,
    parent_session_id: row.parent_session_id,
    human_edited: row.human_edited === 1,
    human_author_email: row.human_author_email,
    metadata_json: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    created_at: row.created_at,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/metadata") {
      if (req.method === "POST") return handlePost(req, env);
      if (req.method === "GET") return handleGet(url, env);
      return new Response("method not allowed", { status: 405 });
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
