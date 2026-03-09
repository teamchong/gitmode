// WASM engine wrapper — instantiates the Zig module and provides typed API
//
// The Zig module targets wasm32-wasi, so we provide minimal WASI shims
// alongside the gitmode-specific env imports.

import wasmModule from "./wasm-module";
import { toHex } from "./hex";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

  // libgit2 operations
  libgit2_init(): number;
  libgit2_shutdown(): void;
  libgit2_diff(
    oldShaPtr: number,
    newShaPtr: number,
    outPtr: number,
    outCap: number
  ): number;
  libgit2_revwalk(
    startShaPtr: number,
    maxCount: number,
    outPtr: number,
    outCap: number
  ): number;
  libgit2_blame(
    pathPtr: number,
    pathLen: number,
    outPtr: number,
    outCap: number
  ): number;
}

// Minimal WASI shim — the WASM module targets wasm32-wasi for libc support,
// but all actual I/O goes through __gitmode_fs_* host imports in posix_shim.c.
// These WASI functions satisfy the musl libc runtime's internal needs.
function createWasiShims() {
  const ERRNO_NOSYS = 52;
  const ERRNO_BADF = 8;

  return {
    // Environment variables — none needed
    environ_get: () => 0,
    environ_sizes_get: (countPtr: number, sizePtr: number, memory: DataView) => {
      memory.setUint32(countPtr, 0, true);
      memory.setUint32(sizePtr, 0, true);
      return 0;
    },

    // Clock — return monotonic nanoseconds
    clock_time_get: (clockId: number, precision: bigint, outPtr: number, memory: DataView) => {
      const ns = BigInt(Math.floor(performance.now() * 1_000_000));
      memory.setBigUint64(outPtr, ns, true);
      return 0;
    },

    // File descriptor operations — satisfy musl libc's stdio init
    fd_close: () => 0,
    fd_fdstat_get: (fd: number, bufPtr: number, memory: DataView) => {
      // Tell musl this fd is a character device (tty-like)
      memory.setUint8(bufPtr, 2); // filetype = character_device
      memory.setUint16(bufPtr + 2, 0, true); // flags
      memory.setBigUint64(bufPtr + 8, 0n, true); // rights_base
      memory.setBigUint64(bufPtr + 16, 0n, true); // rights_inheriting
      return 0;
    },
    fd_filestat_get: () => ERRNO_NOSYS,

    // fd_write — needed for stderr/stdout output from C (printf, assert, etc.)
    fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number, memory: DataView, memU8: Uint8Array) => {
      let totalWritten = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = memory.getUint32(iovsPtr + i * 8, true);
        const len = memory.getUint32(iovsPtr + i * 8 + 4, true);
        const text = textDecoder.decode(memU8.subarray(ptr, ptr + len));
        if (fd === 1 || fd === 2) {
          console.log("[wasm]", text);
        }
        totalWritten += len;
      }
      memory.setUint32(nwrittenPtr, totalWritten, true);
      return 0;
    },

    fd_read: () => ERRNO_NOSYS,
    fd_pread: () => ERRNO_NOSYS,
    fd_pwrite: () => ERRNO_NOSYS,
    fd_readdir: () => ERRNO_NOSYS,
    fd_seek: () => ERRNO_NOSYS,
    fd_sync: () => 0,

    // Pre-opened directories — none
    fd_prestat_get: () => ERRNO_BADF,
    fd_prestat_dir_name: () => ERRNO_BADF,

    // Path operations — all handled by posix_shim.c via __gitmode_fs_*
    path_create_directory: () => ERRNO_NOSYS,
    path_filestat_get: () => ERRNO_NOSYS,
    path_filestat_set_times: () => ERRNO_NOSYS,
    path_link: () => ERRNO_NOSYS,
    path_open: () => ERRNO_NOSYS,
    path_readlink: () => ERRNO_NOSYS,
    path_remove_directory: () => ERRNO_NOSYS,
    path_symlink: () => ERRNO_NOSYS,
    path_unlink_file: () => ERRNO_NOSYS,

    // Process
    proc_exit: (code: number) => {
      console.error(`WASM proc_exit called with code ${code}`);
    },
  };
}

export class WasmEngine {
  readonly exports: WasmExports;

  private constructor(exports: WasmExports) {
    this.exports = exports;
  }

  static async create(): Promise<WasmEngine> {
    let wasmMemory: WebAssembly.Memory | null = null;

    // Build WASI shim closures that capture wasmMemory
    const wasiShims = createWasiShims();

    const wasi_snapshot_preview1: Record<string, Function> = {
      environ_get: (countPtr: number, bufPtr: number) => {
        return wasiShims.environ_get();
      },
      environ_sizes_get: (countPtr: number, sizePtr: number) => {
        const mem = new DataView(wasmMemory!.buffer);
        return wasiShims.environ_sizes_get(countPtr, sizePtr, mem);
      },
      clock_time_get: (clockId: number, precision: bigint, outPtr: number) => {
        const mem = new DataView(wasmMemory!.buffer);
        return wasiShims.clock_time_get(clockId, precision, outPtr, mem);
      },
      fd_close: (fd: number) => wasiShims.fd_close(),
      fd_fdstat_get: (fd: number, bufPtr: number) => {
        const mem = new DataView(wasmMemory!.buffer);
        return wasiShims.fd_fdstat_get(fd, bufPtr, mem);
      },
      fd_filestat_get: () => wasiShims.fd_filestat_get(),
      fd_read: () => wasiShims.fd_read(),
      fd_pread: () => wasiShims.fd_pread(),
      fd_pwrite: () => wasiShims.fd_pwrite(),
      fd_readdir: () => wasiShims.fd_readdir(),
      fd_seek: () => wasiShims.fd_seek(),
      fd_sync: () => wasiShims.fd_sync(),
      fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
        const mem = new DataView(wasmMemory!.buffer);
        const memU8 = new Uint8Array(wasmMemory!.buffer);
        return wasiShims.fd_write(fd, iovsPtr, iovsLen, nwrittenPtr, mem, memU8);
      },
      fd_prestat_get: () => wasiShims.fd_prestat_get(),
      fd_prestat_dir_name: () => wasiShims.fd_prestat_dir_name(),
      path_create_directory: () => wasiShims.path_create_directory(),
      path_filestat_get: () => wasiShims.path_filestat_get(),
      path_filestat_set_times: () => wasiShims.path_filestat_set_times(),
      path_link: () => wasiShims.path_link(),
      path_open: () => wasiShims.path_open(),
      path_readlink: () => wasiShims.path_readlink(),
      path_remove_directory: () => wasiShims.path_remove_directory(),
      path_symlink: () => wasiShims.path_symlink(),
      path_unlink_file: () => wasiShims.path_unlink_file(),
      proc_exit: (code: number) => wasiShims.proc_exit(code),
    };

    const instance = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1,
      env: {
        // Filesystem host imports — used by posix_shim.c
        __gitmode_fs_open: () => -1,
        __gitmode_fs_read: () => -1,
        __gitmode_fs_write: () => -1,
        __gitmode_fs_close: () => 0,
        __gitmode_fs_stat: () => -1,
        __gitmode_fs_mkdir: () => -1,
        __gitmode_fs_unlink: () => -1,
        __gitmode_fs_rename: () => -1,

        // ODB host imports — used by libgit2.zig
        __gitmode_odb_read: () => -1,
        __gitmode_odb_exists: () => 0,
        __gitmode_odb_write: () => -1,
      },
    });

    wasmMemory = (instance.exports as any).memory;

    // Call _start to initialize the WASI runtime (sets up libc, etc.)
    if (typeof (instance.exports as any)._start === "function") {
      (instance.exports as any)._start();
    }

    return new WasmEngine(instance.exports as unknown as WasmExports);
  }

  /** Return current WASM heap usage in bytes. */
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

  readString(ptr: number, len: number): string {
    return textDecoder.decode(
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
    return toHex(this.sha1(data));
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
    if (outPtr === 0) throw new Error(`WASM alloc failed: inflate output buffer (${maxSize} bytes)`);
    const written = this.exports.zlib_inflate(
      inPtr,
      compressed.length,
      outPtr,
      maxSize
    );
    if (written === 0) throw new Error("Zlib inflate failed");
    return this.readBytes(outPtr, written);
  }

  zlibInflateTracked(compressed: Uint8Array, maxSize: number): { data: Uint8Array; consumed: number } {
    this.exports.resetHeap();
    const inPtr = this.writeBytes(compressed);
    const outPtr = this.exports.alloc(maxSize);
    if (outPtr === 0) throw new Error(`WASM alloc failed: inflate output buffer (${maxSize} bytes)`);
    const consumedPtr = this.exports.alloc(4);
    if (consumedPtr === 0) throw new Error("WASM alloc failed: consumed tracking (4 bytes)");
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
    // libdeflate level 0 uses 5000-byte blocks with 5 bytes overhead each + 6 bytes zlib framing
    const maxBlocks = Math.max(Math.ceil(data.length / 5000), 1);
    const outCap = data.length + maxBlocks * 5 + 6 + 64;
    const outPtr = this.exports.alloc(outCap);
    const written = this.exports.zlib_deflate(
      inPtr,
      data.length,
      outPtr,
      outCap
    );
    if (written === 0) throw new Error("Zlib deflate failed");
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
