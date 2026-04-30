// Commit object parser.
//
// Git commit objects encode as text:
//
//   tree <sha>
//   parent <sha>
//   parent <sha>
//   author <name> <<email>> <timestamp> <tz>
//   committer <name> <<email>> <timestamp> <tz>
//
//   <message>
//
// This module parses the body (without the "commit <size>\0" object header).
// Use `parseCommitFromRaw` if you have the full raw object including header.

const decoder = new TextDecoder();

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTimestamp: number;
  committer: string;
  committerEmail: string;
  committerTimestamp: number;
  /** First line of the commit message (the "subject"). */
  summary: string;
  /** Full commit message including blank lines. */
  message: string;
}

const AUTHOR_RE = /^author (.+?) <(.+?)> (\d+)/;
const COMMITTER_RE = /^committer (.+?) <(.+?)> (\d+)/;

function emptyCommit(sha: string): CommitInfo {
  return {
    sha,
    tree: "",
    parents: [],
    author: "",
    authorEmail: "",
    authorTimestamp: 0,
    committer: "",
    committerEmail: "",
    committerTimestamp: 0,
    summary: "",
    message: "",
  };
}

/**
 * Parse a commit body (the part after the `commit <size>\0` object header).
 */
export function parseCommitBody(sha: string, body: Uint8Array): CommitInfo {
  const text = decoder.decode(body);
  const headerEnd = text.indexOf("\n\n");
  if (headerEnd === -1) return emptyCommit(sha);

  const headers = text.slice(0, headerEnd).split("\n");
  const message = text.slice(headerEnd + 2);
  const summary = message.split("\n", 1)[0] ?? "";

  const info = emptyCommit(sha);
  info.message = message;
  info.summary = summary;

  for (const line of headers) {
    if (line.startsWith("tree ")) {
      info.tree = line.slice(5);
    } else if (line.startsWith("parent ")) {
      info.parents.push(line.slice(7));
    } else {
      const a = AUTHOR_RE.exec(line);
      if (a) {
        info.author = a[1] ?? "";
        info.authorEmail = a[2] ?? "";
        info.authorTimestamp = parseInt(a[3] ?? "0", 10);
        continue;
      }
      const c = COMMITTER_RE.exec(line);
      if (c) {
        info.committer = c[1] ?? "";
        info.committerEmail = c[2] ?? "";
        info.committerTimestamp = parseInt(c[3] ?? "0", 10);
      }
    }
  }

  return info;
}

/**
 * Parse a raw git object including the `<type> <size>\0` header.
 * Returns null if the header indicates a non-commit type.
 */
export function parseCommitFromRaw(sha: string, raw: Uint8Array): CommitInfo | null {
  const nullIdx = raw.indexOf(0x00);
  if (nullIdx === -1) return null;

  const spaceIdx = raw.indexOf(0x20);
  if (spaceIdx === -1 || spaceIdx > nullIdx) return null;

  const type = decoder.decode(raw.subarray(0, spaceIdx));
  if (type !== "commit") return null;

  return parseCommitBody(sha, raw.subarray(nullIdx + 1));
}
