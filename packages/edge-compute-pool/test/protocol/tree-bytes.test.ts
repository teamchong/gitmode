// Tests for tree-bytes encode/parse/mutate primitives.

import { describe, expect, it } from "vitest";
import {
  parseTreeBytes,
  encodeTreeBytes,
  withEntry,
  withoutEntry,
  type TreeEntry,
} from "../../src/protocol/tree-bytes";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("encode/parse round-trip", () => {
  it("round-trips a tree with two file entries", () => {
    const entries: TreeEntry[] = [
      { mode: "100644", name: "README.md", sha: SHA_A },
      { mode: "100644", name: "foo.ts", sha: SHA_B },
    ];
    const encoded = encodeTreeBytes(entries);
    const parsed = parseTreeBytes(encoded);
    expect(parsed.length).toBe(2);
    expect(parsed.map((e) => e.name).sort()).toEqual(["README.md", "foo.ts"]);
    expect(parsed.find((e) => e.name === "README.md")?.sha).toBe(SHA_A);
  });

  it("round-trips a mixed tree with files and directories", () => {
    const entries: TreeEntry[] = [
      { mode: "040000", name: "src", sha: SHA_A },
      { mode: "100644", name: "package.json", sha: SHA_B },
      { mode: "040000", name: "test", sha: SHA_C },
    ];
    const parsed = parseTreeBytes(encodeTreeBytes(entries));
    expect(parsed.length).toBe(3);
  });
});

describe("git sort order (directories sort with trailing /)", () => {
  it("places 'foo.txt' before 'foo/' even though raw string sort would do the opposite", () => {
    // Raw string compare: "foo." < "foo/" by ASCII (0x2e < 0x2f), but git treats
    // directories as "foo/" — so a file named "foo" SHOULD sort before a
    // directory named "foo-bar" (since "foo" < "foo-bar/").
    // Concrete case: file "ab" vs directory "ab.x" — file wins because
    // "ab" < "ab.x/".
    const entries: TreeEntry[] = [
      { mode: "040000", name: "ab.x", sha: SHA_A },
      { mode: "100644", name: "ab", sha: SHA_B },
    ];
    const parsed = parseTreeBytes(encodeTreeBytes(entries));
    expect(parsed[0]!.name).toBe("ab");
    expect(parsed[1]!.name).toBe("ab.x");
  });
});

describe("withEntry", () => {
  it("adds a new entry when the name doesn't exist", () => {
    const before: TreeEntry[] = [{ mode: "100644", name: "a.txt", sha: SHA_A }];
    const after = withEntry(before, { mode: "100644", name: "b.txt", sha: SHA_B });
    expect(after.length).toBe(2);
    expect(after.find((e) => e.name === "b.txt")?.sha).toBe(SHA_B);
  });

  it("replaces an existing entry with the same name", () => {
    const before: TreeEntry[] = [
      { mode: "100644", name: "a.txt", sha: SHA_A },
      { mode: "100644", name: "b.txt", sha: SHA_B },
    ];
    const after = withEntry(before, { mode: "100644", name: "a.txt", sha: SHA_C });
    expect(after.length).toBe(2);
    expect(after.find((e) => e.name === "a.txt")?.sha).toBe(SHA_C);
    expect(after.find((e) => e.name === "b.txt")?.sha).toBe(SHA_B);
  });

  it("doesn't mutate the input array", () => {
    const before: TreeEntry[] = [{ mode: "100644", name: "a.txt", sha: SHA_A }];
    withEntry(before, { mode: "100644", name: "a.txt", sha: SHA_B });
    expect(before[0]!.sha).toBe(SHA_A);
  });
});

describe("withoutEntry", () => {
  it("removes the named entry", () => {
    const before: TreeEntry[] = [
      { mode: "100644", name: "a.txt", sha: SHA_A },
      { mode: "100644", name: "b.txt", sha: SHA_B },
    ];
    const after = withoutEntry(before, "a.txt");
    expect(after.length).toBe(1);
    expect(after[0]!.name).toBe("b.txt");
  });

  it("is a no-op when the name isn't present", () => {
    const before: TreeEntry[] = [{ mode: "100644", name: "a.txt", sha: SHA_A }];
    const after = withoutEntry(before, "nope");
    expect(after.length).toBe(1);
  });
});
