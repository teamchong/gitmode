// Git packfile format (v2)
//
// Packfile structure:
//   Header: "PACK" + version(4) + num_objects(4)
//   Objects: { type+size(varint) + [delta_ref] + zlib_data }*
//   Trailer: SHA-1 of entire pack content
//
// Object types in packfile:
//   1 = OBJ_COMMIT, 2 = OBJ_TREE, 3 = OBJ_BLOB, 4 = OBJ_TAG
//   6 = OBJ_OFS_DELTA (delta with offset to base)
//   7 = OBJ_REF_DELTA (delta with SHA-1 of base)

const std = @import("std");
const sha1_mod = @import("sha1.zig");
const zlib = @import("zlib.zig");

pub const PackObjectType = enum(u3) {
    commit = 1,
    tree = 2,
    blob = 3,
    tag = 4,
    ofs_delta = 6,
    ref_delta = 7,
};

const PACK_SIGNATURE = "PACK";
const PACK_VERSION: u32 = 2;

/// Parse packfile header. Returns number of objects.
pub fn parseHeader(data: []const u8) !i32 {
    if (data.len < 12) return error.PackTooShort;
    if (!std.mem.eql(u8, data[0..4], PACK_SIGNATURE)) return error.InvalidSignature;

    const version = std.mem.readInt(u32, data[4..8], .big);
    if (version != 2) return error.UnsupportedVersion;

    const num_objects = std.mem.readInt(u32, data[8..12], .big);
    return @intCast(num_objects);
}

/// Parse a packfile entry header at the given offset.
/// Returns type, decompressed size, and header length.
pub fn parseEntryHeader(
    data: []const u8,
    offset: usize,
    out_type: *u8,
    out_size: *u32,
    out_header_len: *u32,
) !i32 {
    if (offset >= data.len) return error.OffsetOutOfBounds;

    var pos = offset;
    const first = data[pos];
    pos += 1;

    const obj_type: u3 = @truncate((first >> 4) & 0x07);
    var size: u32 = @as(u32, first & 0x0f);
    var shift: u5 = 4;

    while (data[pos - 1] & 0x80 != 0) {
        if (pos >= data.len) return error.UnexpectedEnd;
        size |= @as(u32, data[pos] & 0x7f) << shift;
        shift +|= 7;
        pos += 1;
    }

    out_type.* = obj_type;
    out_size.* = size;
    out_header_len.* = @intCast(pos - offset);

    // For ref_delta, account for the 20-byte base SHA-1
    if (obj_type == @intFromEnum(PackObjectType.ref_delta)) {
        out_header_len.* += 20;
    }
    // For ofs_delta, parse the negative offset
    if (obj_type == @intFromEnum(PackObjectType.ofs_delta)) {
        var ofs_bytes: u32 = 0;
        while (pos < data.len) {
            ofs_bytes += 1;
            if (data[pos] & 0x80 == 0) {
                pos += 1;
                break;
            }
            pos += 1;
        }
        out_header_len.* += ofs_bytes;
    }

    return 0;
}

/// Build a packfile from a list of objects.
///
/// Input format (objects_data): repeated entries of:
///   type(1 byte) + sha1(20 bytes) + content_len(4 bytes LE) + content(content_len bytes)
///
/// Returns total packfile size written to out.
pub fn build(
    objects_data: []const u8,
    num_objects: u32,
    out: []u8,
) !usize {
    if (out.len < 12) return error.BufferTooSmall;

    // Write header
    @memcpy(out[0..4], PACK_SIGNATURE);
    std.mem.writeInt(u32, out[4..8], PACK_VERSION, .big);
    std.mem.writeInt(u32, out[8..12], num_objects, .big);

    var out_pos: usize = 12;
    var in_pos: usize = 0;

    var i: u32 = 0;
    while (i < num_objects) : (i += 1) {
        if (in_pos + 25 > objects_data.len) return error.InvalidInput;

        const obj_type = objects_data[in_pos];
        in_pos += 1;

        // Skip SHA-1 (used for index, not needed in pack body)
        in_pos += 20;

        const content_len = std.mem.readInt(u32, objects_data[in_pos..][0..4], .little);
        in_pos += 4;

        if (in_pos + content_len > objects_data.len) return error.InvalidInput;
        const content = objects_data[in_pos..][0..content_len];
        in_pos += content_len;

        // Write type+size header
        out_pos += writeTypeSize(obj_type, content_len, out[out_pos..]);

        // Compress content with zlib
        const compressed_len = try zlib.deflate(content, out[out_pos..]);
        out_pos += compressed_len;
    }

    // Write trailer: SHA-1 of everything before trailer
    if (out_pos + 20 > out.len) return error.BufferTooSmall;
    const digest = sha1_mod.hash(out[0..out_pos]);
    @memcpy(out[out_pos..][0..20], &digest);
    out_pos += 20;

    return out_pos;
}

/// Write the type+size varint header for a pack entry.
fn writeTypeSize(obj_type: u8, size: u32, out: []u8) usize {
    var s = size;
    var pos: usize = 0;

    // First byte: type in bits 6-4, size bits 3-0
    var first: u8 = (@as(u8, obj_type & 0x07) << 4) | @as(u8, @truncate(s & 0x0f));
    s >>= 4;

    if (s > 0) first |= 0x80;
    out[pos] = first;
    pos += 1;

    while (s > 0) {
        var byte: u8 = @truncate(s & 0x7f);
        s >>= 7;
        if (s > 0) byte |= 0x80;
        out[pos] = byte;
        pos += 1;
    }

    return pos;
}

test "parse packfile header" {
    var data: [12]u8 = undefined;
    @memcpy(data[0..4], "PACK");
    std.mem.writeInt(u32, data[4..8], 2, .big);
    std.mem.writeInt(u32, data[8..12], 42, .big);

    const count = try parseHeader(&data);
    try std.testing.expectEqual(@as(i32, 42), count);
}

test "invalid pack signature" {
    var data: [12]u8 = undefined;
    @memcpy(data[0..4], "NOPE");
    std.mem.writeInt(u32, data[4..8], 2, .big);
    std.mem.writeInt(u32, data[8..12], 1, .big);

    try std.testing.expectError(error.InvalidSignature, parseHeader(&data));
}
