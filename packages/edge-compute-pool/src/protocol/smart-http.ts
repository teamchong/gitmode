// Git smart HTTP client (protocols v1 and v2).
//
// V1 endpoints:
//   GET  <url>/info/refs?service=git-upload-pack
//        → pkt-line ref advertisement + capabilities (refs and caps in one shot)
//   POST <url>/git-upload-pack
//        body: pkt-line "want <sha>" lines + flush + "done"
//        → NAK + sideband-multiplexed packfile
//
// V2 endpoints (negotiated via `Git-Protocol: version=2` header):
//   GET  <url>/info/refs?service=git-upload-pack
//        → pkt-line capability advertisement only (no refs)
//   POST <url>/git-upload-pack
//        body: command=ls-refs<delim>… or command=fetch<delim>want… <flush>
//        → command-specific response
//
// `discoverRefs` and `fetchPack` auto-negotiate: they try v2 first if the
// caller passes `protocolVersion: "auto"` (default) or explicitly via
// `protocolVersion: "v2"`, falling back to v1 when the server doesn't
// advertise v2 capability.

import { encodePktLine, parsePktLines, FLUSH_PKT, DELIM_PKT, concat } from "./pkt-line";

const decoder = new TextDecoder();

export type ProtocolVersion = "auto" | "v1" | "v2";

export interface SmartHttpOptions {
  /** Base repo URL — e.g. "https://x.artifacts.cloudflare.net/git/repo.git". */
  url: string;
  /** Bearer / basic-auth token; sent as `Authorization: Basic x:<token>` to match Git's HTTP auth convention. */
  token?: string;
  /** Override fetch (for tests). Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Extra request headers (e.g. user-agent). */
  headers?: Record<string, string>;
  /** "auto" tries v2 then falls back to v1 (default). "v1"/"v2" force one path. */
  protocolVersion?: ProtocolVersion;
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
 * Auto-negotiates between v1 and v2 based on `protocolVersion`:
 *   - "auto" / "v2": sends `Git-Protocol: version=2`. If the server
 *     responds with a v2 capability list, follows up with a v2 ls-refs
 *     POST. Falls back to v1 parsing if the response is v1-shaped.
 *   - "v1": skips the v2 header entirely and parses the response as v1.
 */
export async function discoverRefs(opts: SmartHttpOptions): Promise<RefAdvertisement> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const requestVersion = opts.protocolVersion ?? "auto";
  const url = `${opts.url.replace(/\/$/, "")}/info/refs?service=git-upload-pack`;

  const reqHeaders: Record<string, string> = {
    Accept: "application/x-git-upload-pack-advertisement",
    ...(opts.headers ?? {}),
  };
  if (requestVersion === "auto" || requestVersion === "v2") {
    reqHeaders["Git-Protocol"] = "version=2";
  }

  const res = await fetcher(url, {
    method: "GET",
    headers: withAuth(reqHeaders, opts.token),
  });

  if (!res.ok) {
    throw new Error(`info/refs returned ${res.status} ${res.statusText}`);
  }

  const body = new Uint8Array(await res.arrayBuffer());
  const sections = parsePktLines(body);

  // Detect v2: the first non-empty section's first line is `version 2\n`.
  const firstNonEmpty = sections.find((s) => s.length > 0);
  if (firstNonEmpty && firstNonEmpty.length > 0) {
    const firstText = decoder.decode(firstNonEmpty[0]!).replace(/\n$/, "");
    if (firstText === "version 2") {
      const v2Caps = parseV2Capabilities(firstNonEmpty);
      if (requestVersion !== "v1") {
        // Issue ls-refs to actually fetch refs. Without it, v2 only gave us caps.
        return await lsRefsV2(opts, v2Caps);
      }
    }
  }

  return parseV1RefAdvertisement(sections);
}

function parseV1RefAdvertisement(sections: Uint8Array[][]): RefAdvertisement {
  // V1: first section is service header; second is the ref advertisement.
  const refSection = sections.length >= 2 && sections[1]!.length > 0 ? sections[1]! : sections[0]!;

  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  let head: string | undefined;
  let firstLine = true;

  for (const line of refSection) {
    let text = decoder.decode(line);
    if (text.endsWith("\n")) text = text.slice(0, -1);

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

interface V2Capabilities {
  /** Capabilities advertised by the server (e.g. "ls-refs", "fetch=shallow filter"). */
  caps: Set<string>;
  /** Per-capability arguments string when the cap takes args ("fetch=shallow filter" → ["shallow", "filter"]). */
  capArgs: Map<string, string[]>;
}

function parseV2Capabilities(lines: Uint8Array[]): V2Capabilities {
  const caps = new Set<string>();
  const capArgs = new Map<string, string[]>();
  for (const raw of lines) {
    let text = decoder.decode(raw).replace(/\n$/, "");
    if (text.length === 0) continue;
    const eqIdx = text.indexOf("=");
    if (eqIdx === -1) {
      caps.add(text);
    } else {
      const name = text.slice(0, eqIdx);
      caps.add(name);
      capArgs.set(name, text.slice(eqIdx + 1).split(" ").filter(Boolean));
    }
  }
  return { caps, capArgs };
}

/**
 * V2 ls-refs command. POST git-upload-pack with a body containing
 * `command=ls-refs\n` plus `peel`, `symrefs`, and ref-prefix args.
 */
async function lsRefsV2(
  opts: SmartHttpOptions,
  v2: V2Capabilities,
): Promise<RefAdvertisement> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const lines: Uint8Array[] = [
    encodePktLine("command=ls-refs\n"),
    encodePktLine("agent=gitmode-edge-compute\n"),
    encodePktLine("object-format=sha1\n"),
    DELIM_PKT,
    encodePktLine("peel\n"),
    encodePktLine("symrefs\n"),
    encodePktLine("ref-prefix HEAD\n"),
    encodePktLine("ref-prefix refs/heads/\n"),
    encodePktLine("ref-prefix refs/tags/\n"),
    FLUSH_PKT,
  ];
  const body = concat(lines);

  const url = `${opts.url.replace(/\/$/, "")}/git-upload-pack`;
  const res = await fetcher(url, {
    method: "POST",
    headers: withAuth(
      {
        "Content-Type": "application/x-git-upload-pack-request",
        Accept: "application/x-git-upload-pack-result",
        "Git-Protocol": "version=2",
        ...(opts.headers ?? {}),
      },
      opts.token,
    ),
    body,
  });

  if (!res.ok) {
    throw new Error(`v2 ls-refs returned ${res.status} ${res.statusText}`);
  }

  const respBody = new Uint8Array(await res.arrayBuffer());
  const sections = parsePktLines(respBody);
  const refLines = sections.find((s) => s.length > 0) ?? [];

  const refs = new Map<string, string>();
  let head: string | undefined;

  for (const raw of refLines) {
    const text = decoder.decode(raw).replace(/\n$/, "");
    // Format: "<sha> <ref> [attribute1 attribute2 ...]"
    // Attributes include "symref-target:<target>" and "peeled:<sha>".
    const parts = text.split(" ");
    if (parts.length < 2) continue;
    const sha = parts[0]!;
    const refName = parts[1]!;
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    if (refName === "HEAD") head = sha;
    refs.set(refName, sha);
  }

  return { refs, capabilities: v2.caps, head };
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
  for (const sha of opts.wants) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`fetchPack: invalid sha ${sha}`);
  }

  const requestVersion = opts.protocolVersion ?? "auto";
  if (requestVersion === "v2") {
    return fetchPackV2(opts);
  }

  // V1 (default for "auto" since most servers still accept it; callers who
  // want v2 should pass protocolVersion: "v2" explicitly).
  const caps = opts.capabilities ?? ["side-band-64k", "agent=gitmode-edge-compute"];

  const lines: Uint8Array[] = [];
  for (let i = 0; i < opts.wants.length; i++) {
    const sha = opts.wants[i]!;
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
 * V2 fetch command. POST git-upload-pack with `command=fetch` body and
 * Git-Protocol: version=2 header. Response framing: `packfile\n` line
 * followed by sideband-multiplexed packfile data, terminated by flush.
 */
async function fetchPackV2(opts: FetchPackOptions): Promise<FetchPackResult> {
  const fetcher = opts.fetcher ?? globalThis.fetch;

  const lines: Uint8Array[] = [
    encodePktLine("command=fetch\n"),
    encodePktLine("agent=gitmode-edge-compute\n"),
    encodePktLine("object-format=sha1\n"),
    DELIM_PKT,
    encodePktLine("ofs-delta\n"),
    // V2 fetch uses sideband-all by default; no need to opt in via capability.
  ];
  for (const sha of opts.wants) {
    lines.push(encodePktLine(`want ${sha}\n`));
  }
  lines.push(encodePktLine("done\n"));
  lines.push(FLUSH_PKT);

  const body = concat(lines);
  const url = `${opts.url.replace(/\/$/, "")}/git-upload-pack`;

  const res = await fetcher(url, {
    method: "POST",
    headers: withAuth(
      {
        "Content-Type": "application/x-git-upload-pack-request",
        Accept: "application/x-git-upload-pack-result",
        "Git-Protocol": "version=2",
        ...(opts.headers ?? {}),
      },
      opts.token,
    ),
    body,
  });

  if (!res.ok) {
    throw new Error(`v2 fetch returned ${res.status} ${res.statusText}`);
  }

  const responseBody = new Uint8Array(await res.arrayBuffer());
  return demuxSidebandV2(responseBody);
}

/**
 * V2 fetch response demux. The body starts with a `packfile\n` indicator line
 * (or potentially `acknowledgments\n` / `shallow-info\n` sections we skip),
 * then sideband-multiplexed pack data: 0x01 = pack, 0x02 = progress, 0x03 = error.
 */
function demuxSidebandV2(body: Uint8Array): FetchPackResult {
  const packChunks: Uint8Array[] = [];
  let progress = "";
  let errors = "";

  let offset = 0;
  let inPackfileSection = false;

  while (offset < body.length) {
    if (offset + 4 > body.length) break;
    const lenHex = decoder.decode(body.subarray(offset, offset + 4));
    if (lenHex === "0000") {
      offset += 4;
      // Section terminator. If we were in the packfile section, we're done.
      if (inPackfileSection) break;
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

    if (!inPackfileSection) {
      const text = decoder.decode(payload).replace(/\n$/, "");
      if (text === "packfile") {
        inPackfileSection = true;
      }
      // Other section headers (acknowledgments, shallow-info) — ignored.
      continue;
    }

    // In the packfile section, every data line is sideband-channel-prefixed.
    const channel = payload[0];
    const data = payload.subarray(1);
    if (channel === 1) packChunks.push(data);
    else if (channel === 2) progress += decoder.decode(data);
    else if (channel === 3) errors += decoder.decode(data);
  }

  return { pack: concat(packChunks), progress, errors };
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
