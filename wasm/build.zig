const std = @import("std");

pub fn build(b: *std.Build) void {
    // === WASM target for Cloudflare Workers ===
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
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
        }),
    });

    wasm.entry = .disabled;
    wasm.rdynamic = true;
    // Stack size: 1MB (git operations can be recursive for tree walking)
    wasm.stack_size = 1024 * 1024;

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
