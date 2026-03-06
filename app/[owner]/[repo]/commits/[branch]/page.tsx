import { getEnv } from "../../../../lib/env";

interface Commit {
  sha1: string;
  author: string;
  message: string;
  timestamp: number;
}

export default async function CommitsPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; branch: string }>;
}) {
  const { owner, repo, branch } = await params;
  let commits: Commit[] = [];

  try {
    const env = getEnv();
    const repoKey = `${owner}/${repo}`;
    const result = await env.META.prepare(
      "SELECT sha1, author, message, timestamp FROM commits WHERE repo = ? ORDER BY timestamp DESC LIMIT 50"
    ).bind(repoKey).all<Commit>();
    commits = result.results;
  } catch {
    // env not available or DB empty
  }

  return (
    <div>
      <h3 style={{ fontSize: "1rem", marginBottom: "1rem", color: "var(--text-secondary)" }}>
        Commits on <span style={{ color: "var(--text)" }}>{branch}</span>
      </h3>

      {commits.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", padding: "2rem 0" }}>
          No commits yet.
        </p>
      ) : (
        <div>
          {commits.map((commit) => (
            <div
              key={commit.sha1}
              style={{
                padding: "12px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div style={{ marginBottom: 4 }}>
                <a href={`/${owner}/${repo}/commit/${commit.sha1}`}>
                  {commit.message.split("\n")[0]}
                </a>
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                <span>{commit.author}</span>
                <span style={{ margin: "0 8px" }}>·</span>
                <a
                  href={`/${owner}/${repo}/commit/${commit.sha1}`}
                  style={{ color: "var(--text-secondary)" }}
                >
                  {commit.sha1.slice(0, 7)}
                </a>
                <span style={{ margin: "0 8px" }}>·</span>
                <span>{formatRelativeTime(commit.timestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  // timestamp may be in seconds (git) or milliseconds
  const ts = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const diff = now - ts;

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;

  const date = new Date(ts);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
