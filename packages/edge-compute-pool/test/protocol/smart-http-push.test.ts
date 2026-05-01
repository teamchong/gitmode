// Tests for the push side of smart HTTP (`git-receive-pack`).

import { describe, expect, it } from "vitest";
import { pushPack, NULL_SHA } from "../../src/protocol/smart-http";
import { encodePktLine, FLUSH_PKT, concat } from "../../src/protocol/pkt-line";

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);

function makeFetcher(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return handler(req);
  };
}

describe("pushPack", () => {
  it("sends ref updates + pack body to /git-receive-pack and parses ok response", async () => {
    let seenBody: Uint8Array | null = null;
    let seenContentType: string | null = null;

    const okResp = concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      FLUSH_PKT,
    ]);

    const fetcher = makeFetcher(async (req) => {
      seenBody = new Uint8Array(await req.arrayBuffer());
      seenContentType = req.headers.get("content-type");
      return new Response(okResp, { status: 200 });
    });

    const result = await pushPack({
      url: "https://example.com/git/repo.git",
      fetcher,
      refUpdates: [{ refName: "refs/heads/main", oldSha: SHA_OLD, newSha: SHA_NEW }],
      packData: new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0xff, 0xff]), // "PACK" + dummy
    });

    expect(result.unpackOk).toBe(true);
    expect(result.refResults).toEqual([{ ref: "refs/heads/main", ok: true }]);
    expect(seenContentType).toBe("application/x-git-receive-pack-request");

    // Verify body shape: first pkt-line carries oldSha newSha refName \0 caps
    const text = new TextDecoder().decode(seenBody!.subarray(0, 200));
    expect(text).toContain(`${SHA_OLD} ${SHA_NEW} refs/heads/main`);
    expect(text).toContain("report-status");
    // Pack body should follow the flush packet
    expect(seenBody!.length).toBeGreaterThan(50);
  });

  it("reports per-ref ng errors with their reason text", async () => {
    const ngResp = concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ng refs/heads/main fast-forward only\n"),
      FLUSH_PKT,
    ]);

    const fetcher = makeFetcher(() => new Response(ngResp));

    const result = await pushPack({
      url: "https://example.com/git/repo.git",
      fetcher,
      refUpdates: [{ refName: "refs/heads/main", oldSha: SHA_OLD, newSha: SHA_NEW }],
      packData: new Uint8Array(0),
    });

    expect(result.unpackOk).toBe(true);
    expect(result.refResults.length).toBe(1);
    expect(result.refResults[0]!.ok).toBe(false);
    expect(result.refResults[0]!.error).toBe("fast-forward only");
  });

  it("surfaces unpack-level errors", async () => {
    const errResp = concat([
      encodePktLine("unpack invalid pack\n"),
      FLUSH_PKT,
    ]);

    const fetcher = makeFetcher(() => new Response(errResp));

    const result = await pushPack({
      url: "https://example.com/git/repo.git",
      fetcher,
      refUpdates: [{ refName: "refs/heads/main", oldSha: SHA_OLD, newSha: SHA_NEW }],
      packData: new Uint8Array(0),
    });

    expect(result.unpackOk).toBe(false);
    expect(result.unpackError).toBe("invalid pack");
  });

  it("uses NULL_SHA for ref creation (oldSha) and deletion (newSha)", async () => {
    let seenBody: Uint8Array | null = null;
    const fetcher = makeFetcher(async (req) => {
      seenBody = new Uint8Array(await req.arrayBuffer());
      return new Response(concat([encodePktLine("unpack ok\n"), encodePktLine("ok refs/heads/new\n"), FLUSH_PKT]));
    });

    await pushPack({
      url: "https://example.com/git/repo.git",
      fetcher,
      refUpdates: [{ refName: "refs/heads/new", oldSha: NULL_SHA, newSha: SHA_NEW }],
      packData: new Uint8Array(0),
    });

    const text = new TextDecoder().decode(seenBody!);
    expect(text).toContain(`${NULL_SHA} ${SHA_NEW} refs/heads/new`);
  });

  it("rejects malformed sha", async () => {
    await expect(
      pushPack({
        url: "https://example.com/git/repo.git",
        fetcher: makeFetcher(() => new Response("")),
        refUpdates: [{ refName: "refs/heads/main", oldSha: "bad", newSha: SHA_NEW }],
        packData: new Uint8Array(0),
      }),
    ).rejects.toThrow(/invalid oldSha/);
  });

  it("rejects refName not starting with refs/", async () => {
    await expect(
      pushPack({
        url: "https://example.com/git/repo.git",
        fetcher: makeFetcher(() => new Response("")),
        refUpdates: [{ refName: "main", oldSha: SHA_OLD, newSha: SHA_NEW }],
        packData: new Uint8Array(0),
      }),
    ).rejects.toThrow(/refName must start with refs\//);
  });

  it("emits caps only on the first ref update", async () => {
    let seenBody: Uint8Array | null = null;
    const fetcher = makeFetcher(async (req) => {
      seenBody = new Uint8Array(await req.arrayBuffer());
      return new Response(concat([encodePktLine("unpack ok\n"), encodePktLine("ok refs/heads/a\n"), encodePktLine("ok refs/heads/b\n"), FLUSH_PKT]));
    });

    await pushPack({
      url: "https://example.com/git/repo.git",
      fetcher,
      refUpdates: [
        { refName: "refs/heads/a", oldSha: SHA_OLD, newSha: SHA_NEW },
        { refName: "refs/heads/b", oldSha: SHA_OLD, newSha: SHA_NEW },
      ],
      packData: new Uint8Array(0),
    });

    const text = new TextDecoder().decode(seenBody!);
    // report-status mentioned once (in caps after the first ref)
    expect(text.match(/report-status/g)?.length).toBe(1);
  });

  it("rejects empty refUpdates", async () => {
    await expect(
      pushPack({
        url: "https://example.com/git/repo.git",
        fetcher: makeFetcher(() => new Response("")),
        refUpdates: [],
        packData: new Uint8Array(0),
      }),
    ).rejects.toThrow(/at least one refUpdate/);
  });
});
