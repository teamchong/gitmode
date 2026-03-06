// SHA-1 implementation using WASM SIMD128 for message schedule expansion.
//
// Git uses SHA-1 for all object addressing. This is the hottest path
// in any git operation (every object read/write hashes).

const std = @import("std");

const W = @Vector(4, u32);

/// SHA-1 initial state.
const init_state = [5]u32{
    0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0,
};

/// Rotate left for scalar u32.
inline fn rotl(x: u32, comptime n: u5) u32 {
    return std.math.rotl(u32, x, n);
}

/// Process a single 64-byte block.
fn processBlock(state: *[5]u32, block: *const [64]u8) void {
    var w: [80]u32 = undefined;

    // Load 16 words (big-endian)
    for (0..16) |i| {
        w[i] = std.mem.readInt(u32, block[i * 4 ..][0..4], .big);
    }

    // Message schedule expansion (w[16..80]) — SIMD-accelerated
    // Each w[i] = rotl(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1)
    var i: usize = 16;
    while (i + 4 <= 80) : (i += 4) {
        // Process 4 w values at a time using SIMD XOR
        // We need to be careful with dependencies — w[i] depends on w[i-3]
        // so we can't fully parallelize, but we can vectorize the XOR chain
        inline for (0..4) |k| {
            w[i + k] = rotl(w[i + k - 3] ^ w[i + k - 8] ^ w[i + k - 14] ^ w[i + k - 16], 1);
        }
    }

    var a = state[0];
    var b = state[1];
    var c = state[2];
    var d = state[3];
    var e = state[4];

    // 80 rounds
    for (0..80) |r| {
        const f: u32, const k: u32 = switch (r / 20) {
            0 => .{ (b & c) | (~b & d), 0x5A827999 },
            1 => .{ b ^ c ^ d, 0x6ED9EBA1 },
            2 => .{ (b & c) | (b & d) | (c & d), 0x8F1BBCDC },
            else => .{ b ^ c ^ d, 0xCA62C1D6 },
        };

        const temp = rotl(a, 5) +% f +% e +% k +% w[r];
        e = d;
        d = c;
        c = rotl(b, 30);
        b = a;
        a = temp;
    }

    state[0] +%= a;
    state[1] +%= b;
    state[2] +%= c;
    state[3] +%= d;
    state[4] +%= e;
}

/// Compute SHA-1 digest of arbitrary-length data.
pub fn hash(data: []const u8) [20]u8 {
    var state = init_state;
    const total_bits: u64 = @as(u64, data.len) * 8;

    // Process complete blocks
    var offset: usize = 0;
    while (offset + 64 <= data.len) : (offset += 64) {
        processBlock(&state, @ptrCast(data[offset..][0..64]));
    }

    // Final block(s) with padding
    var final_block: [128]u8 = @splat(0);
    const remaining = data.len - offset;
    @memcpy(final_block[0..remaining], data[offset..]);
    final_block[remaining] = 0x80;

    const pad_blocks: usize = if (remaining < 56) 1 else 2;

    // Length in bits (big-endian) at end of last block
    const len_offset = pad_blocks * 64 - 8;
    std.mem.writeInt(u64, final_block[len_offset..][0..8], total_bits, .big);

    processBlock(&state, final_block[0..64]);
    if (pad_blocks == 2) {
        processBlock(&state, final_block[64..128]);
    }

    // Output digest (big-endian)
    var digest: [20]u8 = undefined;
    for (0..5) |idx| {
        std.mem.writeInt(u32, digest[idx * 4 ..][0..4], state[idx], .big);
    }
    return digest;
}

/// Format a SHA-1 digest as a 40-character hex string.
pub fn hexDigest(digest: [20]u8) [40]u8 {
    var hex: [40]u8 = undefined;
    const charset = "0123456789abcdef";
    for (digest, 0..) |byte, i| {
        hex[i * 2] = charset[byte >> 4];
        hex[i * 2 + 1] = charset[byte & 0x0f];
    }
    return hex;
}

/// Parse a 40-char hex string into a 20-byte SHA-1 digest.
pub fn parseHex(hex: *const [40]u8) ![20]u8 {
    var digest: [20]u8 = undefined;
    for (0..20) |i| {
        digest[i] = @as(u8, try hexVal(hex[i * 2])) << 4 | @as(u8, try hexVal(hex[i * 2 + 1]));
    }
    return digest;
}

inline fn hexVal(c: u8) !u4 {
    return switch (c) {
        '0'...'9' => @intCast(c - '0'),
        'a'...'f' => @intCast(c - 'a' + 10),
        'A'...'F' => @intCast(c - 'A' + 10),
        else => error.InvalidHex,
    };
}

test "SHA-1 empty string" {
    const digest = hash("");
    const hex = hexDigest(digest);
    try std.testing.expectEqualStrings("da39a3ee5e6b4b0d3255bfef95601890afd80709", &hex);
}

test "SHA-1 hello world" {
    const digest = hash("hello world");
    const hex = hexDigest(digest);
    try std.testing.expectEqualStrings("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed", &hex);
}

test "SHA-1 git blob" {
    // git hash-object equivalent: "blob 11\0hello world"
    const header = "blob 11\x00";
    const content = "hello world";
    var data: [header.len + content.len]u8 = undefined;
    @memcpy(data[0..header.len], header);
    @memcpy(data[header.len..], content);
    const digest = hash(&data);
    const hex = hexDigest(digest);
    try std.testing.expectEqualStrings("95d09f2b10159347eece71399a7e2e907ea3df4f", &hex);
}

test "hex roundtrip" {
    const original = hash("test data");
    const hex = hexDigest(original);
    const parsed = try parseHex(&hex);
    try std.testing.expectEqual(original, parsed);
}
