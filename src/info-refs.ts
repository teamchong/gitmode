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

const CAPABILITIES = [
  "report-status",
  "multi_ack_detailed",
  "side-band-64k",
  "thin-pack",
  "ofs-delta",
  "agent=gitmode/1.0",
  "symref=HEAD:refs/heads/main",
  "object-format=sha1",
].join(" ");

export async function handleInfoRefs(
  engine: GitEngine,
  service: string
): Promise<Response> {
  const refs = await engine.listRefs();
  const head = await engine.getHead();

  const lines: Uint8Array[] = [];

  // Service announcement
  lines.push(encodePktLine(`# service=${service}\n`));
  lines.push(FLUSH_PKT);

  if (refs.size === 0) {
    // Empty repo — advertise zero-id with capabilities
    const zeroId = "0".repeat(40);
    lines.push(
      encodePktLine(`${zeroId} capabilities^{}\0${CAPABILITIES}\n`)
    );
  } else {
    let first = true;

    // HEAD first
    if (head) {
      const headSha = await engine.getRef(head.replace("ref: ", ""));
      if (headSha) {
        const suffix = first ? `\0${CAPABILITIES}` : "";
        lines.push(encodePktLine(`${headSha} HEAD${suffix}\n`));
        first = false;
      }
    }

    // All refs sorted
    const sortedRefs = [...refs.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    for (const [refname, sha1] of sortedRefs) {
      const suffix = first ? `\0${CAPABILITIES}` : "";
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
