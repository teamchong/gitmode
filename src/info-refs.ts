// GET /info/refs?service=git-upload-pack|git-receive-pack
//
// Returns ref advertisement in pkt-line format:
//   pkt-line("# service=git-upload-pack\n")
//   flush
//   pkt-line("<sha1> HEAD\0<capabilities>\n")
//   pkt-line("<sha1> refs/heads/main\n")
//   ...
//   flush

import type { GitEngine } from "./git-engine";
import { encodePktLine, FLUSH_PKT } from "./pkt-line";

const BASE_CAPABILITIES = [
  "report-status",
  "delete-refs",
  "multi_ack_detailed",
  "side-band-64k",
  "thin-pack",
  "ofs-delta",
  "agent=gitmode/1.0",
  "object-format=sha1",
];

export async function handleInfoRefs(
  engine: GitEngine,
  service: string
): Promise<Response> {
  const refs = engine.listRefs();
  const head = engine.getHead() ?? "ref: refs/heads/main";

  // Build capabilities with actual symref
  const symrefTarget = head.startsWith("ref: ") ? head.slice(5) : "refs/heads/main";
  const capabilities = [...BASE_CAPABILITIES, `symref=HEAD:${symrefTarget}`].join(" ");

  const lines: Uint8Array[] = [];

  // Service announcement
  lines.push(encodePktLine(`# service=${service}\n`));
  lines.push(FLUSH_PKT);

  if (refs.size === 0) {
    // Empty repo — advertise zero-id with capabilities
    const zeroId = "0".repeat(40);
    lines.push(
      encodePktLine(`${zeroId} capabilities^{}\0${capabilities}\n`)
    );
  } else {
    let first = true;

    // HEAD first
    if (head) {
      const headRef = head.replace("ref: ", "").replace(/^refs\//, "");
      const headSha = engine.getRef(headRef);
      if (headSha) {
        const suffix = first ? `\0${capabilities}` : "";
        lines.push(encodePktLine(`${headSha} HEAD${suffix}\n`));
        first = false;
      }
    }

    // All refs sorted
    const sortedRefs = [...refs.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    for (const [refname, sha1] of sortedRefs) {
      const suffix = first ? `\0${capabilities}` : "";
      lines.push(encodePktLine(`${sha1} refs/${refname}${suffix}\n`));
      first = false;
    }
  }

  lines.push(FLUSH_PKT);

  // Concatenate all lines
  const totalLen = lines.reduce((acc, l) => acc + l.length, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const line of lines) {
    body.set(line, offset);
    offset += line.length;
  }

  return new Response(body, {
    headers: {
      "Content-Type": `application/x-${service}-advertisement`,
      "Cache-Control": "no-cache",
    },
  });
}
