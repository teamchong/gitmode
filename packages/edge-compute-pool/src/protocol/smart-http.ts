// Git smart HTTP client (protocol v1).
//
// Two endpoints on a Git server:
//   GET  <url>/info/refs?service=git-upload-pack
//        → pkt-line-encoded ref advertisement + capabilities
//   POST <url>/git-upload-pack
//        body: pkt-line-encoded "want <sha>" lines + flush + "done"
//        → NAK + packfile (optionally sideband-64k multiplexed)
//
// Used by Artifacts integration to discover refs and fetch object closures.

import { encodePktLine, parsePktLines, FLUSH_PKT, concat } from "./pkt-line";

const decoder = new TextDecoder();

export interface SmartHttpOptions {
  /** Base repo URL — e.g. "https://x.artifacts.cloudflare.net/git/repo.git". */
  url: string;
  /** Bearer / basic-auth token; sent as `Authorization: Basic x:<token>` to match Git's HTTP auth convention. */
  token?: string;
  /** Override fetch (for tests). Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Extra request headers (e.g. user-agent). */
  headers?: Record<string, string>;
}

export interface RefAdvertisement {
  /** Map from ref name (e.g. `refs/heads/main`) to commit SHA. */
  refs: Map<string, string>;
  /** Capabilities advertised by the server (parsed from the first line). */
  capabilities: Set<string>;
  /** SHA pointed at by HEAD, if advertised. */
  head?: string;
}

function authHeader(token?: string): string | undefined {
  if (!token) return undefined;
  // Git's convention is `Basic <base64('x:<token>')>`. Workers nodejs_compat
  // gives us Buffer for base64 encoding.
  const credentials = Buffer.from(`x:${token}`).toString("base64");
  return `Basic ${credentials}`;
}

function withAuth(headers: Record<string, string>, token?: string): Record<string, string> {
  const auth = authHeader(token);
  return auth ? { ...headers, Authorization: auth } : headers;
}

/**
 * GET /info/refs?service=git-upload-pack — returns the ref advertisement.
 *
 * Parses the v1 protocol response:
 *   001e# service=git-upload-pack\n
 *   0000  (flush — end of service header)
 *   <sha> HEAD\0<capabilities>\n
 *   <sha> refs/heads/main\n
 *   ...
 *   0000  (flush)
 */
export async function discoverRefs(opts: SmartHttpOptions): Promise<RefAdvertisement> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const url = `${opts.url.replace(/\/$/, "")}/info/refs?service=git-upload-pack`;

  const res = await fetcher(url, {
    method: "GET",
    headers: withAuth(
      {
        Accept: "application/x-git-upload-pack-advertisement",
        ...(opts.headers ?? {}),
      },
      opts.token,
    ),
  });

  if (!res.ok) {
    throw new Error(`info/refs returned ${res.status} ${res.statusText}`);
  }

  const body = new Uint8Array(await res.arrayBuffer());
  const sections = parsePktLines(body);

  // V1 layout: first section is the service header (`# service=git-upload-pack`),
  // second section is the actual ref advertisement.
  const refSection = sections.length >= 2 && sections[1]!.length > 0 ? sections[1]! : sections[0]!;

  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  let head: string | undefined;
  let firstLine = true;

  for (const line of refSection) {
    let text = decoder.decode(line);
    if (text.endsWith("\n")) text = text.slice(0, -1);

    // First line carries capabilities after a NUL byte: "<sha> <ref>\0<caps>"
    let capsPart: string | undefined;
    if (firstLine) {
      firstLine = false;
      const nulIdx = text.indexOf("\0");
      if (nulIdx !== -1) {
        capsPart = text.slice(nulIdx + 1);
        text = text.slice(0, nulIdx);
      }
    }

    const spaceIdx = text.indexOf(" ");
    if (spaceIdx === -1) continue;
    const sha = text.slice(0, spaceIdx);
    const refName = text.slice(spaceIdx + 1);

    if (!/^[0-9a-f]{40}$/.test(sha)) continue;

    if (refName === "HEAD") head = sha;
    refs.set(refName, sha);

    if (capsPart) {
      for (const cap of capsPart.split(" ")) {
        if (cap) capabilities.add(cap);
      }
    }
  }

  return { refs, capabilities, head };
}

export interface FetchPackOptions extends SmartHttpOptions {
  /** Commit / tag SHAs to fetch. */
  wants: string[];
  /** Capabilities to request alongside the first `want`. Default includes `side-band-64k` and `agent`. */
  capabilities?: string[];
}

/**
 * POST /git-upload-pack — request a packfile containing the given wants.
 *
 * Returns the raw packfile bytes (sideband channel 1 only — progress and
 * error channels are surfaced via the second/third returned values).
 */
export interface FetchPackResult {
  /** Concatenated packfile bytes from sideband channel 1. */
  pack: Uint8Array;
  /** Concatenated progress messages from sideband channel 2. */
  progress: string;
  /** Concatenated error messages from sideband channel 3. */
  errors: string;
}

export async function fetchPack(opts: FetchPackOptions): Promise<FetchPackResult> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  if (opts.wants.length === 0) throw new Error("fetchPack: at least one want SHA required");

  const caps = opts.capabilities ?? ["side-band-64k", "agent=gitmode-edge-compute"];

  const lines: Uint8Array[] = [];
  for (let i = 0; i < opts.wants.length; i++) {
    const sha = opts.wants[i]!;
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`fetchPack: invalid sha ${sha}`);
    const wantLine = i === 0 ? `want ${sha} ${caps.join(" ")}\n` : `want ${sha}\n`;
    lines.push(encodePktLine(wantLine));
  }
  lines.push(FLUSH_PKT);
  lines.push(encodePktLine("done\n"));

  const body = concat(lines);
  const url = `${opts.url.replace(/\/$/, "")}/git-upload-pack`;

  const res = await fetcher(url, {
    method: "POST",
    headers: withAuth(
      {
        "Content-Type": "application/x-git-upload-pack-request",
        Accept: "application/x-git-upload-pack-result",
        ...(opts.headers ?? {}),
      },
      opts.token,
    ),
    body,
  });

  if (!res.ok) {
    throw new Error(`git-upload-pack returned ${res.status} ${res.statusText}`);
  }

  const responseBody = new Uint8Array(await res.arrayBuffer());
  return demuxSideband(responseBody, caps.includes("side-band-64k"));
}

/**
 * Demultiplex a git-upload-pack response. The body is a sequence of pkt-lines:
 *   - First (and possibly more) data lines: ack/nak protocol exchange
 *   - Followed by sideband-multiplexed packfile data, where each data line's
 *     first byte indicates the channel:
 *       0x01 = pack data
 *       0x02 = progress (UTF-8 text)
 *       0x03 = error (UTF-8 text)
 *   - Terminated by a flush packet.
 */
function demuxSideband(body: Uint8Array, sidebandEnabled: boolean): FetchPackResult {
  const packChunks: Uint8Array[] = [];
  let progress = "";
  let errors = "";

  let offset = 0;
  let seenAckNak = false;

  while (offset < body.length) {
    if (offset + 4 > body.length) break;
    const lenHex = decoder.decode(body.subarray(offset, offset + 4));
    if (lenHex === "0000") {
      offset += 4;
      continue;
    }
    if (lenHex === "0001" || lenHex === "0002") {
      offset += 4;
      continue;
    }
    const totalLen = parseInt(lenHex, 16);
    if (isNaN(totalLen) || totalLen < 4) break;
    if (offset + totalLen > body.length) break;

    const payload = body.subarray(offset + 4, offset + totalLen);
    offset += totalLen;

    if (!seenAckNak) {
      // First data line should be an ACK or NAK exchange. Skip it.
      const text = decoder.decode(payload);
      if (text.startsWith("ACK") || text.startsWith("NAK")) {
        seenAckNak = true;
        continue;
      }
      // Some servers omit the NAK exchange and stream directly into sideband.
      seenAckNak = true;
    }

    if (sidebandEnabled) {
      const channel = payload[0];
      const data = payload.subarray(1);
      if (channel === 1) packChunks.push(data);
      else if (channel === 2) progress += decoder.decode(data);
      else if (channel === 3) errors += decoder.decode(data);
    } else {
      packChunks.push(payload);
    }
  }

  return { pack: concat(packChunks), progress, errors };
}
