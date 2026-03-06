// pkt-line encoding/decoding — the framing protocol for git smart HTTP
//
// Format: 4 hex digits (length including the 4 digits) + payload
// Special: "0000" = flush, "0001" = delimiter, "0002" = response-end

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FLUSH_PKT = encoder.encode("0000");
export const DELIM_PKT = encoder.encode("0001");

export function encodePktLine(data: string): Uint8Array {
  const payload = encoder.encode(data);
  const totalLen = payload.length + 4;
  const hex = totalLen.toString(16).padStart(4, "0");
  const result = new Uint8Array(totalLen);
  result.set(encoder.encode(hex));
  result.set(payload, 4);
  return result;
}

export function encodePktLineBytes(data: Uint8Array): Uint8Array {
  const totalLen = data.length + 4;
  const hex = totalLen.toString(16).padStart(4, "0");
  const result = new Uint8Array(totalLen);
  result.set(encoder.encode(hex));
  result.set(data, 4);
  return result;
}

export interface PktLineResult {
  type: "data" | "flush" | "delim" | "response-end";
  payload?: Uint8Array;
  nextOffset: number;
}

export function decodePktLine(
  data: Uint8Array,
  offset: number
): PktLineResult | null {
  if (offset + 4 > data.length) return null;

  const lenHex = decoder.decode(data.slice(offset, offset + 4));

  if (lenHex === "0000") {
    return { type: "flush", nextOffset: offset + 4 };
  }
  if (lenHex === "0001") {
    return { type: "delim", nextOffset: offset + 4 };
  }
  if (lenHex === "0002") {
    return { type: "response-end", nextOffset: offset + 4 };
  }

  const totalLen = parseInt(lenHex, 16);
  if (isNaN(totalLen) || totalLen < 4) return null;
  if (offset + totalLen > data.length) return null;

  const payload = data.slice(offset + 4, offset + totalLen);
  return { type: "data", payload, nextOffset: offset + totalLen };
}

/** Parse all pkt-lines from a buffer, splitting on flush packets. */
export function parsePktLines(data: Uint8Array): Uint8Array[][] {
  const sections: Uint8Array[][] = [[]];
  let offset = 0;

  while (offset < data.length) {
    const result = decodePktLine(data, offset);
    if (!result) break;

    if (result.type === "flush") {
      sections.push([]);
    } else if (result.type === "data" && result.payload) {
      sections[sections.length - 1].push(result.payload);
    }

    offset = result.nextOffset;
  }

  return sections;
}
