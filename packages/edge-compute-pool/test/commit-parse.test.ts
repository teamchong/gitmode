import { describe, expect, it } from "vitest";
import { parseCommitBody, parseCommitFromRaw } from "../src/commit-parse";

const TZ = "+0000";
const NL = "\n";

function commitBody(opts: {
  tree: string;
  parents?: string[];
  authorName?: string;
  authorEmail?: string;
  authorTs?: number;
  committerName?: string;
  committerEmail?: string;
  committerTs?: number;
  message?: string;
}): Uint8Array {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents ?? []) lines.push(`parent ${p}`);
  const aName = opts.authorName ?? "Alice";
  const aEmail = opts.authorEmail ?? "alice@example.com";
  const aTs = opts.authorTs ?? 1000000000;
  const cName = opts.committerName ?? aName;
  const cEmail = opts.committerEmail ?? aEmail;
  const cTs = opts.committerTs ?? aTs;
  lines.push(`author ${aName} <${aEmail}> ${aTs} ${TZ}`);
  lines.push(`committer ${cName} <${cEmail}> ${cTs} ${TZ}`);
  const text = lines.join(NL) + NL + NL + (opts.message ?? "");
  return new TextEncoder().encode(text);
}

function withHeader(type: "commit" | "tree" | "blob", body: Uint8Array): Uint8Array {
  const headerStr = `${type} ${body.length}\0`;
  const header = new TextEncoder().encode(headerStr);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

const SHA_T = "1".repeat(40);
const SHA_P1 = "2".repeat(40);
const SHA_P2 = "3".repeat(40);

describe("parseCommitBody", () => {
  it("parses a commit with no parents (root)", () => {
    const body = commitBody({
      tree: SHA_T,
      authorName: "Alice",
      authorEmail: "alice@example.com",
      authorTs: 1700000000,
      message: "initial commit\n\nlong description.\n",
    });
    const info = parseCommitBody("abc", body);
    expect(info.sha).toBe("abc");
    expect(info.tree).toBe(SHA_T);
    expect(info.parents).toEqual([]);
    expect(info.author).toBe("Alice");
    expect(info.authorEmail).toBe("alice@example.com");
    expect(info.authorTimestamp).toBe(1700000000);
    expect(info.summary).toBe("initial commit");
    expect(info.message).toBe("initial commit\n\nlong description.\n");
  });

  it("parses a commit with a single parent", () => {
    const body = commitBody({
      tree: SHA_T,
      parents: [SHA_P1],
      message: "fix bug",
    });
    const info = parseCommitBody("def", body);
    expect(info.parents).toEqual([SHA_P1]);
    expect(info.summary).toBe("fix bug");
  });

  it("parses a merge commit (two parents)", () => {
    const body = commitBody({
      tree: SHA_T,
      parents: [SHA_P1, SHA_P2],
      message: "merge feature into main",
    });
    const info = parseCommitBody("def", body);
    expect(info.parents).toEqual([SHA_P1, SHA_P2]);
  });

  it("parses author and committer separately when different", () => {
    const body = commitBody({
      tree: SHA_T,
      authorName: "Alice",
      authorEmail: "alice@example.com",
      authorTs: 1700000000,
      committerName: "Bob",
      committerEmail: "bob@example.com",
      committerTs: 1700000010,
    });
    const info = parseCommitBody("xyz", body);
    expect(info.author).toBe("Alice");
    expect(info.authorEmail).toBe("alice@example.com");
    expect(info.committer).toBe("Bob");
    expect(info.committerEmail).toBe("bob@example.com");
    expect(info.authorTimestamp).toBe(1700000000);
    expect(info.committerTimestamp).toBe(1700000010);
  });

  it("returns empty fields for malformed body (no header/message separator)", () => {
    const body = new TextEncoder().encode("not a real commit");
    const info = parseCommitBody("xyz", body);
    expect(info.sha).toBe("xyz");
    expect(info.tree).toBe("");
    expect(info.parents).toEqual([]);
    expect(info.message).toBe("");
  });

  it("extracts summary from first line of multi-line message", () => {
    const body = commitBody({
      tree: SHA_T,
      message: "subject line\n\nfirst paragraph.\n\nsecond paragraph.\n",
    });
    const info = parseCommitBody("xyz", body);
    expect(info.summary).toBe("subject line");
    expect(info.message).toBe("subject line\n\nfirst paragraph.\n\nsecond paragraph.\n");
  });
});

describe("parseCommitFromRaw", () => {
  it("strips the 'commit <size>\\0' header and parses body", () => {
    const body = commitBody({ tree: SHA_T, message: "hello" });
    const raw = withHeader("commit", body);
    const info = parseCommitFromRaw("abc", raw);
    expect(info).not.toBeNull();
    expect(info!.tree).toBe(SHA_T);
    expect(info!.summary).toBe("hello");
  });

  it("returns null for non-commit object types", () => {
    const fakeBlob = withHeader("blob", new TextEncoder().encode("file contents"));
    expect(parseCommitFromRaw("abc", fakeBlob)).toBeNull();

    const fakeTree = withHeader("tree", new Uint8Array([0, 1, 2, 3]));
    expect(parseCommitFromRaw("abc", fakeTree)).toBeNull();
  });

  it("returns null for malformed raw object (no NUL byte)", () => {
    const malformed = new TextEncoder().encode("commit no-null-byte here");
    expect(parseCommitFromRaw("abc", malformed)).toBeNull();
  });
});
