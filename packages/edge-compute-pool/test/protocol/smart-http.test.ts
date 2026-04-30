// Tests for the Git smart HTTP v1 client. Uses an in-memory fetcher to
// hand-craft pkt-line responses without hitting a real Git server.

import { describe, expect, it } from "vitest";
import { discoverRefs, fetchPack } from "../../src/protocol/smart-http";
import { encodePktLine, encodePktLineBytes, FLUSH_PKT, concat } from "../../src/protocol/pkt-line";

const SHA_HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const SHA_MAIN = SHA_HEAD;
const SHA_DEV = "1234567890abcdef1234567890abcdef12345678";

function makeFetcher(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return handler(req);
  };
}

describe("discoverRefs", () => {
  it("parses ref advertisement with HEAD + capabilities", async () => {
    // Service header section
    const serviceHeader = encodePktLine("# service=git-upload-pack\n");
    // Ref advertisement section: first line carries caps after \0
    const firstLine = encodePktLine(
      `${SHA_HEAD} HEAD\0multi_ack thin-pack side-band-64k agent=git/1.0\n`,
    );
    const mainLine = encodePktLine(`${SHA_MAIN} refs/heads/main\n`);
    const devLine = encodePktLine(`${SHA_DEV} refs/heads/dev\n`);
    const body = concat([
      serviceHeader,
      FLUSH_PKT,
      firstLine,
      mainLine,
      devLine,
      FLUSH_PKT,
    ]);

    const fetcher = makeFetcher(() => new Response(body, { status: 200 }));

    const adv = await discoverRefs({
      url: "https://example.com/git/repo.git",
      fetcher,
    });

    expect(adv.head).toBe(SHA_HEAD);
    expect(adv.refs.get("HEAD")).toBe(SHA_HEAD);
    expect(adv.refs.get("refs/heads/main")).toBe(SHA_MAIN);
    expect(adv.refs.get("refs/heads/dev")).toBe(SHA_DEV);
    expect(adv.capabilities.has("side-band-64k")).toBe(true);
    expect(adv.capabilities.has("multi_ack")).toBe(true);
  });

  it("sends Authorization header when token provided", async () => {
    let seenAuth: string | null = null;
    const fetcher = makeFetcher((req) => {
      seenAuth = req.headers.get("authorization");
      return new Response(
        concat([
          encodePktLine("# service=git-upload-pack\n"),
          FLUSH_PKT,
          encodePktLine(`${SHA_HEAD} HEAD\0\n`),
          FLUSH_PKT,
        ]),
      );
    });

    await discoverRefs({
      url: "https://x.artifacts.cloudflare.net/git/repo-1.git",
      token: "test-token-123",
      fetcher,
    });

    expect(seenAuth).toMatch(/^Basic /);
    // Decode and verify it's "x:test-token-123"
    const b64 = seenAuth!.slice("Basic ".length);
    const decoded = Buffer.from(b64, "base64").toString();
    expect(decoded).toBe("x:test-token-123");
  });

  it("throws on non-2xx response", async () => {
    const fetcher = makeFetcher(
      () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      discoverRefs({ url: "https://example.com/git/repo.git", fetcher }),
    ).rejects.toThrow(/info\/refs returned 403/);
  });

  it("makes the correct GET request URL", async () => {
    let seenUrl: string | null = null;
    const fetcher = makeFetcher((req) => {
      seenUrl = req.url;
      return new Response(
        concat([
          encodePktLine("# service=git-upload-pack\n"),
          FLUSH_PKT,
          encodePktLine(`${SHA_HEAD} HEAD\0\n`),
          FLUSH_PKT,
        ]),
      );
    });

    await discoverRefs({ url: "https://example.com/git/repo.git/", fetcher });
    expect(seenUrl).toBe("https://example.com/git/repo.git/info/refs?service=git-upload-pack");
  });
});

describe("fetchPack", () => {
  it("sends correct want/done pkt-lines and returns demuxed pack", async () => {
    let seenBody: Uint8Array | null = null;

    const fakePack = new TextEncoder().encode("PACKv2-fake-pack-bytes");
    const ackLine = encodePktLine("NAK\n");
    // Sideband channel 1 = pack data
    const sidebandData = new Uint8Array(1 + fakePack.length);
    sidebandData[0] = 0x01;
    sidebandData.set(fakePack, 1);
    const dataLine = encodePktLineBytes(sidebandData);
    // Channel 2 = progress
    const progressData = new Uint8Array([0x02, ...new TextEncoder().encode("counting objects: 1")]);
    const progLine = encodePktLineBytes(progressData);

    const responseBody = concat([ackLine, dataLine, progLine, FLUSH_PKT]);

    const fetcher = makeFetcher(async (req) => {
      seenBody = new Uint8Array(await req.arrayBuffer());
      return new Response(responseBody);
    });

    const result = await fetchPack({
      url: "https://example.com/git/repo.git",
      wants: [SHA_HEAD],
      fetcher,
    });

    // Verify request body shape
    expect(seenBody).not.toBeNull();
    const reqText = new TextDecoder().decode(seenBody!);
    expect(reqText).toContain(`want ${SHA_HEAD}`);
    expect(reqText).toContain("side-band-64k");
    expect(reqText).toContain("done");

    // Verify response demux
    expect(new TextDecoder().decode(result.pack)).toBe("PACKv2-fake-pack-bytes");
    expect(result.progress).toBe("counting objects: 1");
    expect(result.errors).toBe("");
  });

  it("emits error channel separately", async () => {
    const errMsg = "remote: object not found";
    const errLine = encodePktLineBytes(
      concat([new Uint8Array([0x03]), new TextEncoder().encode(errMsg)]),
    );
    const responseBody = concat([encodePktLine("NAK\n"), errLine, FLUSH_PKT]);

    const fetcher = makeFetcher(() => new Response(responseBody));

    const result = await fetchPack({
      url: "https://example.com/git/repo.git",
      wants: [SHA_HEAD],
      fetcher,
    });

    expect(result.errors).toBe(errMsg);
    expect(result.pack.length).toBe(0);
  });

  it("rejects empty wants", async () => {
    await expect(
      fetchPack({
        url: "https://example.com/git/repo.git",
        wants: [],
        fetcher: makeFetcher(() => new Response("")),
      }),
    ).rejects.toThrow(/at least one want/);
  });

  it("rejects malformed sha", async () => {
    await expect(
      fetchPack({
        url: "https://example.com/git/repo.git",
        wants: ["not-a-sha"],
        fetcher: makeFetcher(() => new Response("")),
      }),
    ).rejects.toThrow(/invalid sha/);
  });

  it("includes only the first want's capabilities (subsequent wants are bare)", async () => {
    let seenBody: Uint8Array | null = null;
    const fetcher = makeFetcher(async (req) => {
      seenBody = new Uint8Array(await req.arrayBuffer());
      return new Response(concat([encodePktLine("NAK\n"), FLUSH_PKT]));
    });

    await fetchPack({
      url: "https://example.com/git/repo.git",
      wants: [SHA_HEAD, SHA_DEV],
      fetcher,
    });

    const text = new TextDecoder().decode(seenBody!);
    // First want has caps, second doesn't
    expect(text.match(/want \w{40} side-band-64k/g)?.length ?? 0).toBe(1);
    expect(text.match(/want \w{40}/g)?.length ?? 0).toBe(2);
  });
});

describe("Git protocol v2", () => {
  it("auto-detects v2 from info/refs, then issues ls-refs to get the actual refs", async () => {
    let infoRefsCalled = false;
    let lsRefsBody: Uint8Array | null = null;
    let sentVersionHeader: string | null = null;

    const fetcher = makeFetcher(async (req) => {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
        infoRefsCalled = true;
        sentVersionHeader = req.headers.get("git-protocol");
        // V2 capability advertisement: just the capabilities, no refs.
        return new Response(
          concat([
            encodePktLine("version 2\n"),
            encodePktLine("agent=git/2.42\n"),
            encodePktLine("ls-refs=unborn\n"),
            encodePktLine("fetch=shallow filter\n"),
            encodePktLine("object-format=sha1\n"),
            FLUSH_PKT,
          ]),
        );
      }

      if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
        lsRefsBody = new Uint8Array(await req.arrayBuffer());
        // V2 ls-refs response: ref lines + flush
        return new Response(
          concat([
            encodePktLine(`${SHA_HEAD} HEAD symref-target:refs/heads/main\n`),
            encodePktLine(`${SHA_MAIN} refs/heads/main\n`),
            encodePktLine(`${SHA_DEV} refs/heads/dev\n`),
            FLUSH_PKT,
          ]),
        );
      }

      return new Response("not found", { status: 404 });
    });

    const adv = await discoverRefs({
      url: "https://example.com/git/repo.git",
      fetcher,
    });

    expect(infoRefsCalled).toBe(true);
    expect(sentVersionHeader).toBe("version=2");
    expect(adv.head).toBe(SHA_HEAD);
    expect(adv.refs.get("refs/heads/main")).toBe(SHA_MAIN);
    expect(adv.refs.get("refs/heads/dev")).toBe(SHA_DEV);
    expect(adv.capabilities.has("ls-refs")).toBe(true);
    expect(adv.capabilities.has("fetch")).toBe(true);

    // Verify the ls-refs request body shape
    expect(lsRefsBody).not.toBeNull();
    const lsRefsText = new TextDecoder().decode(lsRefsBody!);
    expect(lsRefsText).toContain("command=ls-refs");
    expect(lsRefsText).toContain("ref-prefix HEAD");
    expect(lsRefsText).toContain("ref-prefix refs/heads/");
  });

  it("falls back to v1 when the server doesn't advertise version 2", async () => {
    const fetcher = makeFetcher((req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
        // Plain v1 advertisement — no `version 2` line
        return new Response(
          concat([
            encodePktLine("# service=git-upload-pack\n"),
            FLUSH_PKT,
            encodePktLine(`${SHA_HEAD} HEAD\0multi_ack side-band-64k\n`),
            encodePktLine(`${SHA_MAIN} refs/heads/main\n`),
            FLUSH_PKT,
          ]),
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adv = await discoverRefs({
      url: "https://example.com/git/repo.git",
      fetcher,
    });

    expect(adv.head).toBe(SHA_HEAD);
    expect(adv.refs.get("refs/heads/main")).toBe(SHA_MAIN);
    expect(adv.capabilities.has("multi_ack")).toBe(true);
  });

  it("respects protocolVersion: 'v1' (skips v2 negotiation entirely)", async () => {
    let sentVersionHeader: string | null = null;
    const fetcher = makeFetcher((req) => {
      sentVersionHeader = req.headers.get("git-protocol");
      return new Response(
        concat([
          encodePktLine("# service=git-upload-pack\n"),
          FLUSH_PKT,
          encodePktLine(`${SHA_HEAD} HEAD\0\n`),
          FLUSH_PKT,
        ]),
      );
    });

    await discoverRefs({
      url: "https://example.com/git/repo.git",
      fetcher,
      protocolVersion: "v1",
    });

    expect(sentVersionHeader).toBeNull();
  });

  it("v2 fetch sends `command=fetch` body with want lines + Git-Protocol header", async () => {
    let seenBody: Uint8Array | null = null;
    let sentVersionHeader: string | null = null;

    const fakePack = new TextEncoder().encode("PACK-fake-v2");
    const sideband = new Uint8Array(1 + fakePack.length);
    sideband[0] = 0x01;
    sideband.set(fakePack, 1);

    const fetcher = makeFetcher(async (req) => {
      seenBody = new Uint8Array(await req.arrayBuffer());
      sentVersionHeader = req.headers.get("git-protocol");
      return new Response(
        concat([
          encodePktLine("packfile\n"),
          encodePktLineBytes(sideband),
          FLUSH_PKT,
        ]),
      );
    });

    const result = await fetchPack({
      url: "https://example.com/git/repo.git",
      wants: [SHA_HEAD],
      fetcher,
      protocolVersion: "v2",
    });

    expect(sentVersionHeader).toBe("version=2");
    expect(seenBody).not.toBeNull();
    const text = new TextDecoder().decode(seenBody!);
    expect(text).toContain("command=fetch");
    expect(text).toContain(`want ${SHA_HEAD}`);
    expect(text).toContain("done");

    // Verify pack got demuxed correctly through the v2 packfile section
    expect(new TextDecoder().decode(result.pack)).toBe("PACK-fake-v2");
  });

  it("v2 fetch separates progress and error sideband channels", async () => {
    const errMsg = "remote: cannot find object\n";
    const errPayload = new Uint8Array(1 + new TextEncoder().encode(errMsg).length);
    errPayload[0] = 0x03;
    errPayload.set(new TextEncoder().encode(errMsg), 1);

    const progMsg = "counting objects: 12";
    const progPayload = new Uint8Array(1 + new TextEncoder().encode(progMsg).length);
    progPayload[0] = 0x02;
    progPayload.set(new TextEncoder().encode(progMsg), 1);

    const fetcher = makeFetcher(() =>
      new Response(
        concat([
          encodePktLine("packfile\n"),
          encodePktLineBytes(progPayload),
          encodePktLineBytes(errPayload),
          FLUSH_PKT,
        ]),
      ),
    );

    const result = await fetchPack({
      url: "https://example.com/git/repo.git",
      wants: [SHA_HEAD],
      fetcher,
      protocolVersion: "v2",
    });

    expect(result.progress).toBe(progMsg);
    expect(result.errors).toBe(errMsg);
    expect(result.pack.length).toBe(0);
  });
});
