const std = @import("std");

pub fn build(b: *std.Build) void {
    // === WASM target for Cloudflare Workers ===
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
        .cpu_features_add = std.Target.wasm.featureSet(&.{.simd128}),
    });

    const optimize = b.standardOptimizeOption(.{});

    const wasm = b.addExecutable(.{
        .name = "gitmode",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = wasm_target,
            .optimize = if (optimize == .Debug) .Debug else .ReleaseSmall,
            .strip = optimize != .Debug,
            .unwind_tables = .none,
            .link_libc = true,
        }),
    });

    wasm.entry = .disabled;
    wasm.rdynamic = true;
    // Stack size: 4MB (libgit2 operations can be deeply recursive)
    wasm.stack_size = 4 * 1024 * 1024;

    // Link libgit2 static library (compiled with zig cc for wasm32-wasi)
    wasm.addObjectFile(b.path("libgit2-wasm/out/libgit2.a"));
    wasm.addIncludePath(b.path("../deps/libgit2/include"));

    const install_wasm = b.addInstallArtifact(wasm, .{});

    const wasm_step = b.step("wasm", "Build WASM module for Cloudflare Workers");
    wasm_step.dependOn(&install_wasm.step);

    // === Native target for testing ===
    const native_target = b.standardTargetOptions(.{});

    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/test_root.zig"),
            .target = native_target,
            .optimize = optimize,
        }),
    });

    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);

    b.default_step = wasm_step;
}
