// Zlib inflate/deflate for git objects
//
// Inflate: Zig's std.compress.flate Decompress (fast, uses WASM SIMD)
// Deflate: Custom stored-block compressor (level 0) — produces valid zlib
//          that all git clients accept. Zig 0.15's flate.Compress is incomplete
//          so we implement the zlib container + deflate stored blocks directly.
//
// Stored blocks are the fastest compression mode: no LZ77 or Huffman overhead.
// For a serverless git host, network bandwidth is cheap (Cloudflare egress is free)
// and CPU time is expensive (billed per ms), so level 0 is optimal.

const std = @import("std");
const flate = std.compress.flate;

/// Decompress zlib data. Returns number of bytes written to out.
pub fn inflate(input: []const u8, out: []u8) !usize {
    var reader = std.io.Reader.fixed(input);
    var writer = std.io.Writer.fixed(out);

    var window: [flate.max_window_len]u8 = undefined;
    var decompress = flate.Decompress.init(&reader, .zlib, &window);
    const bytes_written = decompress.reader.streamRemaining(&writer) catch {
        return error.DecompressError;
    };
    return bytes_written;
}

/// Result of inflate that also reports input bytes consumed.
pub const InflateResult = struct {
    bytes_written: usize,
    bytes_consumed: usize,
};

/// Decompress zlib data, returning both output size and input bytes consumed.
/// This is used by the packfile reader to know where the next entry starts.
pub fn inflateWithConsumed(input: []const u8, out: []u8) !InflateResult {
    var reader = std.io.Reader.fixed(input);
    var writer = std.io.Writer.fixed(out);

    var window: [flate.max_window_len]u8 = undefined;
    var decompress = flate.Decompress.init(&reader, .zlib, &window);
    const bytes_written = decompress.reader.streamRemaining(&writer) catch {
        return error.DecompressError;
    };
    return .{
        .bytes_written = bytes_written,
        .bytes_consumed = reader.seek,
    };
}

/// Compress data with zlib using deflate stored blocks (compression level 0).
/// Produces valid RFC 1950 (zlib) wrapping RFC 1951 (deflate) stored blocks.
///
/// Format:
///   [CMF][FLG]                    — 2 bytes zlib header
///   [BFINAL|BTYPE=00][LEN][NLEN][DATA]...  — stored blocks (max 65535 bytes each)
///   [ADLER32]                     — 4 bytes checksum (big-endian)
pub fn deflate(input: []const u8, out: []u8) !usize {
    // Zlib header: CMF=0x78 (deflate, 32K window), FLG=0x01 (no dict, level 0)
    // FLG is chosen so (CMF*256 + FLG) % 31 == 0
    const cmf: u8 = 0x78;
    const flg: u8 = 0x01;

    // Calculate output size: header(2) + blocks(5 bytes overhead each) + checksum(4)
    const max_block_data: usize = 65535;
    const num_blocks = if (input.len == 0) 1 else (input.len + max_block_data - 1) / max_block_data;
    const needed = 2 + (num_blocks * 5) + input.len + 4;
    if (needed > out.len) return error.BufferTooSmall;

    var pos: usize = 0;

    // Write zlib header
    out[pos] = cmf;
    pos += 1;
    out[pos] = flg;
    pos += 1;

    // Write deflate stored blocks
    var offset: usize = 0;
    while (true) {
        const remaining = input.len - offset;
        const block_len: u16 = @intCast(@min(remaining, max_block_data));
        const is_final: bool = (offset + block_len >= input.len);

        // Block header: BFINAL(1 bit) + BTYPE=00(2 bits), padded to byte
        out[pos] = if (is_final) 0x01 else 0x00;
        pos += 1;

        // LEN (little-endian u16)
        std.mem.writeInt(u16, out[pos..][0..2], block_len, .little);
        pos += 2;

        // NLEN (one's complement of LEN)
        std.mem.writeInt(u16, out[pos..][0..2], ~block_len, .little);
        pos += 2;

        // Block data
        if (block_len > 0) {
            @memcpy(out[pos..][0..block_len], input[offset..][0..block_len]);
            pos += block_len;
        }

        offset += block_len;
        if (is_final) break;
    }

    // Adler-32 checksum (big-endian)
    const checksum = adler32(input);
    std.mem.writeInt(u32, out[pos..][0..4], checksum, .big);
    pos += 4;

    return pos;
}

/// Adler-32 checksum as specified in RFC 1950.
fn adler32(data: []const u8) u32 {
    const MOD_ADLER: u32 = 65521;
    var a: u32 = 1;
    var b: u32 = 0;

    // Process in chunks of 5552 to avoid overflow
    // (5552 is the largest n where 255*n*(n+1)/2 + (n+1)*65520 < 2^32)
    var offset: usize = 0;
    while (offset < data.len) {
        const chunk_len = @min(data.len - offset, 5552);
        const chunk = data[offset..][0..chunk_len];

        for (chunk) |byte| {
            a += byte;
            b += a;
        }
        a %= MOD_ADLER;
        b %= MOD_ADLER;

        offset += chunk_len;
    }

    return (b << 16) | a;
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
    // Should produce valid zlib: header(2) + empty stored block(5) + adler32(4) = 11
    try std.testing.expectEqual(@as(usize, 11), comp_len);

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

test "adler32 known values" {
    // RFC 1950 test: adler32("") = 1
    try std.testing.expectEqual(@as(u32, 1), adler32(""));
    // adler32("a") = 0x00620062
    try std.testing.expectEqual(@as(u32, 0x00620062), adler32("a"));
}
