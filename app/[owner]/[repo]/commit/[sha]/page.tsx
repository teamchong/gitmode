import { getCommit, getDiff } from "../../../../lib/api";

export default async function CommitPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; sha: string }>;
}) {
  const { owner, repo, sha } = await params;
  let commit: Awaited<ReturnType<typeof getCommit>> = null;
  let diffEntries: Awaited<ReturnType<typeof getDiff>> = [];

  try {
    commit = await getCommit(owner, repo, sha);
    if (commit) {
      diffEntries = await getDiff(owner, repo, sha);
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

  const ts = commit.authorTimestamp < 1e12 ? commit.authorTimestamp * 1000 : commit.authorTimestamp;
  const date = new Date(ts);
  const [subject, ...bodyLines] = commit.message.split("\n");
  const body = bodyLines.join("\n").trim();

  const added = diffEntries.filter(e => e.status === "added").length;
  const modified = diffEntries.filter(e => e.status === "modified").length;
  const deleted = diffEntries.filter(e => e.status === "deleted").length;

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

      {diffEntries.length > 0 && (
        <div>
          <div style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            padding: "8px 0",
            borderBottom: "1px solid var(--border)",
            marginBottom: "8px",
          }}>
            Showing {diffEntries.length} changed file{diffEntries.length !== 1 ? "s" : ""}
            {added > 0 && <span style={{ color: "#3fb950" }}> +{added}</span>}
            {modified > 0 && <span style={{ color: "#d29922" }}> ~{modified}</span>}
            {deleted > 0 && <span style={{ color: "#f85149" }}> -{deleted}</span>}
          </div>
          <table>
            <tbody>
              {diffEntries.map((entry) => (
                <tr key={entry.path}>
                  <td style={{ width: 24, textAlign: "center" }}>
                    <span style={{
                      color: entry.status === "added" ? "#3fb950"
                        : entry.status === "deleted" ? "#f85149"
                        : "#d29922",
                      fontSize: "12px",
                      fontWeight: "bold",
                    }}>
                      {entry.status === "added" ? "A" : entry.status === "deleted" ? "D" : "M"}
                    </span>
                  </td>
                  <td>
                    <a href={`/${owner}/${repo}/blob/${sha}/${entry.path}`}>
                      {entry.path}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
