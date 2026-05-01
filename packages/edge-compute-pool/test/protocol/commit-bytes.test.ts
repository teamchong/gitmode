// Tests for buildCommitBytes — pure function from commit metadata to
// the bytes that go inside the `commit <size>\0…` git object.

import { describe, expect, it } from "vitest";
import { buildCommitBytes } from "../../src/protocol/commit-bytes";
import { parseCommitBody } from "../../src/commit-parse";

const TREE = "1".repeat(40);
const PARENT = "2".repeat(40);
const PARENT2 = "3".repeat(40);

describe("buildCommitBytes", () => {
  it("produces a body that round-trips through parseCommitBody (root commit)", () => {
    const bytes = buildCommitBytes({
      tree: TREE,
      parents: [],
      authorName: "Alice",
      authorEmail: "alice@example.com",
      authorTimestamp: 1700000000,
      message: "initial commit",
    });
    const info = parseCommitBody("xxx", bytes);
    expect(info.tree).toBe(TREE);
    expect(info.parents).toEqual([]);
    expect(info.author).toBe("Alice");
    expect(info.authorEmail).toBe("alice@example.com");
    expect(info.authorTimestamp).toBe(1700000000);
    expect(info.summary).toBe("initial commit");
    // Committer defaults to author
    expect(info.committer).toBe("Alice");
    expect(info.committerEmail).toBe("alice@example.com");
    expect(info.committerTimestamp).toBe(1700000000);
  });

  it("emits parent lines in order for non-root commits", () => {
    const bytes = buildCommitBytes({
      tree: TREE,
      parents: [PARENT],
      authorName: "Alice",
      authorEmail: "a@e",
      authorTimestamp: 1,
      message: "child",
    });
    const info = parseCommitBody("xxx", bytes);
    expect(info.parents).toEqual([PARENT]);
  });

  it("emits multiple parents for merge commits", () => {
    const bytes = buildCommitBytes({
      tree: TREE,
      parents: [PARENT, PARENT2],
      authorName: "Alice",
      authorEmail: "a@e",
      authorTimestamp: 1,
      message: "merge",
    });
    const info = parseCommitBody("xxx", bytes);
    expect(info.parents).toEqual([PARENT, PARENT2]);
  });

  it("supports separate author and committer identities", () => {
    const bytes = buildCommitBytes({
      tree: TREE,
      parents: [],
      authorName: "Alice",
      authorEmail: "alice@e",
      authorTimestamp: 1700000000,
      committerName: "Bob",
      committerEmail: "bob@e",
      committerTimestamp: 1700000010,
      message: "x",
    });
    const info = parseCommitBody("xxx", bytes);
    expect(info.author).toBe("Alice");
    expect(info.authorEmail).toBe("alice@e");
    expect(info.committer).toBe("Bob");
    expect(info.committerEmail).toBe("bob@e");
    expect(info.committerTimestamp).toBe(1700000010);
  });

  it("rejects malformed tree sha", () => {
    expect(() =>
      buildCommitBytes({
        tree: "not-a-sha",
        parents: [],
        authorName: "x",
        authorEmail: "x@x",
        authorTimestamp: 0,
        message: "x",
      }),
    ).toThrow(/invalid tree sha/);
  });

  it("rejects malformed parent sha", () => {
    expect(() =>
      buildCommitBytes({
        tree: TREE,
        parents: ["bad"],
        authorName: "x",
        authorEmail: "x@x",
        authorTimestamp: 0,
        message: "x",
      }),
    ).toThrow(/invalid parent sha/);
  });

  it("preserves multi-line messages including blank lines", () => {
    const message = "subject line\n\nfirst paragraph.\n\nsecond paragraph.";
    const bytes = buildCommitBytes({
      tree: TREE,
      parents: [],
      authorName: "x",
      authorEmail: "x@x",
      authorTimestamp: 0,
      message,
    });
    const info = parseCommitBody("xxx", bytes);
    expect(info.message).toBe(message);
    expect(info.summary).toBe("subject line");
  });
});
