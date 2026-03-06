// Test root that excludes modules with host imports (r2_backend, checkout)
// Those modules require WASM host imports that don't exist in native builds.

test {
    _ = @import("object.zig");
    _ = @import("sha1.zig");
    _ = @import("pack.zig");
    _ = @import("delta.zig");
    _ = @import("zlib.zig");
    _ = @import("protocol.zig");
    _ = @import("simd.zig");
}
