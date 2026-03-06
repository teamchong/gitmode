// Server-side checkout — extract files from tree objects and write to R2 worktree
//
// When a push updates a branch, we "checkout" the tree into R2:
//   {repo}/worktrees/{branch}/src/main.zig
//   {repo}/worktrees/{branch}/README.md
//
// This makes files browseable without decompressing git objects on every request.
// The worktree is materialized on R2 — real files, edge-cached, instant access.

const std = @import("std");
const object = @import("object.zig");
const sha1_mod = @import("sha1.zig");
const zlib = @import("zlib.zig");
const r2 = @import("r2_backend.zig");
const simd = @import("simd.zig");
const host = @import("main.zig").host;

/// Result of a checkout operation, returned to the host.
pub const CheckoutResult = struct {
    files_written: u32,
    bytes_written: u64,
};

/// Checkout a commit: resolve commit → tree → walk tree → write files to R2.
/// Called from the TypeScript layer after a successful push.
///
/// The host provides commit data already decompressed. We parse the tree hash
/// from the commit, then recursively walk trees to extract blobs.
export fn checkout_commit(
    repo_ptr: [*]const u8,
    repo_len: usize,
    branch_ptr: [*]const u8,
    branch_len: usize,
    commit_data_ptr: [*]const u8,
    commit_data_len: usize,
    out_files: *u32,
    out_bytes: *u64,
) i32 {
    const repo = repo_ptr[0..repo_len];
    const branch = branch_ptr[0..branch_len];
    const commit_content = commit_data_ptr[0..commit_data_len];

    // Parse tree SHA from commit content
    // Format: "tree <40hex>\n..."
    if (commit_content.len < 45) return -1;
    if (!std.mem.startsWith(u8, commit_content, "tree ")) return -1;

    const tree_hex = commit_content[5..45];

    var result = CheckoutResult{ .files_written = 0, .bytes_written = 0 };
    checkoutTree(repo, branch, tree_hex, "") catch return -1;

    out_files.* = result.files_written;
    out_bytes.* = result.bytes_written;
    _ = &result;
    return 0;
}

/// Recursively walk a tree object and write blobs to R2 worktree.
fn checkoutTree(repo: []const u8, branch: []const u8, tree_hex: []const u8, prefix: []const u8) !void {
    // Read tree object from R2
    var compressed_buf: [1024 * 1024]u8 = undefined; // 1MB max compressed
    const compressed_len = try r2.readObject(repo, tree_hex, &compressed_buf);

    // Decompress
    var raw_buf: [2 * 1024 * 1024]u8 = undefined;
    const raw_len = try zlib.inflate(compressed_buf[0..compressed_len], &raw_buf);

    // Parse object header to get to content
    const header = try object.parseHeader(raw_buf[0..raw_len]);
    const content = raw_buf[header.content_offset..][0..header.content_len];

    // Parse tree entries
    var offset: usize = 0;
    while (offset < content.len) {
        // mode
        const space = simd.memchr(content[offset..], ' ');
        if (space >= content.len - offset) break;
        const mode_str = content[offset..][0..space];
        offset += space + 1;

        // name
        const null_pos = simd.memchr(content[offset..], 0);
        if (null_pos >= content.len - offset) break;
        const name = content[offset..][0..null_pos];
        offset += null_pos + 1;

        // 20-byte SHA
        if (offset + 20 > content.len) break;
        const entry_sha = content[offset..][0..20];
        const entry_hex = sha1_mod.hexDigest(entry_sha.*);
        offset += 20;

        // Build full path
        var path_buf: [1024]u8 = undefined;
        var path_len: usize = 0;
        if (prefix.len > 0) {
            @memcpy(path_buf[0..prefix.len], prefix);
            path_len = prefix.len;
            path_buf[path_len] = '/';
            path_len += 1;
        }
        @memcpy(path_buf[path_len..][0..name.len], name);
        path_len += name.len;
        const full_path = path_buf[0..path_len];

        // Check mode to determine if directory (tree) or file (blob)
        const is_tree = std.mem.eql(u8, mode_str, "40000") or std.mem.eql(u8, mode_str, "040000");

        if (is_tree) {
            // Recurse into subtree
            try checkoutTree(repo, branch, &entry_hex, full_path);
        } else {
            // Read blob and write to worktree
            try checkoutBlob(repo, branch, &entry_hex, full_path);
        }
    }
}

/// Read a blob object from R2 and write its content to the worktree.
fn checkoutBlob(repo: []const u8, branch: []const u8, blob_hex: []const u8, path: []const u8) !void {
    // Read compressed blob from R2
    var compressed_buf: [4 * 1024 * 1024]u8 = undefined; // 4MB max per blob
    const compressed_len = r2.readObject(repo, blob_hex, &compressed_buf) catch return;

    // Decompress
    var raw_buf: [8 * 1024 * 1024]u8 = undefined;
    const raw_len = zlib.inflate(compressed_buf[0..compressed_len], &raw_buf) catch return;

    // Parse header to get content
    const header = object.parseHeader(raw_buf[0..raw_len]) catch return;
    const content = raw_buf[header.content_offset..][0..header.content_len];

    // Write file to worktree
    r2.writeWorktreeFile(repo, branch, path, content) catch return;
}
