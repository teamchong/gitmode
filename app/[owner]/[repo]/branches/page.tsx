import { getEnv } from "../../../lib/env";

interface Branch {
  name: string;
  sha: string;
}

export default async function BranchesPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  let branches: Branch[] = [];

  try {
    const env = getEnv();
    const prefix = `${owner}/${repo}/refs/heads/`;
    const listed = await env.REFS.list({ prefix });

    for (const key of listed.keys) {
      const name = key.name.slice(prefix.length);
      if (name) {
        const sha = await env.REFS.get(key.name);
        branches.push({ name, sha: sha || "" });
      }
    }
  } catch {
    // env not available
  }

  return (
    <div>
      <h3 style={{ fontSize: "1rem", marginBottom: "1rem", color: "var(--text-secondary)" }}>
        Branches
      </h3>

      {branches.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", padding: "2rem 0" }}>
          No branches yet.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Branch</th>
              <th>SHA</th>
            </tr>
          </thead>
          <tbody>
            {branches.map((branch) => (
              <tr key={branch.name}>
                <td>
                  <a href={`/${owner}/${repo}/commits/${branch.name}`}>
                    {branch.name}
                  </a>
                </td>
                <td>
                  <a
                    href={`/${owner}/${repo}/commit/${branch.sha}`}
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {branch.sha.slice(0, 7)}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
