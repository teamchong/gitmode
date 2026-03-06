// Git Smart HTTP protocol helpers
//
// The protocol uses "pkt-line" framing:
//   - 4 hex digits for length (includes the 4 digits themselves)
//   - "0000" = flush packet (end of section)
//   - "0001" = delimiter packet
//   - "0002" = response-end packet
//
// Endpoints:
//   GET  /info/refs?service=git-upload-pack   → ref advertisement
//   POST /git-upload-pack                     → packfile negotiation
//   POST /git-receive-pack                    → push

const std = @import("std");
const sha1_mod = @import("sha1.zig");

/// Encode a pkt-line: prepend 4-hex-digit length.
/// Length includes the 4 digits themselves.
pub fn encodePktLine(data: []const u8, out: []u8) !usize {
    const total_len = data.len + 4;
    if (total_len > 65535) return error.PayloadTooLarge;
    if (out.len < total_len) return error.BufferTooSmall;

    // Write 4-char hex length
    const hex = "0123456789abcdef";
    out[0] = hex[(total_len >> 12) & 0xf];
    out[1] = hex[(total_len >> 8) & 0xf];
    out[2] = hex[(total_len >> 4) & 0xf];
    out[3] = hex[total_len & 0xf];

    @memcpy(out[4..][0..data.len], data);
    return total_len;
}

/// Decode a pkt-line at offset. Returns payload length.
/// Writes payload start offset to out_payload_offset.
/// Returns 0 for flush packet, -1 for error.
pub fn decodePktLine(data: []const u8, offset: usize, out_payload_offset: *usize) !i32 {
    if (offset + 4 > data.len) return error.UnexpectedEnd;

    const len_hex = data[offset..][0..4];

    // Check for special packets
    if (std.mem.eql(u8, len_hex, "0000")) {
        out_payload_offset.* = offset + 4;
        return 0; // flush
    }
    if (std.mem.eql(u8, len_hex, "0001")) {
        out_payload_offset.* = offset + 4;
        return -2; // delimiter
    }
    if (std.mem.eql(u8, len_hex, "0002")) {
        out_payload_offset.* = offset + 4;
        return -3; // response-end
    }

    const total_len = parseHexLen(len_hex) orelse return error.InvalidPktLine;
    if (total_len < 4) return error.InvalidPktLine;

    const payload_len: usize = total_len - 4;
    out_payload_offset.* = offset + 4;

    if (offset + total_len > data.len) return error.UnexpectedEnd;

    return @intCast(payload_len);
}

fn parseHexLen(hex: *const [4]u8) ?usize {
    var result: usize = 0;
    for (hex) |c| {
        const val: usize = switch (c) {
            '0'...'9' => c - '0',
            'a'...'f' => c - 'a' + 10,
            'A'...'F' => c - 'A' + 10,
            else => return null,
        };
        result = (result << 4) | val;
    }
    return result;
}

/// Format a ref advertisement line:
/// "<sha1-hex> <refname>\n"
pub fn formatRefLine(sha1_hex: []const u8, refname: []const u8, out: []u8) !usize {
    // sha1(40) + space(1) + refname + newline(1)
    const line_len = 40 + 1 + refname.len + 1;
    if (sha1_hex.len != 40) return error.InvalidSha1;

    // Encode as pkt-line
    var line_buf: [1024]u8 = undefined;
    if (line_len > line_buf.len) return error.RefNameTooLong;

    @memcpy(line_buf[0..40], sha1_hex);
    line_buf[40] = ' ';
    @memcpy(line_buf[41..][0..refname.len], refname);
    line_buf[41 + refname.len] = '\n';

    return encodePktLine(line_buf[0..line_len], out);
}

/// Write a flush packet ("0000").
pub fn writeFlush(out: []u8) !usize {
    if (out.len < 4) return error.BufferTooSmall;
    @memcpy(out[0..4], "0000");
    return 4;
}

/// Parse a "want" or "have" line from upload-pack negotiation.
/// Returns the SHA-1 hex string (40 chars).
pub const WantHave = struct {
    kind: enum { want, have },
    sha1_hex: [40]u8,
};

pub fn parseWantHave(line: []const u8) !WantHave {
    if (line.len < 45) return error.LineTooShort; // "want " + 40 hex

    var result: WantHave = undefined;

    if (std.mem.startsWith(u8, line, "want ")) {
        result.kind = .want;
        @memcpy(&result.sha1_hex, line[5..45]);
    } else if (std.mem.startsWith(u8, line, "have ")) {
        result.kind = .have;
        @memcpy(&result.sha1_hex, line[5..45]);
    } else {
        return error.InvalidWantHave;
    }

    return result;
}

test "pkt-line encode/decode" {
    var buf: [256]u8 = undefined;
    const encoded_len = try encodePktLine("# service=git-upload-pack\n", &buf);
    try std.testing.expectEqual(@as(usize, 30), encoded_len);
    try std.testing.expectEqualStrings("001e", buf[0..4]);

    var payload_offset: usize = undefined;
    const payload_len = try decodePktLine(&buf, 0, &payload_offset);
    try std.testing.expectEqual(@as(i32, 26), payload_len);
    try std.testing.expectEqual(@as(usize, 4), payload_offset);
}

test "flush packet" {
    var buf: [4]u8 = undefined;
    const len = try writeFlush(&buf);
    try std.testing.expectEqual(@as(usize, 4), len);

    var offset: usize = undefined;
    const result = try decodePktLine(&buf, 0, &offset);
    try std.testing.expectEqual(@as(i32, 0), result);
}

test "parse want line" {
    const line = "want 95d09f2b10159347eece71399a7e2e907ea3df4f\n";
    const wh = try parseWantHave(line);
    try std.testing.expectEqual(.want, wh.kind);
    try std.testing.expectEqualStrings("95d09f2b10159347eece71399a7e2e907ea3df4f", &wh.sha1_hex);
}
