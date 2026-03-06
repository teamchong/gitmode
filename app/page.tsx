import { getEnv } from "./lib/env";

interface Repo {
  owner: string;
  name: string;
  description: string | null;
  default_branch: string;
}

export default async function HomePage() {
  let repos: Repo[] = [];
  try {
    const env = getEnv();
    const result = await env.META.prepare(
      "SELECT owner, name, description, default_branch FROM repos ORDER BY owner, name"
    ).all<Repo>();
    repos = result.results;
  } catch {
    // env not available or DB empty — show empty state
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        gitmode
      </h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: "1.5rem" }}>
        Git hosting on Cloudflare Workers.
      </p>

      {repos.length === 0 ? (
        <div style={{ color: "var(--text-secondary)", padding: "2rem 0" }}>
          No repositories yet. Push your first repo:
          <pre style={{ marginTop: "0.5rem" }}>
            git remote add origin https://your-worker.dev/username/repo.git{"\n"}
            git push -u origin main
          </pre>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Repository</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={`${repo.owner}/${repo.name}`}>
                <td>
                  <a href={`/${repo.owner}/${repo.name}`}>
                    {repo.owner}/{repo.name}
                  </a>
                </td>
                <td style={{ color: "var(--text-secondary)" }}>
                  {repo.description || ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
