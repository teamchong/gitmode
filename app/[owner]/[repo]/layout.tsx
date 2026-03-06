import { getRepoMeta } from "../../lib/api";
import { TabLink } from "./tab-link";

export default async function RepoLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;

  let defaultBranch = "main";
  try {
    const meta = await getRepoMeta(owner, repo);
    if (meta?.default_branch) defaultBranch = meta.default_branch;
  } catch {
    // meta not available
  }

  return (
    <div>
      <div style={{ marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1.25rem" }}>
          <a href={`/${owner}`} style={{ color: "var(--text-secondary)" }}>
            {owner}
          </a>
          <span style={{ color: "var(--text-secondary)", margin: "0 4px" }}>/</span>
          <a href={`/${owner}/${repo}`}>{repo}</a>
        </h2>
      </div>

      <nav style={{
        display: "flex",
        gap: 0,
        borderBottom: "1px solid var(--border)",
        marginBottom: "1rem",
      }}>
        <TabLink href={`/${owner}/${repo}`}>Code</TabLink>
        <TabLink href={`/${owner}/${repo}/commits/${defaultBranch}`}>Commits</TabLink>
        <TabLink href={`/${owner}/${repo}/branches`}>Branches</TabLink>
        <TabLink href={`/${owner}/${repo}/tags`}>Tags</TabLink>
      </nav>

      {children}
    </div>
  );
}
