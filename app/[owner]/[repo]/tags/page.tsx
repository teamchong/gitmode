import { listTags } from "../../../lib/api";

export default async function TagsPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  let tags: Array<{ name: string; sha: string; type: string; tagger?: string; message?: string }> = [];

  try {
    tags = await listTags(owner, repo);
  } catch {
    // env not available
  }

  return (
    <div>
      <h3 style={{ fontSize: "1rem", marginBottom: "1rem", color: "var(--text-secondary)" }}>
        Tags
      </h3>

      {tags.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", padding: "2rem 0" }}>
          No tags yet.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tag</th>
              <th>Type</th>
              <th>SHA</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <tr key={tag.name}>
                <td>
                  {tag.name}
                  {tag.message && (
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                      {tag.message.split("\n")[0]}
                    </div>
                  )}
                </td>
                <td style={{ color: "var(--text-secondary)" }}>
                  {tag.type}
                </td>
                <td>
                  <a
                    href={`/${owner}/${repo}/commit/${tag.sha}`}
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {tag.sha.slice(0, 7)}
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
