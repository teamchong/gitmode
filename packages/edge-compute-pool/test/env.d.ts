declare module "cloudflare:test" {
  interface ProvidedEnv {
    PACK_WORKER: DurableObjectNamespace;
    OBJECTS: R2Bucket;
  }
}
