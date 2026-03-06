import { getEnv } from "../../../lib/env";

interface Tag {
  name: string;
  sha: string;
}

export default async function TagsPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  let tags: Tag[] = [];

  try {
    const env = getEnv();
    const prefix = `${owner}/${repo}/refs/tags/`;
    const listed = await env.REFS.list({ prefix });

    for (const key of listed.keys) {
      const name = key.name.slice(prefix.length);
      if (name) {
        const sha = await env.REFS.get(key.name);
        tags.push({ name, sha: sha || "" });
      }
    }
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
              <th>SHA</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <tr key={tag.name}>
                <td>{tag.name}</td>
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
