import { getEnv } from "../../../../lib/env";

export default async function BlobPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; path: string[] }>;
}) {
  const { owner, repo, path } = await params;

  // path[0] is branch, rest is file path
  const branch = path[0] || "main";
  const filePath = path.slice(1).join("/");
  const fileName = path[path.length - 1] || "";

  let content = "";
  let size = 0;
  let found = false;

  try {
    const env = getEnv();
    const key = `${owner}/${repo}/worktrees/${branch}/${filePath}`;
    const obj = await env.OBJECTS.get(key);
    if (obj) {
      found = true;
      size = obj.size;
      // Only read text for files under 1MB
      if (size < 1_000_000) {
        content = await obj.text();
      } else {
        content = `[Binary or large file — ${formatSize(size)}]`;
      }
    }
  } catch {
    // env not available
  }

  const dirPath = path.slice(1, -1).join("/");
  const breadcrumbParts = filePath.split("/");

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
          const isLast = i === breadcrumbParts.length - 1;
          return (
            <span key={partPath}>
              <span style={{ margin: "0 2px" }}>/</span>
              {isLast ? (
                <span style={{ color: "var(--text)" }}>{part}</span>
              ) : (
                <a href={`/${owner}/${repo}/tree/${branch}/${partPath}`}>{part}</a>
              )}
            </span>
          );
        })}
        {found && (
          <span style={{ marginLeft: "auto", fontSize: "12px" }}>
            {formatSize(size)}
          </span>
        )}
      </div>

      {!found ? (
        <p style={{ color: "var(--text-secondary)", padding: "2rem 0" }}>
          File not found: {filePath}
        </p>
      ) : (
        <pre style={{ padding: 0 }}>
          <div style={{ display: "table", width: "100%" }}>
            {content.split("\n").map((line, i) => (
              <div key={i} style={{ display: "table-row" }}>
                <span style={{
                  display: "table-cell",
                  width: "1%",
                  minWidth: 40,
                  padding: "0 12px 0 8px",
                  textAlign: "right",
                  color: "var(--text-secondary)",
                  userSelect: "none",
                  whiteSpace: "nowrap",
                }}>
                  {i + 1}
                </span>
                <span style={{
                  display: "table-cell",
                  padding: "0 12px",
                  whiteSpace: "pre",
                }}>
                  {line}
                </span>
              </div>
            ))}
          </div>
        </pre>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
