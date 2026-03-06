import { getEnv } from "../../../../lib/env";

interface CommitMeta {
  sha1: string;
  author: string;
  message: string;
  timestamp: number;
}

export default async function CommitPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; sha: string }>;
}) {
  const { owner, repo, sha } = await params;
  let commit: CommitMeta | null = null;
  let parentSha = "";
  let commitBody = "";

  try {
    const env = getEnv();
    const repoKey = `${owner}/${repo}`;

    // Get commit metadata from D1
    const result = await env.META.prepare(
      "SELECT sha1, author, message, timestamp FROM commits WHERE repo = ? AND sha1 = ?"
    ).bind(repoKey, sha).first<CommitMeta>();
    commit = result;

    // Try to read the raw commit object from R2 to get parent
    const sha1Prefix = sha.slice(0, 2);
    const sha1Rest = sha.slice(2);
    const objKey = `${owner}/${repo}/objects/${sha1Prefix}/${sha1Rest}`;
    const obj = await env.OBJECTS.get(objKey);
    if (obj) {
      const raw = await obj.text();
      // Parse parent from commit object text
      const parentMatch = raw.match(/parent ([0-9a-f]{40})/);
      if (parentMatch) parentSha = parentMatch[1];
      // Extract body after first blank line
      const bodyStart = raw.indexOf("\n\n");
      if (bodyStart !== -1) commitBody = raw.slice(bodyStart + 2);
    }
  } catch {
    // env not available
  }

  if (!commit) {
    return (
      <p style={{ color: "var(--text-secondary)", padding: "2rem 0" }}>
        Commit not found: {sha}
      </p>
    );
  }

  const ts = commit.timestamp < 1e12 ? commit.timestamp * 1000 : commit.timestamp;
  const date = new Date(ts);

  return (
    <div>
      <div style={{
        background: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "1rem",
        marginBottom: "1rem",
      }}>
        <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
          {commit.message.split("\n")[0]}
        </h3>
        {commitBody && commit.message.includes("\n") && (
          <pre style={{
            background: "transparent",
            border: "none",
            padding: "0.5rem 0",
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
          }}>
            {commitBody}
          </pre>
        )}
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
          <span>{commit.author}</span>
          <span style={{ margin: "0 8px" }}>·</span>
          <span>{date.toLocaleString()}</span>
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
          <span>commit </span>
          <span style={{ color: "var(--text)" }}>{sha}</span>
          {parentSha && (
            <>
              <span style={{ margin: "0 8px" }}>·</span>
              <span>parent </span>
              <a href={`/${owner}/${repo}/commit/${parentSha}`}>{parentSha.slice(0, 7)}</a>
            </>
          )}
        </div>
      </div>

      <p style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
        Diff view requires libgit2 WASM integration (Phase 2).
      </p>
    </div>
  );
}
