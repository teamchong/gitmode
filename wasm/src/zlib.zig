// Zlib inflate/deflate for git objects — powered by libdeflate
//
// Replaces Zig's std.compress.flate which crashes on ~0.01% of deflate streams.
// libdeflate is battle-tested (used by termweb/metal0) and 2-3x faster.
//
// Decompressor and compressor are allocated once at init time and reused
// across all calls, avoiding per-call malloc/free overhead in WASM.
//
// Deflate uses compression level 0 (stored blocks) — fastest possible.
// For a serverless git host, network bandwidth is cheap (Cloudflare egress is free)
// and CPU time is expensive (billed per ms), so level 0 is optimal.

const std = @import("std");
const c = @cImport({
    @cInclude("libdeflate.h");
});

// Persistent decompressor/compressor — allocated once, reused across calls
var global_decompressor: ?*c.libdeflate_decompressor = null;
var global_compressor: ?*c.libdeflate_compressor = null;

fn getDecompressor() !*c.libdeflate_decompressor {
    if (global_decompressor) |d| return d;
    global_decompressor = c.libdeflate_alloc_decompressor() orelse return error.OutOfMemory;
    return global_decompressor.?;
}

fn getCompressor() !*c.libdeflate_compressor {
    if (global_compressor) |comp| return comp;
    global_compressor = c.libdeflate_alloc_compressor(0) orelse return error.OutOfMemory;
    return global_compressor.?;
}

/// Decompress zlib data. Returns number of bytes written to out.
pub fn inflate(input: []const u8, out: []u8) !usize {
    const decompressor = try getDecompressor();

    var actual_out: usize = 0;
    const result = c.libdeflate_zlib_decompress(
        decompressor,
        input.ptr,
        input.len,
        out.ptr,
        out.len,
        &actual_out,
    );

    if (result != c.LIBDEFLATE_SUCCESS) {
        return error.DecompressError;
    }
    return actual_out;
}

/// Result of inflate that also reports input bytes consumed.
pub const InflateResult = struct {
    bytes_written: usize,
    bytes_consumed: usize,
};

/// Decompress zlib data, returning both output size and input bytes consumed.
/// This is used by the packfile reader to know where the next entry starts.
pub fn inflateWithConsumed(input: []const u8, out: []u8) !InflateResult {
    const decompressor = try getDecompressor();

    var actual_in: usize = 0;
    var actual_out: usize = 0;
    const result = c.libdeflate_zlib_decompress_ex(
        decompressor,
        input.ptr,
        input.len,
        out.ptr,
        out.len,
        &actual_in,
        &actual_out,
    );

    if (result != c.LIBDEFLATE_SUCCESS) {
        return error.DecompressError;
    }
    return .{
        .bytes_written = actual_out,
        .bytes_consumed = actual_in,
    };
}

/// Compress data with zlib using deflate stored blocks (compression level 0).
/// Produces valid RFC 1950 (zlib) wrapping RFC 1951 (deflate) stored blocks.
pub fn deflate(input: []const u8, out: []u8) !usize {
    const compressor = try getCompressor();

    const bound = c.libdeflate_zlib_compress_bound(compressor, input.len);
    if (bound > out.len) {
        return error.BufferTooSmall;
    }

    const actual_size = c.libdeflate_zlib_compress(
        compressor,
        input.ptr,
        input.len,
        out.ptr,
        out.len,
    );

    if (actual_size == 0) {
        return error.CompressFailed;
    }
    return actual_size;
}

test "zlib deflate produces valid output that inflate can read" {
    const original = "hello world! this is a test of zlib compression in gitmode.";
    var compressed: [512]u8 = undefined;
    const comp_len = try @This().deflate(original, &compressed);

    var decompressed: [256]u8 = undefined;
    const decomp_len = try inflate(compressed[0..comp_len], &decompressed);

    try std.testing.expectEqualStrings(original, decompressed[0..decomp_len]);
}

test "zlib roundtrip git blob" {
    const blob = "blob 13\x00Hello, World!";
    var compressed: [512]u8 = undefined;
    const comp_len = try @This().deflate(blob, &compressed);

    var decompressed: [256]u8 = undefined;
    const decomp_len = try inflate(compressed[0..comp_len], &decompressed);

    try std.testing.expectEqualStrings(blob, decompressed[0..decomp_len]);
}

test "zlib deflate empty input" {
    var compressed: [32]u8 = undefined;
    const comp_len = try @This().deflate("", &compressed);
    // libdeflate level 0 produces valid zlib for empty input
    try std.testing.expect(comp_len > 0);

    var decompressed: [16]u8 = undefined;
    const decomp_len = try inflate(compressed[0..comp_len], &decompressed);
    try std.testing.expectEqual(@as(usize, 0), decomp_len);
}

test "zlib deflate large input spanning multiple blocks" {
    // Create input larger than 65535 to test multi-block
    var large: [70000]u8 = undefined;
    for (&large, 0..) |*byte, i| {
        byte.* = @truncate(i);
    }

    var compressed: [80000]u8 = undefined;
    const comp_len = try @This().deflate(&large, &compressed);

    var decompressed: [70000]u8 = undefined;
    const decomp_len = try inflate(compressed[0..comp_len], &decompressed);
    try std.testing.expectEqual(@as(usize, 70000), decomp_len);
    try std.testing.expectEqualSlices(u8, &large, decompressed[0..decomp_len]);
}

test "inflateWithConsumed returns correct consumed bytes" {
    const original = "test data for consumed tracking";
    var compressed: [512]u8 = undefined;
    const comp_len = try @This().deflate(original, &compressed);

    // Put compressed data at the start of a larger buffer (simulating packfile)
    var padded: [1024]u8 = undefined;
    @memcpy(padded[0..comp_len], compressed[0..comp_len]);
    // Fill rest with junk
    @memset(padded[comp_len..], 0xAA);

    var decompressed: [256]u8 = undefined;
    const result = try inflateWithConsumed(&padded, &decompressed);

    try std.testing.expectEqualStrings(original, decompressed[0..result.bytes_written]);
    try std.testing.expectEqual(comp_len, result.bytes_consumed);
}
