import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// The `deps.optimizer.ssr.include` ensures pnpm-symlinked workspace packages
// containing .wasm imports (here, @gitmode/wasm-git) get pre-bundled by Vite
// so workerd can resolve them. Without this, cross-package .wasm imports fail
// with "No such module ... ?mf_vitest_force=CompiledWasm". See
// https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution
export default defineWorkersConfig({
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@gitmode/wasm-git"],
        },
      },
    },
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
