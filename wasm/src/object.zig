// Git object format: blob, tree, commit, tag
//
// Every git object is stored as: "type size\0content"
// The SHA-1 of this full representation is the object ID.

const std = @import("std");
const sha1 = @import("sha1.zig");
const simd = @import("simd.zig");

pub const ObjectType = enum(u8) {
    blob = 1,
    tree = 2,
    commit = 3,
    tag = 4,

    pub fn name(self: ObjectType) []const u8 {
        return switch (self) {
            .blob => "blob",
            .tree => "tree",
            .commit => "commit",
            .tag => "tag",
        };
    }

    pub fn fromName(s: []const u8) !ObjectType {
        if (std.mem.eql(u8, s, "blob")) return .blob;
        if (std.mem.eql(u8, s, "tree")) return .tree;
        if (std.mem.eql(u8, s, "commit")) return .commit;
        if (std.mem.eql(u8, s, "tag")) return .tag;
        return error.UnknownObjectType;
    }
};

pub const ObjectHeader = struct {
    obj_type: ObjectType,
    content_len: usize,
    content_offset: usize, // offset to start of content after \0
};

/// Tree entry as parsed from a tree object.
pub const TreeEntry = extern struct {
    mode: u32,
    name_offset: u32, // offset into original tree data
    name_len: u32,
    sha1: [20]u8,
};

/// Parse a git object header: "type size\0"
pub fn parseHeader(data: []const u8) !ObjectHeader {
    // Find the space separating type from size
    const space_idx = simd.memchr(data, ' ');
    if (space_idx >= data.len) return error.InvalidHeader;

    const type_str = data[0..space_idx];
    const obj_type = try ObjectType.fromName(type_str);

    // Find the null byte
    const null_idx = simd.memchr(data[space_idx + 1 ..], 0);
    if (null_idx >= data.len - space_idx - 1) return error.InvalidHeader;

    const size_str = data[space_idx + 1 ..][0..null_idx];
    const content_len = std.fmt.parseInt(usize, size_str, 10) catch return error.InvalidHeader;
    const content_offset = space_idx + 1 + null_idx + 1;

    return .{
        .obj_type = obj_type,
        .content_len = content_len,
        .content_offset = content_offset,
    };
}

/// Serialize a git object: prepend "type size\0" header.
pub fn serialize(obj_type: ObjectType, content: []const u8, out: []u8) !usize {
    const type_name = obj_type.name();
    var header_buf: [32]u8 = undefined;
    const header = std.fmt.bufPrint(&header_buf, "{s} {d}\x00", .{ type_name, content.len }) catch
        return error.BufferTooSmall;

    const total = header.len + content.len;
    if (total > out.len) return error.BufferTooSmall;

    @memcpy(out[0..header.len], header);
    @memcpy(out[header.len..][0..content.len], content);
    return total;
}

/// Hash a git object (type + content → SHA-1).
pub fn hashObject(obj_type: ObjectType, content: []const u8) [20]u8 {
    // Build "type size\0content" and hash it
    var header_buf: [32]u8 = undefined;
    const header = std.fmt.bufPrint(&header_buf, "{s} {d}\x00", .{ obj_type.name(), content.len }) catch
        unreachable;

    // Two-part hash: header then content
    var h = Sha1Incremental.init();
    h.update(header);
    h.update(content);
    return h.final();
}

/// Incremental SHA-1 for hashing without concatenation.
const Sha1Incremental = struct {
    state: [5]u32 = .{ 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 },
    buf: [64]u8 = undefined,
    buf_len: usize = 0,
    total_len: u64 = 0,

    fn init() Sha1Incremental {
        return .{};
    }

    fn update(self: *Sha1Incremental, data: []const u8) void {
        self.total_len += data.len;
        var offset: usize = 0;

        // Fill partial buffer
        if (self.buf_len > 0) {
            const need = 64 - self.buf_len;
            const take = @min(need, data.len);
            @memcpy(self.buf[self.buf_len..][0..take], data[0..take]);
            self.buf_len += take;
            offset = take;
            if (self.buf_len == 64) {
                processBlock(&self.state, &self.buf);
                self.buf_len = 0;
            }
        }

        // Process full blocks
        while (offset + 64 <= data.len) : (offset += 64) {
            processBlock(&self.state, @ptrCast(data[offset..][0..64]));
        }

        // Buffer remaining
        const remaining = data.len - offset;
        if (remaining > 0) {
            @memcpy(self.buf[0..remaining], data[offset..]);
            self.buf_len = remaining;
        }
    }

    fn final(self: *Sha1Incremental) [20]u8 {
        const total_bits: u64 = self.total_len * 8;

        // Padding
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;

        if (self.buf_len > 56) {
            @memset(self.buf[self.buf_len..], 0);
            processBlock(&self.state, &self.buf);
            self.buf_len = 0;
        }

        @memset(self.buf[self.buf_len..56], 0);
        std.mem.writeInt(u64, self.buf[56..64], total_bits, .big);
        processBlock(&self.state, &self.buf);

        var digest: [20]u8 = undefined;
        for (0..5) |i| {
            std.mem.writeInt(u32, digest[i * 4 ..][0..4], self.state[i], .big);
        }
        return digest;
    }
};

// Import SHA-1 block processing (shared with sha1.zig)
fn processBlock(state: *[5]u32, block: *const [64]u8) void {
    const rotl = struct {
        inline fn f(x: u32, comptime n: u5) u32 {
            return std.math.rotl(u32, x, n);
        }
    }.f;

    var w: [80]u32 = undefined;
    for (0..16) |i| {
        w[i] = std.mem.readInt(u32, block[i * 4 ..][0..4], .big);
    }
    for (16..80) |i| {
        w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    var a = state[0];
    var b = state[1];
    var c = state[2];
    var d = state[3];
    var e = state[4];

    for (0..80) |r| {
        const f_val: u32, const k: u32 = switch (r / 20) {
            0 => .{ (b & c) | (~b & d), 0x5A827999 },
            1 => .{ b ^ c ^ d, 0x6ED9EBA1 },
            2 => .{ (b & c) | (b & d) | (c & d), 0x8F1BBCDC },
            else => .{ b ^ c ^ d, 0xCA62C1D6 },
        };
        const temp = rotl(a, 5) +% f_val +% e +% k +% w[r];
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

/// Parse tree object content into entries.
/// Writes TreeEntry structs to out buffer. Returns number of entries.
pub fn parseTree(data: []const u8, out: []u8) u32 {
    const entry_size = @sizeOf(TreeEntry);
    const max_entries = out.len / entry_size;
    var count: u32 = 0;
    var offset: usize = 0;

    while (offset < data.len and count < max_entries) {
        // Format: "mode name\0<20-byte-sha1>"
        const space = simd.memchr(data[offset..], ' ');
        if (space >= data.len - offset) break;

        const mode_str = data[offset..][0..space];
        const mode = std.fmt.parseInt(u32, mode_str, 8) catch break;

        const name_start = offset + space + 1;
        const null_pos = simd.memchr(data[name_start..], 0);
        if (null_pos >= data.len - name_start) break;

        const sha_start = name_start + null_pos + 1;
        if (sha_start + 20 > data.len) break;

        const entry_ptr: *TreeEntry = @alignCast(@ptrCast(out[count * entry_size ..].ptr));
        entry_ptr.mode = mode;
        entry_ptr.name_offset = @intCast(name_start);
        entry_ptr.name_len = @intCast(null_pos);
        @memcpy(&entry_ptr.sha1, data[sha_start..][0..20]);

        count += 1;
        offset = sha_start + 20;
    }

    return count;
}

/// Build a tree entry: "mode name\0<20-byte-sha1>"
pub fn buildTreeEntry(mode: u32, name: []const u8, sha: [20]u8, out: []u8) !usize {
    var buf: [16]u8 = undefined;
    const mode_str = std.fmt.bufPrint(&buf, "{o}", .{mode}) catch return error.BufferTooSmall;
    const total = mode_str.len + 1 + name.len + 1 + 20;
    if (total > out.len) return error.BufferTooSmall;

    var offset: usize = 0;
    @memcpy(out[offset..][0..mode_str.len], mode_str);
    offset += mode_str.len;
    out[offset] = ' ';
    offset += 1;
    @memcpy(out[offset..][0..name.len], name);
    offset += name.len;
    out[offset] = 0;
    offset += 1;
    @memcpy(out[offset..][0..20], &sha);
    offset += 20;
    return offset;
}

test "parse and serialize object header" {
    const data = "blob 11\x00hello world";
    const header = try parseHeader(data);
    try std.testing.expectEqual(ObjectType.blob, header.obj_type);
    try std.testing.expectEqual(@as(usize, 11), header.content_len);
    try std.testing.expectEqual(@as(usize, 8), header.content_offset);
}

test "hash blob object" {
    const digest = hashObject(.blob, "hello world");
    const hex = sha1.hexDigest(digest);
    try std.testing.expectEqualStrings("95d09f2b10159347eece71399a7e2e907ea3df4f", &hex);
}
