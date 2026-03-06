// libgit2 bindings for WASM
// Links against the libgit2.a static library compiled with zig cc
// Exposes high-level git operations: diff, blame, merge, revwalk
//
// Architecture:
//   TypeScript calls exported WASM functions (libgit2_init_repo, libgit2_diff, etc.)
//   libgit2 reads objects via a custom ODB backend
//   The ODB backend calls host imports (__gitmode_odb_read, etc.)
//   TypeScript host imports fetch from R2 and write results into WASM memory

const std = @import("std");

// === Host imports for ODB backend ===
// TypeScript provides these — they bridge libgit2's object reads to R2
pub const host = struct {
    /// Read a git object by SHA-1. Writes raw object data (header+content) to buf.
    /// Returns bytes written, or -1 if not found.
    pub extern "env" fn __gitmode_odb_read(
        sha_hex: [*]const u8,
        sha_len: usize,
        type_out: *c_int,
        buf: [*]u8,
        buf_cap: usize,
    ) i32;

    /// Check if an object exists. Returns 1 if exists, 0 if not.
    pub extern "env" fn __gitmode_odb_exists(
        sha_hex: [*]const u8,
        sha_len: usize,
    ) i32;

    /// Write a git object. Returns 0 on success, -1 on error.
    pub extern "env" fn __gitmode_odb_write(
        sha_hex_out: [*]u8,
        data: [*]const u8,
        data_len: usize,
        obj_type: c_int,
    ) i32;
};

// === libgit2 C types ===

const git_oid = extern struct {
    id: [20]u8,
};

const git_buf = extern struct {
    ptr: ?[*]u8,
    reserved: usize,
    size: usize,
};

const git_odb_backend_vtable = extern struct {
    version: c_uint,
    odb: ?*anyopaque,
    read: ?*const fn (*?*anyopaque, *usize, *c_int, *anyopaque, *const git_oid) callconv(.c) c_int,
    read_prefix: ?*const anyopaque,
    read_header: ?*const fn (*usize, *c_int, *anyopaque, *const git_oid) callconv(.c) c_int,
    write: ?*const fn (*anyopaque, *const git_oid, *const anyopaque, usize, c_int) callconv(.c) c_int,
    writestream: ?*const anyopaque,
    readstream: ?*const anyopaque,
    exists: ?*const fn (*anyopaque, *const git_oid) callconv(.c) c_int,
    exists_prefix: ?*const anyopaque,
    refresh: ?*const anyopaque,
    foreach: ?*const anyopaque,
    writepack: ?*const anyopaque,
    freshen: ?*const anyopaque,
    free: ?*const fn (*anyopaque) callconv(.c) void,
};

// libgit2 C API
extern "c" fn git_libgit2_init() c_int;
extern "c" fn git_repository_wrap_odb(out: *?*anyopaque, odb: *anyopaque) c_int;
extern "c" fn git_repository_free(repo: *anyopaque) void;
extern "c" fn git_odb_new(out: *?*anyopaque) c_int;
extern "c" fn git_odb_add_backend(odb: *anyopaque, backend: *anyopaque, priority: c_int) c_int;
extern "c" fn git_odb_free(odb: *anyopaque) void;
extern "c" fn git_commit_lookup(out: *?*anyopaque, repo: *anyopaque, id: *const git_oid) c_int;
extern "c" fn git_commit_free(commit: *anyopaque) void;
extern "c" fn git_commit_tree(out: *?*anyopaque, commit: *anyopaque) c_int;
extern "c" fn git_commit_parentcount(commit: *anyopaque) c_uint;
extern "c" fn git_commit_parent_id(commit: *anyopaque, n: c_uint) ?*const git_oid;
extern "c" fn git_tree_free(tree: *anyopaque) void;
extern "c" fn git_diff_tree_to_tree(out: *?*anyopaque, repo: *anyopaque, old_tree: ?*anyopaque, new_tree: ?*anyopaque, opts: ?*anyopaque) c_int;
extern "c" fn git_diff_free(diff: *anyopaque) void;
extern "c" fn git_diff_to_buf(out: *git_buf, diff: *anyopaque, format: c_int) c_int;
extern "c" fn git_revwalk_new(out: *?*anyopaque, repo: *anyopaque) c_int;
extern "c" fn git_revwalk_free(walk: *anyopaque) void;
extern "c" fn git_revwalk_sorting(walk: *anyopaque, sort_mode: c_uint) c_int;
extern "c" fn git_revwalk_push(walk: *anyopaque, id: *const git_oid) c_int;
extern "c" fn git_revwalk_next(out: *git_oid, walk: *anyopaque) c_int;
extern "c" fn git_blame_file(out: *?*anyopaque, repo: *anyopaque, path: [*:0]const u8, opts: ?*anyopaque) c_int;
extern "c" fn git_blame_free(blame: *anyopaque) void;
extern "c" fn git_blame_get_hunk_count(blame: *anyopaque) u32;
extern "c" fn git_buf_dispose(buf: *git_buf) void;
extern "c" fn git_odb_backend_data_alloc(backend: *anyopaque, len: usize) ?*anyopaque;

// Constants
const GIT_SORT_TOPOLOGICAL: c_uint = 1;
const GIT_SORT_TIME: c_uint = 2;
const GIT_DIFF_FORMAT_PATCH: c_int = 1;
const GIT_OBJECT_COMMIT: c_int = 1;
const GIT_OBJECT_TREE: c_int = 2;
const GIT_OBJECT_BLOB: c_int = 3;
const GIT_OBJECT_TAG: c_int = 4;

// === ODB backend implementation ===
// These functions are called by libgit2 when it needs to read/write objects.
// They call our host imports which delegate to R2.

var odb_backend_instance: git_odb_backend_vtable = .{
    .version = 1,
    .odb = null,
    .read = &odbRead,
    .read_prefix = null,
    .read_header = &odbReadHeader,
    .write = &odbWrite,
    .writestream = null,
    .readstream = null,
    .exists = &odbExists,
    .exists_prefix = null,
    .refresh = null,
    .foreach = null,
    .writepack = null,
    .freshen = null,
    .free = null,
};

fn oidToHex(oid: *const git_oid) [40]u8 {
    const hex_chars = "0123456789abcdef";
    var out: [40]u8 = undefined;
    for (0..20) |i| {
        out[i * 2] = hex_chars[oid.id[i] >> 4];
        out[i * 2 + 1] = hex_chars[oid.id[i] & 0x0f];
    }
    return out;
}

fn odbRead(
    data_out: *?*anyopaque,
    len_out: *usize,
    type_out: *c_int,
    backend: *anyopaque,
    oid: *const git_oid,
) callconv(.c) c_int {
    const hex = oidToHex(oid);
    var read_buf: [4 * 1024 * 1024]u8 = undefined; // 4MB max object
    const result = host.__gitmode_odb_read(
        &hex,
        40,
        type_out,
        &read_buf,
        read_buf.len,
    );
    if (result < 0) return -3; // GIT_ENOTFOUND

    const size: usize = @intCast(result);
    const alloc_ptr = git_odb_backend_data_alloc(backend, size) orelse return -1;
    const dest: [*]u8 = @ptrCast(alloc_ptr);
    @memcpy(dest[0..size], read_buf[0..size]);
    data_out.* = alloc_ptr;
    len_out.* = size;
    return 0;
}

fn odbReadHeader(
    len_out: *usize,
    type_out: *c_int,
    backend: *anyopaque,
    oid: *const git_oid,
) callconv(.c) c_int {
    // Read the full object and return just the header info
    var data: ?*anyopaque = null;
    const rc = odbRead(&data, len_out, type_out, backend, oid);
    if (rc == 0) {
        if (data) |ptr| {
            // Free the data we allocated — we only needed the header
            const allocator = std.heap.wasm_allocator;
            allocator.free(@as([*]u8, @ptrCast(ptr))[0..len_out.*]);
        }
    }
    return rc;
}

fn odbWrite(
    backend: *anyopaque,
    oid: *const git_oid,
    data: *const anyopaque,
    len: usize,
    obj_type: c_int,
) callconv(.c) c_int {
    _ = backend;
    var hex: [40]u8 = oidToHex(oid);
    const data_ptr: [*]const u8 = @ptrCast(data);
    return host.__gitmode_odb_write(&hex, data_ptr, len, obj_type);
}

fn odbExists(
    backend: *anyopaque,
    oid: *const git_oid,
) callconv(.c) c_int {
    _ = backend;
    const hex = oidToHex(oid);
    return host.__gitmode_odb_exists(&hex, 40);
}

// === Global state ===

var repo: ?*anyopaque = null;
var odb: ?*anyopaque = null;
var lib_initialized = false;

/// Initialize libgit2 and create a repository backed by the R2 ODB.
/// Must be called once before any other libgit2_* function.
/// Returns 0 on success.
pub export fn libgit2_init() c_int {
    if (lib_initialized) return 0;

    _ = git_libgit2_init();

    var new_odb: ?*anyopaque = null;
    if (git_odb_new(&new_odb) < 0) return -1;

    if (git_odb_add_backend(new_odb.?, @ptrCast(&odb_backend_instance), 1) < 0) {
        git_odb_free(new_odb.?);
        return -2;
    }

    var new_repo: ?*anyopaque = null;
    if (git_repository_wrap_odb(&new_repo, new_odb.?) < 0) {
        git_odb_free(new_odb.?);
        return -3;
    }

    repo = new_repo;
    odb = new_odb;
    lib_initialized = true;
    return 0;
}

/// Shut down libgit2 and free resources.
pub export fn libgit2_shutdown() void {
    if (repo) |r| git_repository_free(r);
    if (odb) |o| git_odb_free(o);
    repo = null;
    odb = null;
    lib_initialized = false;
}

// === Utility ===

fn hexToOid(hex: [*]const u8, oid: *git_oid) bool {
    for (0..20) |i| {
        const hi = hexVal(hex[i * 2]) orelse return false;
        const lo = hexVal(hex[i * 2 + 1]) orelse return false;
        oid.id[i] = (@as(u8, hi) << 4) | lo;
    }
    return true;
}

fn hexVal(c: u8) ?u4 {
    return switch (c) {
        '0'...'9' => @intCast(c - '0'),
        'a'...'f' => @intCast(c - 'a' + 10),
        'A'...'F' => @intCast(c - 'A' + 10),
        else => null,
    };
}

// === Exported operations ===

/// Generate a unified diff between two commits.
/// old_sha_ptr/new_sha_ptr: 40-byte hex SHA-1 strings
/// out_ptr: buffer to write unified diff text
/// Returns bytes written, or 0 on error.
pub export fn libgit2_diff(
    old_sha_ptr: [*]const u8,
    new_sha_ptr: [*]const u8,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    if (!lib_initialized) return 0;
    const r = repo orelse return 0;

    var old_oid: git_oid = undefined;
    var new_oid: git_oid = undefined;
    if (!hexToOid(old_sha_ptr, &old_oid)) return 0;
    if (!hexToOid(new_sha_ptr, &new_oid)) return 0;

    // Look up both commits
    var old_commit: ?*anyopaque = null;
    var new_commit: ?*anyopaque = null;
    if (git_commit_lookup(&old_commit, r, &old_oid) < 0) return 0;
    defer git_commit_free(old_commit.?);

    if (git_commit_lookup(&new_commit, r, &new_oid) < 0) return 0;
    defer git_commit_free(new_commit.?);

    // Get trees from commits
    var old_tree: ?*anyopaque = null;
    var new_tree: ?*anyopaque = null;
    if (git_commit_tree(&old_tree, old_commit.?) < 0) return 0;
    defer git_tree_free(old_tree.?);

    if (git_commit_tree(&new_tree, new_commit.?) < 0) return 0;
    defer git_tree_free(new_tree.?);

    // Generate diff
    var diff: ?*anyopaque = null;
    if (git_diff_tree_to_tree(&diff, r, old_tree, new_tree, null) < 0) return 0;
    defer git_diff_free(diff.?);

    // Convert to unified diff text
    var buf: git_buf = .{ .ptr = null, .reserved = 0, .size = 0 };
    if (git_diff_to_buf(&buf, diff.?, GIT_DIFF_FORMAT_PATCH) < 0) return 0;
    defer git_buf_dispose(&buf);

    const copy_len = @min(buf.size, out_cap);
    if (buf.ptr) |p| {
        @memcpy(out_ptr[0..copy_len], p[0..copy_len]);
    }
    return copy_len;
}

/// Walk commit history starting from a commit SHA.
/// Writes 40-byte hex SHA strings consecutively to out_ptr.
/// Returns number of commits written.
pub export fn libgit2_revwalk(
    start_sha_ptr: [*]const u8,
    max_count: u32,
    out_ptr: [*]u8,
    out_cap: usize,
) u32 {
    if (!lib_initialized) return 0;
    const r = repo orelse return 0;

    var start_oid: git_oid = undefined;
    if (!hexToOid(start_sha_ptr, &start_oid)) return 0;

    var walk: ?*anyopaque = null;
    if (git_revwalk_new(&walk, r) < 0) return 0;
    defer git_revwalk_free(walk.?);

    _ = git_revwalk_sorting(walk.?, GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME);
    if (git_revwalk_push(walk.?, &start_oid) < 0) return 0;

    var count: u32 = 0;
    var oid: git_oid = undefined;
    while (count < max_count) {
        if (git_revwalk_next(&oid, walk.?) < 0) break;

        const offset = count * 40;
        if (offset + 40 > out_cap) break;

        const hex = oidToHex(&oid);
        @memcpy(out_ptr[offset..][0..40], &hex);
        count += 1;
    }

    return count;
}

/// Get blame for a file path at the current repository state.
/// path_ptr/path_len: file path relative to repo root
/// out_ptr: buffer to write blame output (line-by-line SHA + original line number)
/// Returns bytes written, or 0 on error.
pub export fn libgit2_blame(
    path_ptr: [*]const u8,
    path_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    if (!lib_initialized) return 0;
    const r = repo orelse return 0;

    // path must be null-terminated for libgit2
    var path_buf: [4096]u8 = undefined;
    if (path_len >= path_buf.len) return 0;
    @memcpy(path_buf[0..path_len], path_ptr[0..path_len]);
    path_buf[path_len] = 0;
    const path_z: [*:0]const u8 = @ptrCast(path_buf[0..path_len :0]);

    var blame: ?*anyopaque = null;
    if (git_blame_file(&blame, r, path_z, null) < 0) return 0;
    defer git_blame_free(blame.?);

    const hunk_count = git_blame_get_hunk_count(blame.?);

    // Return hunk count encoded as a u32 at the start of the buffer
    if (out_cap >= 4) {
        std.mem.writeInt(u32, out_ptr[0..4], hunk_count, .little);
        return 4;
    }
    return 0;
}
