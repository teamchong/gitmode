import { describe, expect, it } from "vitest";
import {
  encodePktLine,
  encodePktLineBytes,
  decodePktLine,
  parsePktLines,
  concat,
} from "../../src/protocol/pkt-line";

const td = new TextDecoder();
const te = new TextEncoder();

describe("encodePktLine", () => {
  it("encodes a short payload with 4-hex-digit length prefix", () => {
    const out = encodePktLine("hello");
    expect(td.decode(out)).toBe("0009hello");
  });

  it("uses lowercase hex for the length", () => {
    const out = encodePktLine("a".repeat(0xab - 4));
    // total len = 0xab → "00ab"
    expect(td.decode(out.subarray(0, 4))).toBe("00ab");
  });

  it("encodes empty payload as a 4-byte length-only packet", () => {
    const out = encodePktLine("");
    expect(td.decode(out)).toBe("0004");
    expect(out.length).toBe(4);
  });
});

describe("encodePktLineBytes", () => {
  it("frames arbitrary bytes with the length prefix", () => {
    const data = new Uint8Array([0xff, 0x00, 0x42]);
    const out = encodePktLineBytes(data);
    expect(out.length).toBe(7);
    expect(td.decode(out.subarray(0, 4))).toBe("0007");
    expect(out[4]).toBe(0xff);
    expect(out[5]).toBe(0x00);
    expect(out[6]).toBe(0x42);
  });
});

describe("decodePktLine", () => {
  it("decodes a data packet", () => {
    const buf = te.encode("0009hello");
    const r = decodePktLine(buf, 0);
    expect(r?.type).toBe("data");
    expect(td.decode(r!.payload!)).toBe("hello");
    expect(r?.nextOffset).toBe(9);
  });

  it("decodes flush, delim, response-end markers", () => {
    expect(decodePktLine(te.encode("0000"), 0)?.type).toBe("flush");
    expect(decodePktLine(te.encode("0001"), 0)?.type).toBe("delim");
    expect(decodePktLine(te.encode("0002"), 0)?.type).toBe("response-end");
  });

  it("returns null when the buffer is shorter than the declared length", () => {
    const buf = te.encode("0009hel"); // declares 9 bytes total but only 7 available
    expect(decodePktLine(buf, 0)).toBeNull();
  });

  it("returns null when length prefix is malformed", () => {
    expect(decodePktLine(te.encode("zzzz"), 0)).toBeNull();
  });
});

describe("parsePktLines", () => {
  it("splits sections on flush packets", () => {
    const buf = concat([
      encodePktLine("first"),
      encodePktLine("second"),
      new Uint8Array([0x30, 0x30, 0x30, 0x30]), // "0000" flush
      encodePktLine("third"),
    ]);
    const sections = parsePktLines(buf);
    expect(sections.length).toBe(2);
    expect(sections[0]!.length).toBe(2);
    expect(td.decode(sections[0]![0]!)).toBe("first");
    expect(td.decode(sections[0]![1]!)).toBe("second");
    expect(sections[1]!.length).toBe(1);
    expect(td.decode(sections[1]![0]!)).toBe("third");
  });

  it("returns one empty section for an empty input", () => {
    const sections = parsePktLines(new Uint8Array(0));
    expect(sections).toEqual([[]]);
  });
});

describe("concat", () => {
  it("concatenates multiple Uint8Arrays into one", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const c = new Uint8Array([6]);
    const out = concat([a, b, c]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("handles empty input", () => {
    expect(concat([])).toEqual(new Uint8Array(0));
  });
});
