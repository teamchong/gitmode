import { getEnv } from "../lib/env";

interface Repo {
  owner: string;
  name: string;
  description: string | null;
  default_branch: string;
}

export default async function OwnerPage({
  params,
}: {
  params: Promise<{ owner: string }>;
}) {
  const { owner } = await params;
  let repos: Repo[] = [];
  try {
    const env = getEnv();
    const result = await env.META.prepare(
      "SELECT owner, name, description, default_branch FROM repos WHERE owner = ? ORDER BY name"
    ).bind(owner).all<Repo>();
    repos = result.results;
  } catch {
    // env not available or DB empty
  }

  return (
    <div>
      <h2 style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>{owner}</h2>

      {repos.length === 0 ? (
        <p style={{ color: "var(--text-secondary)" }}>
          No repositories found for {owner}.
        </p>
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
              <tr key={repo.name}>
                <td>
                  <a href={`/${owner}/${repo.name}`}>{repo.name}</a>
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
