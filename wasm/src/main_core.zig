// gitmode-core — lightweight Git engine compiled to WASM
//
// Pure computation module for client-side use (npm package).
// No host imports required — runs anywhere WASM runs.
//
// Exports: SHA-1, zlib, delta, object parsing, packfile ops, protocol, SIMD

const std = @import("std");
const object = @import("object.zig");
const sha1 = @import("sha1.zig");
const pack = @import("pack.zig");
const delta = @import("delta.zig");
const zlib = @import("zlib.zig");
const protocol = @import("protocol.zig");
const simd = @import("simd.zig");

// ============================================================
// Memory management (same bump allocator as server)
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

export fn sha1_hash(data_ptr: [*]const u8, data_len: usize, out_ptr: [*]u8) void {
    const digest = sha1.hash(data_ptr[0..data_len]);
    @memcpy(out_ptr[0..20], &digest);
}

export fn sha1_hash_object(obj_type: u8, data_ptr: [*]const u8, data_len: usize, out_ptr: [*]u8) void {
    const digest = object.hashObject(@enumFromInt(obj_type), data_ptr[0..data_len]);
    @memcpy(out_ptr[0..20], &digest);
}

// ============================================================
// Zlib compress/decompress
// ============================================================

export fn zlib_inflate(
    in_ptr: [*]const u8,
    in_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return zlib.inflate(in_ptr[0..in_len], out_ptr[0..out_cap]) catch 0;
}

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

export fn pack_parse_header(data_ptr: [*]const u8, data_len: usize) i32 {
    return pack.parseHeader(data_ptr[0..data_len]) catch -1;
}

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

export fn pktline_encode(
    data_ptr: [*]const u8,
    data_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    return protocol.encodePktLine(data_ptr[0..data_len], out_ptr[0..out_cap]) catch 0;
}

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

export fn simd_memeql(a_ptr: [*]const u8, b_ptr: [*]const u8, len: usize) u32 {
    return if (simd.memeql(a_ptr[0..len], b_ptr[0..len])) 1 else 0;
}

export fn simd_memchr(data_ptr: [*]const u8, data_len: usize, byte: u8) usize {
    return simd.memchr(data_ptr[0..data_len], byte);
}

// Required by WASI libc CRT (_start calls main)
pub fn main() void {}

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
}
