// Git delta compression/decompression
//
// Git packfiles use delta encoding to reduce storage: instead of storing
// two similar blobs, store one base + a delta (copy/insert instructions).
//
// Delta format:
//   - Base object size (variable-length int)
//   - Result object size (variable-length int)
//   - Instructions:
//     - Copy:   high bit set. Lower bits encode offset/size fields.
//     - Insert: high bit clear. Value = number of literal bytes following.

const std = @import("std");
const simd = @import("simd.zig");

/// Read a variable-length size encoding used in delta headers.
fn readSize(data: []const u8, pos: *usize) !usize {
    var result: usize = 0;
    var shift: u32 = 0;
    while (pos.* < data.len) {
        const byte = data[pos.*];
        pos.* += 1;
        const shift5: u5 = @intCast(@min(shift, 31));
        result |= @as(usize, byte & 0x7f) << shift5;
        if (byte & 0x80 == 0) return result;
        shift += 7;
        if (shift > 28) return error.DeltaSizeTooLarge;
    }
    return error.UnexpectedEnd;
}

/// Apply a delta to a base object, producing the result.
pub fn apply(base: []const u8, delta_data: []const u8, out: []u8) !usize {
    var pos: usize = 0;

    // Read base size (for validation)
    const base_size = try readSize(delta_data, &pos);
    if (base_size != base.len) return error.BaseSizeMismatch;

    // Read result size
    const result_size = try readSize(delta_data, &pos);
    if (result_size > out.len) return error.BufferTooSmall;

    var out_pos: usize = 0;

    while (pos < delta_data.len) {
        const cmd = delta_data[pos];
        pos += 1;

        if (cmd & 0x80 != 0) {
            // Copy instruction: copy from base
            var offset: usize = 0;
            var size: usize = 0;

            if (cmd & 0x01 != 0) {
                offset |= @as(usize, delta_data[pos]);
                pos += 1;
            }
            if (cmd & 0x02 != 0) {
                offset |= @as(usize, delta_data[pos]) << 8;
                pos += 1;
            }
            if (cmd & 0x04 != 0) {
                offset |= @as(usize, delta_data[pos]) << 16;
                pos += 1;
            }
            if (cmd & 0x08 != 0) {
                offset |= @as(usize, delta_data[pos]) << 24;
                pos += 1;
            }

            if (cmd & 0x10 != 0) {
                size |= @as(usize, delta_data[pos]);
                pos += 1;
            }
            if (cmd & 0x20 != 0) {
                size |= @as(usize, delta_data[pos]) << 8;
                pos += 1;
            }
            if (cmd & 0x40 != 0) {
                size |= @as(usize, delta_data[pos]) << 16;
                pos += 1;
            }

            if (size == 0) size = 0x10000;

            if (offset + size > base.len) return error.CopyOutOfBounds;
            if (out_pos + size > out.len) return error.BufferTooSmall;

            @memcpy(out[out_pos..][0..size], base[offset..][0..size]);
            out_pos += size;
        } else if (cmd > 0) {
            // Insert instruction: literal bytes
            const size: usize = cmd;
            if (pos + size > delta_data.len) return error.UnexpectedEnd;
            if (out_pos + size > out.len) return error.BufferTooSmall;

            @memcpy(out[out_pos..][0..size], delta_data[pos..][0..size]);
            pos += size;
            out_pos += size;
        } else {
            return error.InvalidDeltaCommand;
        }
    }

    if (out_pos != result_size) return error.ResultSizeMismatch;
    return out_pos;
}

/// Write a variable-length size.
fn writeSize(val: usize, out: []u8) !usize {
    var v = val;
    var pos: usize = 0;
    while (true) {
        if (pos >= out.len) return error.BufferTooSmall;
        var byte: u8 = @truncate(v & 0x7f);
        v >>= 7;
        if (v > 0) byte |= 0x80;
        out[pos] = byte;
        pos += 1;
        if (v == 0) break;
    }
    return pos;
}

/// Create a delta from base → target.
/// Uses a hash index on the base for finding copy regions.
pub fn create(base: []const u8, target: []const u8, out: []u8) !usize {
    var pos: usize = 0;

    // Write header sizes
    pos += try writeSize(base.len, out[pos..]);
    pos += try writeSize(target.len, out[pos..]);

    // Build a simple hash index on the base (4-byte windows)
    const Index = struct {
        const HASH_SIZE = 1 << 14; // 16K entries
        entries: [HASH_SIZE]Entry = @splat(.{ .offset = 0, .valid = false }),

        const Entry = struct { offset: u32, valid: bool };

        fn hashKey(data: []const u8) u14 {
            const h = @as(u32, data[0]) |
                (@as(u32, data[1]) << 8) |
                (@as(u32, data[2]) << 16) |
                (@as(u32, data[3]) << 24);
            return @truncate(h ^ (h >> 14));
        }

        fn insert(self: *@This(), data: []const u8, offset: u32) void {
            const key = hashKey(data);
            self.entries[key] = .{ .offset = offset, .valid = true };
        }

        fn lookup(self: *const @This(), data: []const u8) ?u32 {
            const key = hashKey(data);
            const e = self.entries[key];
            return if (e.valid) e.offset else null;
        }
    };

    var index = Index{};

    // Index the base in 4-byte steps
    if (base.len >= 4) {
        var i: u32 = 0;
        while (i + 4 <= base.len) : (i += 4) {
            index.insert(base[i..][0..4], i);
        }
    }

    // Scan the target, trying to find matches in the base
    var t: usize = 0;
    var insert_start: usize = 0;

    while (t < target.len) {
        var best_offset: usize = 0;
        var best_len: usize = 0;

        // Try to find a match
        if (t + 4 <= target.len) {
            if (index.lookup(target[t..][0..4])) |base_off| {
                // Extend match forward using SIMD comparison
                var match_len: usize = 0;
                const max_match = @min(base.len - base_off, target.len - t);

                // Use SIMD for fast comparison in 16-byte chunks
                while (match_len + 16 <= max_match) {
                    const a: @Vector(16, u8) = base[base_off + match_len ..][0..16].*;
                    const b: @Vector(16, u8) = target[t + match_len ..][0..16].*;
                    const cmp = a == b;
                    const mask: u16 = @bitCast(cmp);
                    if (mask != 0xFFFF) {
                        // Find first mismatch
                        match_len += @ctz(~mask);
                        break;
                    }
                    match_len += 16;
                } else {
                    // Scalar tail
                    while (match_len < max_match and
                        base[base_off + match_len] == target[t + match_len])
                    {
                        match_len += 1;
                    }
                }

                if (match_len >= 4) {
                    best_offset = base_off;
                    best_len = match_len;
                }
            }
        }

        if (best_len >= 4) {
            // Flush pending insert
            if (t > insert_start) {
                pos += try emitInsert(target[insert_start..t], out[pos..]);
            }
            // Emit copy
            pos += try emitCopy(best_offset, best_len, out[pos..]);
            t += best_len;
            insert_start = t;
        } else {
            t += 1;
        }
    }

    // Flush remaining insert
    if (target.len > insert_start) {
        pos += try emitInsert(target[insert_start..target.len], out[pos..]);
    }

    return pos;
}

fn emitInsert(data: []const u8, out: []u8) !usize {
    var pos: usize = 0;
    var offset: usize = 0;
    while (offset < data.len) {
        const chunk = @min(data.len - offset, 127);
        if (pos >= out.len) return error.BufferTooSmall;
        out[pos] = @intCast(chunk);
        pos += 1;
        if (pos + chunk > out.len) return error.BufferTooSmall;
        @memcpy(out[pos..][0..chunk], data[offset..][0..chunk]);
        pos += chunk;
        offset += chunk;
    }
    return pos;
}

fn emitCopy(offset: usize, size: usize, out: []u8) !usize {
    if (out.len < 1) return error.BufferTooSmall;
    var cmd: u8 = 0x80;
    var extra: [7]u8 = undefined;
    var extra_len: usize = 0;

    // Encode offset bytes
    if (offset & 0xFF != 0) {
        cmd |= 0x01;
        extra[extra_len] = @truncate(offset);
        extra_len += 1;
    }
    if (offset & 0xFF00 != 0) {
        cmd |= 0x02;
        extra[extra_len] = @truncate(offset >> 8);
        extra_len += 1;
    }
    if (offset & 0xFF0000 != 0) {
        cmd |= 0x04;
        extra[extra_len] = @truncate(offset >> 16);
        extra_len += 1;
    }
    if (offset & 0xFF000000 != 0) {
        cmd |= 0x08;
        extra[extra_len] = @truncate(offset >> 24);
        extra_len += 1;
    }

    // Encode size bytes (0 means 0x10000)
    const s: usize = if (size == 0x10000) 0 else size;
    if (s & 0xFF != 0) {
        cmd |= 0x10;
        extra[extra_len] = @truncate(s);
        extra_len += 1;
    }
    if (s & 0xFF00 != 0) {
        cmd |= 0x20;
        extra[extra_len] = @truncate(s >> 8);
        extra_len += 1;
    }
    if (s & 0xFF0000 != 0) {
        cmd |= 0x40;
        extra[extra_len] = @truncate(s >> 16);
        extra_len += 1;
    }

    if (1 + extra_len > out.len) return error.BufferTooSmall;
    out[0] = cmd;
    @memcpy(out[1..][0..extra_len], extra[0..extra_len]);
    return 1 + extra_len;
}

test "delta apply simple" {
    const base = "hello world";
    // Build a delta manually: copy "hello " from base, insert "zig"
    var delta_buf: [64]u8 = undefined;
    var pos: usize = 0;

    // Base size
    delta_buf[pos] = 11; // "hello world".len
    pos += 1;
    // Result size
    delta_buf[pos] = 9; // "hello zig".len
    pos += 1;

    // Copy: offset=0, size=6 ("hello ")
    delta_buf[pos] = 0x80 | 0x01 | 0x10; // copy with offset byte + size byte
    pos += 1;
    delta_buf[pos] = 0; // offset = 0
    pos += 1;
    delta_buf[pos] = 6; // size = 6
    pos += 1;

    // Insert: "zig"
    delta_buf[pos] = 3; // insert 3 bytes
    pos += 1;
    @memcpy(delta_buf[pos..][0..3], "zig");
    pos += 3;

    var result: [64]u8 = undefined;
    const result_len = try apply(base, delta_buf[0..pos], &result);
    try std.testing.expectEqualStrings("hello zig", result[0..result_len]);
}

test "delta create and apply roundtrip" {
    const base = "the quick brown fox jumps over the lazy dog";
    const target = "the quick brown cat jumps over the lazy dog";

    var delta_buf: [256]u8 = undefined;
    const delta_len = try create(base, target, &delta_buf);

    var result: [256]u8 = undefined;
    const result_len = try apply(base, delta_buf[0..delta_len], &result);
    try std.testing.expectEqualStrings(target, result[0..result_len]);
}
