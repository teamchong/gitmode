import { listRepos } from "../lib/api";

export default async function OwnerPage({
  params,
}: {
  params: Promise<{ owner: string }>;
}) {
  const { owner } = await params;
  let repos: Array<{ owner: string; name: string }> = [];
  try {
    repos = await listRepos(owner);
  } catch {
    // env not available
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
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={repo.name}>
                <td>
                  <a href={`/${owner}/${repo.name}`}>{repo.name}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
