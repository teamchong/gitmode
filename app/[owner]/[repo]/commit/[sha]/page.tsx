import { getCommit } from "../../../../lib/api";

export default async function CommitPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; sha: string }>;
}) {
  const { owner, repo, sha } = await params;
  let commit: Awaited<ReturnType<typeof getCommit>> = null;

  try {
    commit = await getCommit(owner, repo, sha);
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

  const ts = commit.authorTimestamp < 1e12 ? commit.authorTimestamp * 1000 : commit.authorTimestamp;
  const date = new Date(ts);
  const [subject, ...bodyLines] = commit.message.split("\n");
  const body = bodyLines.join("\n").trim();

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
          {subject}
        </h3>
        {body && (
          <pre style={{
            background: "transparent",
            border: "none",
            padding: "0.5rem 0",
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
          }}>
            {body}
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
          {commit.parents.length > 0 && (
            <>
              <span style={{ margin: "0 8px" }}>·</span>
              <span>parent </span>
              <a href={`/${owner}/${repo}/commit/${commit.parents[0]}`}>
                {commit.parents[0].slice(0, 7)}
              </a>
              {commit.parents.length > 1 && (
                <>
                  {" + "}
                  <a href={`/${owner}/${repo}/commit/${commit.parents[1]}`}>
                    {commit.parents[1].slice(0, 7)}
                  </a>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
