// Shared Env type for Cloudflare bindings
export interface Env {
  OBJECTS: R2Bucket;
  REFS: KVNamespace;
  META: D1Database;
  REPO_LOCK: DurableObjectNamespace;
}
