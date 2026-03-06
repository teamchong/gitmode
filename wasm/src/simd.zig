// SIMD-accelerated memory operations for WASM SIMD128
//
// Used by SHA-1, delta compression, and object scanning.

const std = @import("std");
const V = @Vector(16, u8);

/// SIMD-accelerated byte search. Returns index of first occurrence, or haystack.len.
pub fn memchr(haystack: []const u8, needle: u8) usize {
    const splat: V = @splat(needle);
    var i: usize = 0;

    // Process 16 bytes at a time with SIMD
    while (i + 16 <= haystack.len) : (i += 16) {
        const chunk: V = haystack[i..][0..16].*;
        const cmp = chunk == splat;
        const mask: u16 = @bitCast(cmp);
        if (mask != 0) {
            return i + @ctz(mask);
        }
    }

    // Scalar tail
    while (i < haystack.len) : (i += 1) {
        if (haystack[i] == needle) return i;
    }
    return haystack.len;
}

/// SIMD-accelerated equality check.
pub fn memeql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var i: usize = 0;

    while (i + 16 <= a.len) : (i += 16) {
        const va: V = a[i..][0..16].*;
        const vb: V = b[i..][0..16].*;
        const cmp = va == vb;
        const mask: u16 = @bitCast(cmp);
        if (mask != 0xFFFF) return false;
    }

    while (i < a.len) : (i += 1) {
        if (a[i] != b[i]) return false;
    }
    return true;
}

/// SIMD-accelerated count of a byte in buffer.
pub fn memcount(data: []const u8, needle: u8) usize {
    const splat: V = @splat(needle);
    const zero: @Vector(16, u8) = @splat(0);
    const one: @Vector(16, u8) = @splat(1);
    var count: usize = 0;
    var i: usize = 0;

    // Accumulate in batches of 255*16 to avoid overflow in u8 accumulators
    while (i + 16 <= data.len) {
        var accum: @Vector(16, u8) = zero;
        const batch_end = @min(i + 255 * 16, data.len & ~@as(usize, 15));
        while (i + 16 <= batch_end) : (i += 16) {
            const chunk: V = data[i..][0..16].*;
            const cmp = chunk == splat;
            accum += @select(u8, cmp, one, zero);
        }
        // Horizontal sum
        for (0..16) |lane| {
            count += accum[lane];
        }
    }

    while (i < data.len) : (i += 1) {
        if (data[i] == needle) count += 1;
    }
    return count;
}

/// SIMD-accelerated hash for rolling window (used in delta index).
/// Computes a simple hash of 4-byte windows, writing results to out.
pub fn hashWindows4(data: []const u8, out: []u32) void {
    if (data.len < 4) return;
    const n = data.len - 3;
    const count = @min(n, out.len);
    var i: usize = 0;

    // Scalar — the hash is simple enough that SIMD doesn't help much
    // for 4-byte windows, but we unroll for speed.
    while (i + 4 <= count) : (i += 4) {
        inline for (0..4) |k| {
            const off = i + k;
            out[off] = @as(u32, data[off]) |
                (@as(u32, data[off + 1]) << 8) |
                (@as(u32, data[off + 2]) << 16) |
                (@as(u32, data[off + 3]) << 24);
        }
    }
    while (i < count) : (i += 1) {
        out[i] = @as(u32, data[i]) |
            (@as(u32, data[i + 1]) << 8) |
            (@as(u32, data[i + 2]) << 16) |
            (@as(u32, data[i + 3]) << 24);
    }
}

test "memchr finds byte" {
    const data = "hello world";
    try std.testing.expectEqual(@as(usize, 4), memchr(data, 'o'));
    try std.testing.expectEqual(data.len, memchr(data, 'z'));
}

test "memeql" {
    const a = "hello world!!!!!";
    const b = "hello world!!!!!";
    const c = "hello world!!!!?";
    try std.testing.expect(memeql(a, b));
    try std.testing.expect(!memeql(a, c));
}

test "memcount" {
    const data = "aababaaab";
    try std.testing.expectEqual(@as(usize, 6), memcount(data, 'a'));
}
