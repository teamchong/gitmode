import { getEnv } from "../../lib/env";
import { getRepoMeta } from "../../lib/api";

interface TreeEntry {
  name: string;
  isDir: boolean;
}

export default async function RepoOverview({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  let branch = "main";
  let entries: TreeEntry[] = [];
  let readme = "";

  try {
    // Get default branch from repo metadata
    const meta = await getRepoMeta(owner, repo);
    if (meta?.default_branch) branch = meta.default_branch;

    const env = getEnv();

    // List root directory from R2 worktree
    const prefix = `${owner}/${repo}/worktrees/${branch}/`;
    const listed = await env.OBJECTS.list({ prefix, delimiter: "/" });

    // Directories (common prefixes)
    for (const p of listed.delimitedPrefixes) {
      const name = p.slice(prefix.length).replace(/\/$/, "");
      if (name) entries.push({ name, isDir: true });
    }

    // Files
    for (const obj of listed.objects) {
      const name = obj.key.slice(prefix.length);
      if (name) entries.push({ name, isDir: false });
    }

    // Sort: directories first, then files, alphabetical within each group
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Try to load README
    for (const readmeName of ["README.md", "README", "README.txt", "readme.md"]) {
      const readmeObj = await env.OBJECTS.get(`${prefix}${readmeName}`);
      if (readmeObj) {
        readme = await readmeObj.text();
        break;
      }
    }
  } catch {
    // env not available
  }

  return (
    <div>
      {entries.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", padding: "2rem 0" }}>
          Empty repository. Push some code to get started.
        </p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Name</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.name}>
                  <td>
                    <span style={{
                      display: "inline-block",
                      width: 16,
                      textAlign: "center",
                      marginRight: 8,
                      color: "var(--text-secondary)",
                    }}>
                      {entry.isDir ? "/" : " "}
                    </span>
                    <a
                      href={`/${owner}/${repo}/${entry.isDir ? "tree" : "blob"}/${branch}/${entry.name}`}
                    >
                      {entry.name}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {readme && (
            <div style={{ marginTop: "1.5rem" }}>
              <h3 style={{
                fontSize: "1rem",
                padding: "8px 12px",
                borderBottom: "1px solid var(--border)",
                color: "var(--text-secondary)",
              }}>
                README
              </h3>
              <pre style={{ padding: "1rem", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {readme}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
