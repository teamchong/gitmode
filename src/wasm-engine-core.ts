// Core WASM engine — lightweight client-side module (no libgit2, no host imports)
//
// Same computation API as WasmEngine but 10x smaller (~83KB vs ~865KB).
// Use this for client-side operations: SHA-1, zlib, delta, object parsing, packfile ops.

import wasmModule from "./wasm-module-core";
import { toHex } from "./hex";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface CoreWasmExports {
  memory: WebAssembly.Memory;

  // Memory management
  alloc(size: number): number;
  resetHeap(): void;
  getHeapUsed(): number;
  heapSave(): number;
  heapRestore(offset: number): void;

  // SHA-1
  sha1_hash(dataPtr: number, dataLen: number, outPtr: number): void;
  sha1_hash_object(objType: number, dataPtr: number, dataLen: number, outPtr: number): void;

  // Zlib
  zlib_inflate(inPtr: number, inLen: number, outPtr: number, outCap: number): number;
  zlib_inflate_tracked(inPtr: number, inLen: number, outPtr: number, outCap: number, outConsumedPtr: number): number;
  zlib_deflate(inPtr: number, inLen: number, outPtr: number, outCap: number): number;

  // Object parsing
  parse_object_header(dataPtr: number, dataLen: number, outType: number, outContentOffset: number, outContentLen: number): number;
  serialize_object(objType: number, contentPtr: number, contentLen: number, outPtr: number, outCap: number): number;
  parse_tree(dataPtr: number, dataLen: number, outPtr: number, outCap: number): number;

  // Packfile
  pack_parse_header(dataPtr: number, dataLen: number): number;
  pack_parse_entry_header(dataPtr: number, dataLen: number, offset: number, outType: number, outSize: number, outHeaderLen: number): number;
  pack_build(objectsPtr: number, objectsLen: number, numObjects: number, outPtr: number, outCap: number): number;

  // Delta
  delta_apply(basePtr: number, baseLen: number, deltaPtr: number, deltaLen: number, outPtr: number, outCap: number): number;
  delta_create(basePtr: number, baseLen: number, targetPtr: number, targetLen: number, outPtr: number, outCap: number): number;

  // Protocol
  pktline_encode(dataPtr: number, dataLen: number, outPtr: number, outCap: number): number;
  pktline_decode(dataPtr: number, dataLen: number, offset: number, outPayloadOffset: number): number;

  // SIMD utilities
  simd_memeql(aPtr: number, bPtr: number, len: number): number;
  simd_memchr(dataPtr: number, dataLen: number, byte: number): number;
}

const CORE_SHA_OUT_SIZE = 20;
const CORE_SCALAR_OUT_SIZE = 8;
const CORE_IO_BUF_SIZE = 8 * 1024 * 1024;
const CORE_SCRATCH_SIZE = CORE_SHA_OUT_SIZE + CORE_SCALAR_OUT_SIZE + CORE_IO_BUF_SIZE;

export class WasmEngineCore {
  readonly exports: CoreWasmExports;

  private _shaOutPtr = 0;
  private _scalarPtr = 0;
  private _ioPtr = 0;
  private _ioSize = CORE_IO_BUF_SIZE;
  private _dynamicBase = 0;

  private constructor(exports: CoreWasmExports) {
    this.exports = exports;
  }

  private _initScratch(): void {
    const ptr = this.exports.alloc(CORE_SCRATCH_SIZE) as unknown as number;
    if (!ptr) throw new Error("WASM core scratch alloc failed");
    this._shaOutPtr = ptr;
    this._scalarPtr = ptr + CORE_SHA_OUT_SIZE;
    this._ioPtr = ptr + CORE_SHA_OUT_SIZE + CORE_SCALAR_OUT_SIZE;
    this._dynamicBase = this.exports.heapSave();
  }

  private _resetDynamic(): void {
    this.exports.heapRestore(this._dynamicBase);
  }

  writeToScratch(data: Uint8Array): number {
    if (data.length > this._ioSize) {
      const ptr = this.exports.alloc(data.length);
      if (ptr === 0) throw new Error("WASM alloc failed");
      new Uint8Array(this.exports.memory.buffer, ptr as unknown as number, data.length).set(data);
      return ptr as unknown as number;
    }
    new Uint8Array(this.exports.memory.buffer, this._ioPtr, data.length).set(data);
    return this._ioPtr;
  }

  static async create(): Promise<WasmEngineCore> {
    let wasmMemory: WebAssembly.Memory | null = null;

    // Minimal WASI shims for libc runtime init
    const wasi_snapshot_preview1: Record<string, Function> = {
      environ_get: () => 0,
      environ_sizes_get: (countPtr: number, sizePtr: number) => {
        const mem = new DataView(wasmMemory!.buffer);
        mem.setUint32(countPtr, 0, true);
        mem.setUint32(sizePtr, 0, true);
        return 0;
      },
      clock_time_get: (_clockId: number, _precision: bigint, outPtr: number) => {
        const mem = new DataView(wasmMemory!.buffer);
        mem.setBigUint64(outPtr, BigInt(Math.floor(performance.now() * 1_000_000)), true);
        return 0;
      },
      fd_close: () => 0,
      fd_fdstat_get: (_fd: number, bufPtr: number) => {
        const mem = new DataView(wasmMemory!.buffer);
        mem.setUint8(bufPtr, 2);
        mem.setUint16(bufPtr + 2, 0, true);
        mem.setBigUint64(bufPtr + 8, 0n, true);
        mem.setBigUint64(bufPtr + 16, 0n, true);
        return 0;
      },
      fd_filestat_get: () => 52,
      fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
        const mem = new DataView(wasmMemory!.buffer);
        const memU8 = new Uint8Array(wasmMemory!.buffer);
        let totalWritten = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = mem.getUint32(iovsPtr + i * 8, true);
          const len = mem.getUint32(iovsPtr + i * 8 + 4, true);
          if (fd === 1 || fd === 2) {
            console.log("[wasm-core]", textDecoder.decode(memU8.subarray(ptr, ptr + len)));
          }
          totalWritten += len;
        }
        mem.setUint32(nwrittenPtr, totalWritten, true);
        return 0;
      },
      fd_read: () => 52,
      fd_pread: () => 52,
      fd_pwrite: () => 52,
      fd_readdir: () => 52,
      fd_seek: () => 52,
      fd_sync: () => 0,
      fd_prestat_get: () => 8,
      fd_prestat_dir_name: () => 8,
      path_create_directory: () => 52,
      path_filestat_get: () => 52,
      path_filestat_set_times: () => 52,
      path_link: () => 52,
      path_open: () => 52,
      path_readlink: () => 52,
      path_remove_directory: () => 52,
      path_symlink: () => 52,
      path_unlink_file: () => 52,
      proc_exit: (code: number) => {
        console.error(`WASM core proc_exit called with code ${code}`);
      },
    };

    // No env imports needed — core module has no host dependencies
    const instance = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1,
    });

    wasmMemory = (instance.exports as any).memory;

    if (typeof (instance.exports as any)._start === "function") {
      (instance.exports as any)._start();
    }

    const engine = new WasmEngineCore(instance.exports as unknown as CoreWasmExports);
    engine._initScratch();
    return engine;
  }

  getHeapUsed(): number {
    return this.exports.getHeapUsed();
  }

  // --- Memory helpers ---

  writeBytes(data: Uint8Array): number {
    const ptr = this.exports.alloc(data.length);
    if (ptr === 0) throw new Error("WASM alloc failed");
    new Uint8Array(this.exports.memory.buffer, ptr, data.length).set(data);
    return ptr;
  }

  writeString(s: string): { ptr: number; len: number } {
    const encoded = textEncoder.encode(s);
    const ptr = this.writeBytes(encoded);
    return { ptr, len: encoded.length };
  }

  readBytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice();
  }

  /** Zero-copy view into WASM memory. Valid until next alloc/reset/grow. */
  viewBytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, ptr, len);
  }

  readString(ptr: number, len: number): string {
    return textDecoder.decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
  }

  /** Save heap offset — returns checkpoint for heapRestore(). */
  heapSave(): number {
    return this.exports.heapSave();
  }

  /** Restore heap to checkpoint — frees all allocations after it. */
  heapRestore(checkpoint: number): void {
    this.exports.heapRestore(checkpoint);
  }

  // --- Git operations ---

  sha1(data: Uint8Array): Uint8Array {
    this._resetDynamic();
    const inPtr = this.writeToScratch(data);
    this.exports.sha1_hash(inPtr, data.length, this._shaOutPtr);
    return this.readBytes(this._shaOutPtr, 20);
  }

  sha1Hex(data: Uint8Array): string {
    this._resetDynamic();
    const inPtr = this.writeToScratch(data);
    this.exports.sha1_hash(inPtr, data.length, this._shaOutPtr);
    return toHex(this.viewBytes(this._shaOutPtr, 20));
  }

  hashObject(type: number, content: Uint8Array): Uint8Array {
    this._resetDynamic();
    const inPtr = this.writeToScratch(content);
    this.exports.sha1_hash_object(type, inPtr, content.length, this._shaOutPtr);
    return this.readBytes(this._shaOutPtr, 20);
  }

  zlibInflate(compressed: Uint8Array, maxSize: number): Uint8Array {
    this._resetDynamic();
    const inPtr = this.writeToScratch(compressed);
    const outPtr = this.exports.alloc(maxSize);
    if (outPtr === 0) throw new Error(`WASM alloc failed: inflate output buffer (${maxSize} bytes)`);
    const written = this.exports.zlib_inflate(inPtr, compressed.length, outPtr, maxSize);
    if (written === 0) throw new Error("Zlib inflate failed");
    return this.readBytes(outPtr, written);
  }

  zlibInflateTracked(compressed: Uint8Array, maxSize: number): { data: Uint8Array; consumed: number } {
    this._resetDynamic();
    const inPtr = this.writeToScratch(compressed);
    const outPtr = this.exports.alloc(maxSize);
    if (outPtr === 0) throw new Error(`WASM alloc failed: inflate output buffer (${maxSize} bytes)`);
    const written = this.exports.zlib_inflate_tracked(
      inPtr, compressed.length, outPtr, maxSize, this._scalarPtr
    );
    const consumed = new DataView(this.exports.memory.buffer).getUint32(this._scalarPtr, true);
    return { data: this.readBytes(outPtr, written), consumed };
  }

  zlibDeflate(data: Uint8Array): Uint8Array {
    this._resetDynamic();
    const inPtr = this.writeToScratch(data);
    const maxBlocks = Math.max(Math.ceil(data.length / 5000), 1);
    const outCap = data.length + maxBlocks * 5 + 6 + 64;
    const outPtr = this.exports.alloc(outCap);
    const written = this.exports.zlib_deflate(inPtr, data.length, outPtr, outCap);
    if (written === 0) throw new Error("Zlib deflate failed");
    return this.readBytes(outPtr, written);
  }

  deltaApply(base: Uint8Array, delta: Uint8Array, maxSize: number): Uint8Array {
    this._resetDynamic();
    const basePtr = this.writeToScratch(base);
    const deltaPtr = this.writeBytes(delta);
    const outPtr = this.exports.alloc(maxSize);
    const written = this.exports.delta_apply(basePtr, base.length, deltaPtr, delta.length, outPtr, maxSize);
    if (written === 0) throw new Error("Delta apply failed");
    return this.readBytes(outPtr, written);
  }

  deltaCreate(base: Uint8Array, target: Uint8Array): Uint8Array {
    this._resetDynamic();
    const basePtr = this.writeToScratch(base);
    const targetPtr = this.writeBytes(target);
    const outCap = target.length + 256;
    const outPtr = this.exports.alloc(outCap);
    const written = this.exports.delta_create(basePtr, base.length, targetPtr, target.length, outPtr, outCap);
    if (written === 0) throw new Error("Delta create failed");
    return this.readBytes(outPtr, written);
  }

  hashAndDeflate(
    type: number,
    content: Uint8Array,
    header: Uint8Array
  ): { sha1: Uint8Array; compressed: Uint8Array } {
    this._resetDynamic();

    const contentPtr = this.writeToScratch(content);
    this.exports.sha1_hash_object(type, contentPtr, content.length, this._shaOutPtr);

    const fullLen = header.length + content.length;
    const fullPtr = this.exports.alloc(fullLen);
    if (fullPtr === 0) throw new Error("WASM alloc failed: full object");
    const fullView = new Uint8Array(this.exports.memory.buffer, fullPtr, fullLen);
    fullView.set(header);
    fullView.set(
      new Uint8Array(this.exports.memory.buffer, contentPtr, content.length),
      header.length
    );

    const maxBlocks = Math.max(Math.ceil(fullLen / 5000), 1);
    const outCap = fullLen + maxBlocks * 5 + 6 + 64;
    const outPtr = this.exports.alloc(outCap);
    if (outPtr === 0) throw new Error("WASM alloc failed: deflate output");
    const written = this.exports.zlib_deflate(fullPtr, fullLen, outPtr, outCap);
    if (written === 0) throw new Error("Zlib deflate failed");

    return {
      sha1: this.viewBytes(this._shaOutPtr, 20),
      compressed: this.readBytes(outPtr, written),
    };
  }
}
