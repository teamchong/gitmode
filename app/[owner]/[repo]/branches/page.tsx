import { listBranches } from "../../../lib/api";

export default async function BranchesPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  let branches: Array<{ name: string; sha: string; isHead: boolean }> = [];

  try {
    branches = await listBranches(owner, repo);
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
                  {branch.isHead && (
                    <span style={{ color: "var(--success)", marginLeft: 8, fontSize: "12px" }}>
                      HEAD
                    </span>
                  )}
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
