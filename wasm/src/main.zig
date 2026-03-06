// gitmode — Git engine compiled to WASM for Cloudflare Workers
//
// Exports functions for the TypeScript Worker to call:
//   - Object parsing/serialization (blob, tree, commit, tag)
//   - SHA-1 hashing (SIMD-accelerated)
//   - Zlib inflate/deflate
//   - Packfile encode/decode
//   - Delta compression/decompression
//   - Ref negotiation (have/want protocol)

const std = @import("std");
const object = @import("object.zig");
const sha1 = @import("sha1.zig");
const pack = @import("pack.zig");
const delta = @import("delta.zig");
const zlib = @import("zlib.zig");
const protocol = @import("protocol.zig");
const simd = @import("simd.zig");
const r2_backend = @import("r2_backend.zig");
const checkout = @import("checkout.zig");
const libgit2 = @import("libgit2.zig");

// Force libgit2 exports to be included in the WASM binary
comptime {
    _ = &libgit2.libgit2_init;
    _ = &libgit2.libgit2_shutdown;
    _ = &libgit2.libgit2_diff;
    _ = &libgit2.libgit2_revwalk;
    _ = &libgit2.libgit2_blame;
}

// ============================================================
// Host imports — provided by the TypeScript Worker
// ============================================================
pub const host = struct {
    // Storage: read/write git objects from R2
    pub extern "env" fn r2_get(key_ptr: [*]const u8, key_len: usize, buf_ptr: [*]u8, buf_cap: usize) i32;
    pub extern "env" fn r2_put(key_ptr: [*]const u8, key_len: usize, data_ptr: [*]const u8, data_len: usize) i32;
    pub extern "env" fn r2_head(key_ptr: [*]const u8, key_len: usize) i32;

    // KV: read/write refs
    pub extern "env" fn kv_get(key_ptr: [*]const u8, key_len: usize, buf_ptr: [*]u8, buf_cap: usize) i32;
    pub extern "env" fn kv_put(key_ptr: [*]const u8, key_len: usize, val_ptr: [*]const u8, val_len: usize) i32;

    // Logging
    pub extern "env" fn log_msg(ptr: [*]const u8, len: usize) void;
};

// ============================================================
// Memory management
// ============================================================
var heap = Heap{};

const Heap = struct {
    buf: [heap_size]u8 = undefined,
    offset: usize = 0,

    const heap_size = 64 * 1024 * 1024; // 64MB

    fn alloc(self: *Heap, size: usize) ?[*]u8 {
        const aligned = std.mem.alignForward(usize, size, 16);
        if (self.offset + aligned > heap_size) return null;
        const ptr = self.buf[self.offset..].ptr;
        self.offset += aligned;
        return ptr;
    }

    fn reset(self: *Heap) void {
        self.offset = 0;
    }
};

export fn alloc(size: usize) ?[*]u8 {
    return heap.alloc(size);
}

export fn resetHeap() void {
    heap.reset();
}

export fn getHeapUsed() usize {
    return heap.offset;
}

// ============================================================
// SHA-1 hashing (SIMD-accelerated)
// ============================================================

/// Hash a raw buffer and write 20-byte digest to out_ptr.
export fn sha1_hash(data_ptr: [*]const u8, data_len: usize, out_ptr: [*]u8) void {
    const digest = sha1.hash(data_ptr[0..data_len]);
    @memcpy(out_ptr[0..20], &digest);
}

/// Hash a git object: "type size\0content" → 20-byte SHA-1.
/// Returns pointer to 20-byte digest in heap.
export fn sha1_hash_object(obj_type: u8, data_ptr: [*]const u8, data_len: usize, out_ptr: [*]u8) void {
    const digest = object.hashObject(@enumFromInt(obj_type), data_ptr[0..data_len]);
    @memcpy(out_ptr[0..20], &digest);
}

// ============================================================
// Zlib compress/decompress
// ============================================================

/// Decompress zlib data. Returns decompressed size, or 0 on error.
export fn zlib_inflate(
    in_ptr: [*]const u8,
    in_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return zlib.inflate(in_ptr[0..in_len], out_ptr[0..out_cap]) catch 0;
}

/// Decompress zlib data, also returning input bytes consumed.
/// Writes consumed byte count to out_consumed_ptr. Returns decompressed size, or 0 on error.
export fn zlib_inflate_tracked(
    in_ptr: [*]const u8,
    in_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
    out_consumed_ptr: *usize,
) usize {
    const result = zlib.inflateWithConsumed(in_ptr[0..in_len], out_ptr[0..out_cap]) catch return 0;
    out_consumed_ptr.* = result.bytes_consumed;
    return result.bytes_written;
}

/// Compress data with zlib. Returns compressed size, or 0 on error.
export fn zlib_deflate(
    in_ptr: [*]const u8,
    in_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return zlib.deflate(in_ptr[0..in_len], out_ptr[0..out_cap]) catch 0;
}

// ============================================================
// Git object parsing
// ============================================================

/// Parse a git object header. Returns: object type (1=blob,2=tree,3=commit,4=tag)
/// and writes content offset and content length to the out pointers.
export fn parse_object_header(
    data_ptr: [*]const u8,
    data_len: usize,
    out_type: *u8,
    out_content_offset: *usize,
    out_content_len: *usize,
) i32 {
    const result = object.parseHeader(data_ptr[0..data_len]) catch return -1;
    out_type.* = @intFromEnum(result.obj_type);
    out_content_offset.* = result.content_offset;
    out_content_len.* = result.content_len;
    return 0;
}

/// Serialize a git object: prepend "type size\0" header.
/// Returns total size written, or 0 on error.
export fn serialize_object(
    obj_type: u8,
    content_ptr: [*]const u8,
    content_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return object.serialize(
        @enumFromInt(obj_type),
        content_ptr[0..content_len],
        out_ptr[0..out_cap],
    ) catch 0;
}

// ============================================================
// Tree entry parsing
// ============================================================

/// Parse tree entries. For each entry, writes to the output buffer:
///   mode(u32) + name_offset(u32) + name_len(u32) + sha1(20 bytes)
/// Returns number of entries parsed.
export fn parse_tree(
    data_ptr: [*]const u8,
    data_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) u32 {
    return object.parseTree(data_ptr[0..data_len], out_ptr[0..out_cap]);
}

// ============================================================
// Packfile operations
// ============================================================

/// Parse a packfile header. Returns number of objects, or -1 on error.
export fn pack_parse_header(data_ptr: [*]const u8, data_len: usize) i32 {
    return pack.parseHeader(data_ptr[0..data_len]) catch -1;
}

/// Parse a single packfile object entry starting at offset.
/// Writes: type(u8), decompressed_size(u32), consumed_bytes(u32) to out.
/// Returns 0 on success, -1 on error.
export fn pack_parse_entry_header(
    data_ptr: [*]const u8,
    data_len: usize,
    offset: usize,
    out_type: *u8,
    out_size: *u32,
    out_header_len: *u32,
) i32 {
    return pack.parseEntryHeader(data_ptr[0..data_len], offset, out_type, out_size, out_header_len) catch -1;
}

/// Build a packfile from objects. Each object is preceded by its SHA-1 (20 bytes)
/// and length (4 bytes u32 LE). Returns total packfile size written.
export fn pack_build(
    objects_ptr: [*]const u8,
    objects_len: usize,
    num_objects: u32,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return pack.build(objects_ptr[0..objects_len], num_objects, out_ptr[0..out_cap]) catch 0;
}

// ============================================================
// Delta compression
// ============================================================

/// Apply a git delta to a base object. Returns result size, or 0 on error.
export fn delta_apply(
    base_ptr: [*]const u8,
    base_len: usize,
    delta_ptr: [*]const u8,
    delta_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return delta.apply(
        base_ptr[0..base_len],
        delta_ptr[0..delta_len],
        out_ptr[0..out_cap],
    ) catch 0;
}

/// Create a delta from base → target. Returns delta size, or 0 on error.
/// Uses SIMD-accelerated matching for finding copy regions.
export fn delta_create(
    base_ptr: [*]const u8,
    base_len: usize,
    target_ptr: [*]const u8,
    target_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return delta.create(
        base_ptr[0..base_len],
        target_ptr[0..target_len],
        out_ptr[0..out_cap],
    ) catch 0;
}

// ============================================================
// Protocol helpers
// ============================================================

/// Format pkt-line: prepend 4-hex-digit length. Returns bytes written.
export fn pktline_encode(
    data_ptr: [*]const u8,
    data_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return protocol.encodePktLine(data_ptr[0..data_len], out_ptr[0..out_cap]) catch 0;
}

/// Parse pkt-line at offset. Returns payload length (0 = flush pkt, -1 = error).
/// Writes payload offset to out_offset.
export fn pktline_decode(
    data_ptr: [*]const u8,
    data_len: usize,
    offset: usize,
    out_payload_offset: *usize,
) i32 {
    return protocol.decodePktLine(data_ptr[0..data_len], offset, out_payload_offset) catch -1;
}

// ============================================================
// SIMD utilities
// ============================================================

/// SIMD memcmp — returns 1 if equal, 0 if not.
export fn simd_memeql(a_ptr: [*]const u8, b_ptr: [*]const u8, len: usize) u32 {
    return if (simd.memeql(a_ptr[0..len], b_ptr[0..len])) 1 else 0;
}

/// SIMD memchr — find first occurrence of byte. Returns index or len if not found.
export fn simd_memchr(data_ptr: [*]const u8, data_len: usize, byte: u8) usize {
    return simd.memchr(data_ptr[0..data_len], byte);
}

// ============================================================
// Tests
// ============================================================
// ============================================================
// Checkout (server-side worktree materialization)
// ============================================================

// checkout_commit is exported directly from checkout.zig via `export fn`

// ============================================================
// Tests
// ============================================================
test {
    _ = object;
    _ = sha1;
    _ = pack;
    _ = delta;
    _ = zlib;
    _ = protocol;
    _ = simd;
    _ = r2_backend;
    _ = checkout;
    _ = libgit2;
}
