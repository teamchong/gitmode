// RepoLock — Durable Object for atomic ref updates
//
// Each repository gets its own DO instance. This ensures that
// concurrent pushes don't corrupt refs — only one push can
// update refs at a time.
//
// The DO itself holds no persistent state (refs live in KV).
// It exists purely as a distributed mutex.

import type { Env } from "./env";
import { handleReceivePack } from "./receive-pack";
import { GitEngine } from "./git-engine";

export class RepoLock {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const repoPath = request.headers.get("x-repo-path");
    if (!repoPath) {
      return new Response("Missing repo path", { status: 400 });
    }

    const engine = new GitEngine(this.env, repoPath);
    const body = new Uint8Array(await request.arrayBuffer());
    return handleReceivePack(engine, body, this.env, repoPath);
  }
}
