declare module "cloudflare:test" {
  interface ProvidedEnv {
    PACK_WORKER: DurableObjectNamespace;
    OBJECTS: R2Bucket;
    /**
     * Test-only D1 binding used by the cross-package full-pipeline test.
     * Wired in vitest.config.ts → `miniflare.d1Databases`. Production
     * deployments of this package do not need a D1 binding.
     */
    PROMPT_BLAME_DB: D1Database;
  }
}
