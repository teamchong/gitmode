// Tree object format: pure-data encode/decode + mutation primitives.
//
// On-disk layout per entry:
//   <mode> <name>\0<sha-binary-20-bytes>
//
// Entries are sorted by name in a specific way: directories sort as if
// they had a trailing "/". Concretely, when comparing two names, treat
// a directory entry as `name + "/"` for the comparison only. Plain
// lexicographic sort is correct when no name conflicts exist between
// a file and a directory (which is true for our writes since git itself
// rejects such trees).

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface TreeEntry {
  mode: string; // "100644", "100755", "040000", "120000", "160000"
  name: string;
  sha: string; // 40-hex
}

const DIR_MODE = "040000";

function shaToBytes(sha: string): Uint8Array {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid sha: ${sha}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = parseInt(sha.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

/** Parse a tree object's body (no `tree <size>\0` header). */
export function parseTreeBytes(body: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < body.length) {
    const spaceIdx = body.indexOf(0x20, pos);
    if (spaceIdx === -1) break;
    const nullIdx = body.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) break;
    const mode = decoder.decode(body.subarray(pos, spaceIdx));
    const name = decoder.decode(body.subarray(spaceIdx + 1, nullIdx));
    const sha = bytesToHex(body.subarray(nullIdx + 1, nullIdx + 21));
    out.push({ mode, name, sha });
    pos = nullIdx + 21;
  }
  return out;
}

function entrySortKey(e: TreeEntry): string {
  // Git's sort treats directories as if they had a "/" suffix.
  return e.mode === DIR_MODE ? e.name + "/" : e.name;
}

/** Encode a list of entries as a tree object body. Sorts in git's canonical order. */
export function encodeTreeBytes(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    const ka = entrySortKey(a);
    const kb = entrySortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const e of sorted) {
    const head = encoder.encode(`${e.mode} ${e.name}\0`);
    parts.push(head);
    parts.push(shaToBytes(e.sha));
    total += head.length + 20;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Replace or add an entry, returning a new entries list (caller re-encodes). */
export function withEntry(entries: TreeEntry[], replacement: TreeEntry): TreeEntry[] {
  const out = entries.filter((e) => e.name !== replacement.name);
  out.push(replacement);
  return out;
}

/** Remove an entry by name; returns a new entries list (may be empty). */
export function withoutEntry(entries: TreeEntry[], name: string): TreeEntry[] {
  return entries.filter((e) => e.name !== name);
}
