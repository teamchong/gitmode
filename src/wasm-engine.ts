// WASM engine wrapper — instantiates the Zig module and provides typed API
//
// Pattern follows querymode: typed exports interface + instantiation with host imports

import wasmModule from "./wasm-module";

export interface WasmExports {
  memory: WebAssembly.Memory;

  // Memory management
  alloc(size: number): number;
  resetHeap(): void;
  getHeapUsed(): number;

  // SHA-1
  sha1_hash(dataPtr: number, dataLen: number, outPtr: number): void;
  sha1_hash_object(
    objType: number,
    dataPtr: number,
    dataLen: number,
    outPtr: number
  ): void;

  // Zlib
  zlib_inflate(
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number
  ): number;
  zlib_inflate_tracked(
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
    outConsumedPtr: number
  ): number;
  zlib_deflate(
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number
  ): number;

  // Object parsing
  parse_object_header(
    dataPtr: number,
    dataLen: number,
    outType: number,
    outContentOffset: number,
    outContentLen: number
  ): number;
  serialize_object(
    objType: number,
    contentPtr: number,
    contentLen: number,
    outPtr: number,
    outCap: number
  ): number;
  parse_tree(
    dataPtr: number,
    dataLen: number,
    outPtr: number,
    outCap: number
  ): number;

  // Packfile
  pack_parse_header(dataPtr: number, dataLen: number): number;
  pack_parse_entry_header(
    dataPtr: number,
    dataLen: number,
    offset: number,
    outType: number,
    outSize: number,
    outHeaderLen: number
  ): number;
  pack_build(
    objectsPtr: number,
    objectsLen: number,
    numObjects: number,
    outPtr: number,
    outCap: number
  ): number;

  // Delta
  delta_apply(
    basePtr: number,
    baseLen: number,
    deltaPtr: number,
    deltaLen: number,
    outPtr: number,
    outCap: number
  ): number;
  delta_create(
    basePtr: number,
    baseLen: number,
    targetPtr: number,
    targetLen: number,
    outPtr: number,
    outCap: number
  ): number;

  // Protocol
  pktline_encode(
    dataPtr: number,
    dataLen: number,
    outPtr: number,
    outCap: number
  ): number;
  pktline_decode(
    dataPtr: number,
    dataLen: number,
    offset: number,
    outPayloadOffset: number
  ): number;

  // SIMD utilities
  simd_memeql(aPtr: number, bPtr: number, len: number): number;
  simd_memchr(dataPtr: number, dataLen: number, byte: number): number;
}

export class WasmEngine {
  readonly exports: WasmExports;

  private constructor(exports: WasmExports) {
    this.exports = exports;
  }

  static async create(): Promise<WasmEngine> {
    const instance = await WebAssembly.instantiate(wasmModule, {
      env: {
        // Host imports — storage operations provided by GitEngine
        r2_get: () => -1,
        r2_put: () => -1,
        r2_head: () => -1,
        kv_get: () => -1,
        kv_put: () => -1,
        log_msg: (ptr: number, len: number) => {
          // Will be overridden per-instance
        },
      },
    });

    return new WasmEngine(instance.exports as unknown as WasmExports);
  }

  // --- Memory helpers ---

  writeBytes(data: Uint8Array): number {
    const ptr = this.exports.alloc(data.length);
    if (ptr === 0) throw new Error("WASM alloc failed");
    new Uint8Array(this.exports.memory.buffer, ptr, data.length).set(data);
    return ptr;
  }

  writeString(s: string): { ptr: number; len: number } {
    const encoded = new TextEncoder().encode(s);
    const ptr = this.writeBytes(encoded);
    return { ptr, len: encoded.length };
  }

  readBytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice();
  }

  readString(ptr: number, len: number): string {
    return new TextDecoder().decode(
      new Uint8Array(this.exports.memory.buffer, ptr, len)
    );
  }

  // --- Git operations ---

  sha1(data: Uint8Array): Uint8Array {
    this.exports.resetHeap();
    const dataPtr = this.writeBytes(data);
    const outPtr = this.exports.alloc(20);
    this.exports.sha1_hash(dataPtr, data.length, outPtr);
    return this.readBytes(outPtr, 20);
  }

  sha1Hex(data: Uint8Array): string {
    const digest = this.sha1(data);
    return Array.from(digest)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  hashObject(type: number, content: Uint8Array): Uint8Array {
    this.exports.resetHeap();
    const contentPtr = this.writeBytes(content);
    const outPtr = this.exports.alloc(20);
    this.exports.sha1_hash_object(type, contentPtr, content.length, outPtr);
    return this.readBytes(outPtr, 20);
  }

  zlibInflate(compressed: Uint8Array, maxSize: number): Uint8Array {
    this.exports.resetHeap();
    const inPtr = this.writeBytes(compressed);
    const outPtr = this.exports.alloc(maxSize);
    const written = this.exports.zlib_inflate(
      inPtr,
      compressed.length,
      outPtr,
      maxSize
    );
    return this.readBytes(outPtr, written);
  }

  zlibInflateTracked(compressed: Uint8Array, maxSize: number): { data: Uint8Array; consumed: number } {
    this.exports.resetHeap();
    const inPtr = this.writeBytes(compressed);
    const outPtr = this.exports.alloc(maxSize);
    const consumedPtr = this.exports.alloc(4);
    const written = this.exports.zlib_inflate_tracked(
      inPtr,
      compressed.length,
      outPtr,
      maxSize,
      consumedPtr
    );
    const consumed = new DataView(this.exports.memory.buffer).getUint32(consumedPtr, true);
    return { data: this.readBytes(outPtr, written), consumed };
  }

  zlibDeflate(data: Uint8Array): Uint8Array {
    this.exports.resetHeap();
    const inPtr = this.writeBytes(data);
    // Worst case: deflate output slightly larger than input
    const outCap = data.length + 64;
    const outPtr = this.exports.alloc(outCap);
    const written = this.exports.zlib_deflate(
      inPtr,
      data.length,
      outPtr,
      outCap
    );
    return this.readBytes(outPtr, written);
  }

  deltaApply(base: Uint8Array, delta: Uint8Array, maxSize: number): Uint8Array {
    this.exports.resetHeap();
    const basePtr = this.writeBytes(base);
    const deltaPtr = this.writeBytes(delta);
    const outPtr = this.exports.alloc(maxSize);
    const written = this.exports.delta_apply(
      basePtr,
      base.length,
      deltaPtr,
      delta.length,
      outPtr,
      maxSize
    );
    if (written === 0) throw new Error("Delta apply failed");
    return this.readBytes(outPtr, written);
  }

  deltaCreate(base: Uint8Array, target: Uint8Array): Uint8Array {
    this.exports.resetHeap();
    const basePtr = this.writeBytes(base);
    const targetPtr = this.writeBytes(target);
    const outCap = target.length + 256;
    const outPtr = this.exports.alloc(outCap);
    const written = this.exports.delta_create(
      basePtr,
      base.length,
      targetPtr,
      target.length,
      outPtr,
      outCap
    );
    if (written === 0) throw new Error("Delta create failed");
    return this.readBytes(outPtr, written);
  }
}
