// R2 ODB Backend — implements libgit2's git_odb_backend interface
// backed by Cloudflare R2 via host imports.
//
// This replaces libgit2's filesystem-based object storage with R2.
// Each git object is stored as: {repo}/objects/{sha1[0:2]}/{sha1[2:]}
//
// The host (TypeScript Worker) provides these imports:
//   r2_get(key, key_len, buf, buf_cap) -> bytes_read or -1
//   r2_put(key, key_len, data, data_len) -> 0 or -1
//   r2_head(key, key_len) -> size or -1

const std = @import("std");
const sha1_mod = @import("sha1.zig");
const host = @import("main.zig").host;

/// Read a git object from R2.
/// Key format: "{repo}/objects/{sha1_hex[0:2]}/{sha1_hex[2:]}"
pub fn readObject(repo: []const u8, sha1_hex: []const u8, buf: []u8) !usize {
    var key_buf: [256]u8 = undefined;
    const key = formatObjectKey(&key_buf, repo, sha1_hex) orelse return error.KeyTooLong;
    const result = host.r2_get(key.ptr, key.len, buf.ptr, buf.len);
    if (result < 0) return error.ObjectNotFound;
    return @intCast(result);
}

/// Write a git object to R2.
pub fn writeObject(repo: []const u8, sha1_hex: []const u8, data: []const u8) !void {
    var key_buf: [256]u8 = undefined;
    const key = formatObjectKey(&key_buf, repo, sha1_hex) orelse return error.KeyTooLong;
    const result = host.r2_put(key.ptr, key.len, data.ptr, data.len);
    if (result < 0) return error.WriteFailed;
}

/// Check if a git object exists in R2.
pub fn objectExists(repo: []const u8, sha1_hex: []const u8) bool {
    var key_buf: [256]u8 = undefined;
    const key = formatObjectKey(&key_buf, repo, sha1_hex) orelse return false;
    return host.r2_head(key.ptr, key.len) >= 0;
}

/// Read a file from the worktree on R2.
/// Key format: "{repo}/worktrees/{branch}/{path}"
pub fn readWorktreeFile(repo: []const u8, branch: []const u8, path: []const u8, buf: []u8) !usize {
    var key_buf: [1024]u8 = undefined;
    const key = formatWorktreeKey(&key_buf, repo, branch, path) orelse return error.KeyTooLong;
    const result = host.r2_get(key.ptr, key.len, buf.ptr, buf.len);
    if (result < 0) return error.FileNotFound;
    return @intCast(result);
}

/// Write a file to the worktree on R2.
pub fn writeWorktreeFile(repo: []const u8, branch: []const u8, path: []const u8, data: []const u8) !void {
    var key_buf: [1024]u8 = undefined;
    const key = formatWorktreeKey(&key_buf, repo, branch, path) orelse return error.KeyTooLong;
    const result = host.r2_put(key.ptr, key.len, data.ptr, data.len);
    if (result < 0) return error.WriteFailed;
}

fn formatObjectKey(buf: []u8, repo: []const u8, sha1_hex: []const u8) ?[]const u8 {
    if (sha1_hex.len != 40) return null;
    // "{repo}/objects/{xx}/{xxxxxxxx...}"
    const needed = repo.len + "/objects/".len + 2 + 1 + 38;
    if (needed > buf.len) return null;
    var pos: usize = 0;
    @memcpy(buf[pos..][0..repo.len], repo);
    pos += repo.len;
    @memcpy(buf[pos..][0.."/objects/".len], "/objects/");
    pos += "/objects/".len;
    @memcpy(buf[pos..][0..2], sha1_hex[0..2]);
    pos += 2;
    buf[pos] = '/';
    pos += 1;
    @memcpy(buf[pos..][0..38], sha1_hex[2..40]);
    pos += 38;
    return buf[0..pos];
}

fn formatWorktreeKey(buf: []u8, repo: []const u8, branch: []const u8, path: []const u8) ?[]const u8 {
    // "{repo}/worktrees/{branch}/{path}"
    const needed = repo.len + "/worktrees/".len + branch.len + 1 + path.len;
    if (needed > buf.len) return null;
    var pos: usize = 0;
    @memcpy(buf[pos..][0..repo.len], repo);
    pos += repo.len;
    @memcpy(buf[pos..][0.."/worktrees/".len], "/worktrees/");
    pos += "/worktrees/".len;
    @memcpy(buf[pos..][0..branch.len], branch);
    pos += branch.len;
    buf[pos] = '/';
    pos += 1;
    @memcpy(buf[pos..][0..path.len], path);
    pos += path.len;
    return buf[0..pos];
}

test "format object key" {
    var buf: [256]u8 = undefined;
    const key = formatObjectKey(&buf, "alice/myrepo", "95d09f2b10159347eece71399a7e2e907ea3df4f");
    try std.testing.expectEqualStrings("alice/myrepo/objects/95/d09f2b10159347eece71399a7e2e907ea3df4f", key.?);
}

test "format worktree key" {
    var buf: [1024]u8 = undefined;
    const key = formatWorktreeKey(&buf, "alice/myrepo", "main", "src/main.zig");
    try std.testing.expectEqualStrings("alice/myrepo/worktrees/main/src/main.zig", key.?);
}
