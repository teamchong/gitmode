// blame-walk — per-line attribution by walking history of a file.
//
// Walks first-parent history from a starting commit. For each ancestor,
// resolves the file's blob, reads its content, and pushes per-line
// attribution back to the older commit if the line is also present
// there. The final attribution for each line is the OLDEST commit in
// the walked chain where the line is still present — equivalently,
// the commit that introduced (or last reintroduced) that line.
//
// Limitations (POC quality):
//   - First-parent walk only; merges follow only one branch
//   - Line identity by string equality (not Myers-style line tracking)
//   - No rename / copy detection (`-M` / `-C` in real git blame)
//   - Trailing empty line from final newline is dropped before attribution
//
// The naive set-based line tracking is wrong for files with duplicate
// lines (multiple "" or repeated boilerplate); proper blame requires
// running a diff and following matched lines through parents.

import type { CommitLookup } from "./merge-base";
import { parseCommitsRPC, readBlobsRPC, walkTreesRPC } from "./pool-rpc";

export interface BlameLine {
  lineNumber: number;
  line: string;
  commit: string;
}

export interface BlameWalkOptions {
  startSha: string;
  filePath: string;
  repoPath: string;
  /** Lookup that resolves any sha (commit, tree, or blob) to its R2 location. */
  lookup: CommitLookup;
  pool: DurableObjectNamespace;
  /** Cap on history walk depth. Default 1000. */
  maxDepth?: number;
  /** Per-blob size cap when reading content. Default 4MB. */
  maxBlobBytes?: number;
  /** Slot name override; defaults to `blame-walk-{repoPath}`. */
  slotName?: string;
}

const DIR_MODE = "040000";

async function resolveBlobAtPath(
  pool: DurableObjectNamespace,
  slotName: string,
  repoPath: string,
  lookup: CommitLookup,
  rootTreeSha: string,
  pathParts: string[],
): Promise<string | null> {
  let currentTree = rootTreeSha;
  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    const trees = await walkTreesRPC(pool, slotName, repoPath, lookup, [currentTree]);
    const tree = trees[0];
    if (!tree) return null;
    const entry = tree.entries.find((e) => e.name === part);
    if (!entry) return null;
    if (i === pathParts.length - 1) {
      // Final path component must be a blob, not a directory
      if (entry.mode === DIR_MODE) return null;
      return entry.sha;
    }
    if (entry.mode !== DIR_MODE) return null;
    currentTree = entry.sha;
  }
  return null;
}

async function readBlobText(
  pool: DurableObjectNamespace,
  slotName: string,
  repoPath: string,
  lookup: CommitLookup,
  blobSha: string,
  maxBlobBytes: number,
): Promise<string | null> {
  const blobs = await readBlobsRPC(pool, slotName, repoPath, lookup, [blobSha], maxBlobBytes);
  const blob = blobs[0];
  if (!blob) return null;
  const bytes = new Uint8Array(Buffer.from(blob.contentBase64, "base64"));
  return new TextDecoder().decode(bytes);
}

function splitContentLines(content: string): string[] {
  const lines = content.split("\n");
  // Drop trailing empty entry from `split` when content ends with \n.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Compute per-line blame attribution for `filePath` at `startSha`.
 *
 * Returns one entry per line in the file's content at `startSha`, with the
 * commit that introduced (or last reintroduced) that line. Returns `null`
 * if the file does not exist at `startSha`.
 */
export async function blameWalk(opts: BlameWalkOptions): Promise<BlameLine[] | null> {
  const { startSha, filePath, repoPath, lookup, pool } = opts;
  const maxDepth = opts.maxDepth ?? 1000;
  const maxBlobBytes = opts.maxBlobBytes ?? 4 * 1024 * 1024;
  const slotName = opts.slotName ?? `blame-walk-${repoPath}`;

  const pathParts = filePath.split("/").filter(Boolean);
  if (pathParts.length === 0) return null;

  const startCommits = await parseCommitsRPC(pool, slotName, repoPath, lookup, [startSha]);
  const startCommit = startCommits[0];
  if (!startCommit) return null;

  const startBlobSha = await resolveBlobAtPath(
    pool,
    slotName,
    repoPath,
    lookup,
    startCommit.tree,
    pathParts,
  );
  if (!startBlobSha) return null;

  const startContent = await readBlobText(
    pool,
    slotName,
    repoPath,
    lookup,
    startBlobSha,
    maxBlobBytes,
  );
  if (startContent === null) return null;

  const lines = splitContentLines(startContent);
  // Each line starts attributed to startSha; we'll push back to older
  // ancestors as long as the line text is still present.
  const attribution: string[] = lines.map(() => startSha);

  let currentSha = startSha;
  let currentParents = startCommit.parents;

  for (let depth = 0; depth < maxDepth; depth++) {
    if (currentParents.length === 0) break;
    const parentSha = currentParents[0]!;

    const [parentCommit] = await parseCommitsRPC(pool, slotName, repoPath, lookup, [parentSha]);
    if (!parentCommit) break;

    const parentBlobSha = await resolveBlobAtPath(
      pool,
      slotName,
      repoPath,
      lookup,
      parentCommit.tree,
      pathParts,
    );

    if (!parentBlobSha) {
      // File didn't exist in this ancestor — any line still attributed
      // to currentSha was added in currentSha. Stop walking.
      break;
    }

    if (parentBlobSha === startBlobSha) {
      // Same blob → all lines present in parent. Push every line still
      // at currentSha back to parentSha and continue.
      for (let i = 0; i < attribution.length; i++) {
        if (attribution[i] === currentSha) attribution[i] = parentSha;
      }
    } else {
      const parentText = await readBlobText(
        pool,
        slotName,
        repoPath,
        lookup,
        parentBlobSha,
        maxBlobBytes,
      );
      if (parentText === null) break;
      const parentLines = splitContentLines(parentText);
      const parentSet = new Set(parentLines);
      for (let i = 0; i < lines.length; i++) {
        if (attribution[i] === currentSha && parentSet.has(lines[i]!)) {
          attribution[i] = parentSha;
        }
      }
    }

    currentSha = parentSha;
    currentParents = parentCommit.parents;
  }

  return lines.map((line, idx) => ({
    lineNumber: idx + 1,
    line,
    commit: attribution[idx]!,
  }));
}
