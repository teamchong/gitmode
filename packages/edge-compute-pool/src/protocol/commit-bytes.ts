// Build a commit object body (no `commit <size>\0` header — that's added
// by the pack writer / sha-1 helper).
//
// Format:
//   tree <sha>\n
//   [parent <sha>\n]*
//   author <name> <<email>> <unix-ts> <±tz>\n
//   committer <name> <<email>> <unix-ts> <±tz>\n
//   \n
//   <message>

export interface BuildCommitOptions {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix timestamp in seconds. */
  authorTimestamp: number;
  /** Timezone like "+0000" or "-0800". Defaults to "+0000". */
  authorTz?: string;
  /** Defaults to authorName if omitted. */
  committerName?: string;
  /** Defaults to authorEmail if omitted. */
  committerEmail?: string;
  /** Defaults to authorTimestamp if omitted. */
  committerTimestamp?: number;
  /** Defaults to authorTz if omitted. */
  committerTz?: string;
  message: string;
}

export function buildCommitBytes(opts: BuildCommitOptions): Uint8Array {
  if (!/^[0-9a-f]{40}$/.test(opts.tree)) {
    throw new Error(`buildCommitBytes: invalid tree sha: ${opts.tree}`);
  }
  for (const p of opts.parents) {
    if (!/^[0-9a-f]{40}$/.test(p)) {
      throw new Error(`buildCommitBytes: invalid parent sha: ${p}`);
    }
  }

  const authorTz = opts.authorTz ?? "+0000";
  const cName = opts.committerName ?? opts.authorName;
  const cEmail = opts.committerEmail ?? opts.authorEmail;
  const cTs = opts.committerTimestamp ?? opts.authorTimestamp;
  const cTz = opts.committerTz ?? authorTz;

  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.authorName} <${opts.authorEmail}> ${opts.authorTimestamp} ${authorTz}`);
  lines.push(`committer ${cName} <${cEmail}> ${cTs} ${cTz}`);

  const text = lines.join("\n") + "\n\n" + opts.message;
  return new TextEncoder().encode(text);
}
