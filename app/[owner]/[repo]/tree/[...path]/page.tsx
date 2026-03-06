import { getEnv } from "../../../../lib/env";

interface TreeEntry {
  name: string;
  isDir: boolean;
}

export default async function TreePage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; path: string[] }>;
}) {
  const { owner, repo, path } = await params;

  // path[0] is branch, rest is directory path
  const branch = path[0] || "main";
  const dirPath = path.slice(1).join("/");

  let entries: TreeEntry[] = [];

  try {
    const env = getEnv();
    const prefix = `${owner}/${repo}/worktrees/${branch}/${dirPath ? dirPath + "/" : ""}`;
    const listed = await env.OBJECTS.list({ prefix, delimiter: "/" });

    for (const p of listed.delimitedPrefixes) {
      const name = p.slice(prefix.length).replace(/\/$/, "");
      if (name) entries.push({ name, isDir: true });
    }

    for (const obj of listed.objects) {
      const name = obj.key.slice(prefix.length);
      if (name) entries.push({ name, isDir: false });
    }

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    // env not available
  }

  const breadcrumbParts = dirPath ? dirPath.split("/") : [];

  return (
    <div>
      <div style={{
        display: "flex",
        gap: 4,
        alignItems: "center",
        color: "var(--text-secondary)",
        marginBottom: "1rem",
      }}>
        <a href={`/${owner}/${repo}`}>{repo}</a>
        {breadcrumbParts.map((part, i) => {
          const partPath = breadcrumbParts.slice(0, i + 1).join("/");
          return (
            <span key={partPath}>
              <span style={{ margin: "0 2px" }}>/</span>
              {i === breadcrumbParts.length - 1 ? (
                <span style={{ color: "var(--text)" }}>{part}</span>
              ) : (
                <a href={`/${owner}/${repo}/tree/${branch}/${partPath}`}>{part}</a>
              )}
            </span>
          );
        })}
      </div>

      {entries.length === 0 ? (
        <p style={{ color: "var(--text-secondary)" }}>Empty directory.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            {dirPath && (
              <tr>
                <td>
                  <span style={{
                    display: "inline-block",
                    width: 16,
                    textAlign: "center",
                    marginRight: 8,
                    color: "var(--text-secondary)",
                  }}>/</span>
                  <a href={
                    breadcrumbParts.length > 1
                      ? `/${owner}/${repo}/tree/${branch}/${breadcrumbParts.slice(0, -1).join("/")}`
                      : `/${owner}/${repo}`
                  }>..</a>
                </td>
              </tr>
            )}
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
                    href={`/${owner}/${repo}/${entry.isDir ? "tree" : "blob"}/${branch}/${dirPath ? dirPath + "/" : ""}${entry.name}`}
                  >
                    {entry.name}
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
