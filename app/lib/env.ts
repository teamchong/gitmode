import type { Env } from "../../src/env";

export type { Env };

export function getEnv(): Env {
  const env = (globalThis as any).__gitmode_env__;
  if (!env) {
    throw new Error("GitMode env not initialized — worker entry must set globalThis.__gitmode_env__");
  }
  return env;
}
