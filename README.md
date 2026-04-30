# gitmode

> **Disclaimer.** Personal open-source project. Not affiliated with, endorsed by, or representative of Cloudflare. Opinions and design decisions are the author's own. See [DISCLAIMER.md](./DISCLAIMER.md) for the full statement.

> **Status: POC for learning.** Proof-of-concept and learning vehicle. Not a product. Packages are not published to npm; there is no launch or roadmap commitment.

POC toolkit exploring how to extend [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) (or any Git remote) with agent-aware capabilities Artifacts itself does not ship: prompt provenance, edge-compute fan-out for diff/grep/walk, and the WASM git primitives that make those fast.

The repository previously hosted a self-hosted Git server. After Cloudflare launched Artifacts in April 2026 with the same architecture, the project pivoted to a toolkit *on top of* Artifacts. See [DESIGN-NOTES.md](./DESIGN-NOTES.md) for the full pivot rationale.

## Packages

| Package | What it does |
|---|---|
| [`@gitmode/prompt-blame`](./packages/prompt-blame) | Worker + D1 schema + CLI for capturing prompt/session/model/agent metadata per commit and querying it back. |
| [`@gitmode/edge-compute-pool`](./packages/edge-compute-pool) | Fan-out compute for git operations on Cloudflare. `PackWorkerDO` slots execute seven actions: `build-segment`, `write-worktree`, `diff-blobs`, `grep-blobs`, `walk-trees`, `parse-commits`, `read-blobs`. Three coordinators (`mergeBase`, `logWalk`, `blameWalk`) demonstrate composition. End-to-end Artifacts integration via `fetchArtifactsCommit` (Git smart HTTP + packfile unpack). |
| [`@gitmode/wasm-git`](./packages/wasm-git) | Zig+WASM engine for git primitives (SHA-1 SIMD128, libdeflate, delta, packfile). |

## R&D bets

Two open lines, both targeting gaps in the agent-native git story:

1. **Prompt-blame primitives.** As more code is AI-generated, `git blame` answers "who" but not "which prompt." `@gitmode/prompt-blame` provides the sidecar so any client (Claude Code, Cursor, Copilot, etc.) can record provenance at commit time and any reviewer can query it back. Composes with [timeline](https://github.com/teamchong/timeline) (local snapshot capture).
2. **Edge compute pool.** Artifacts ships repo storage but not compute primitives. `git log -S "TODO"` over a million commits is slow because it's serial. The pool fans BFS history walks across Durable Object slots — each slot is a ~128MB compute unit reading from R2 directly.

## Quick start

```bash
pnpm install

# Run all package tests
pnpm test

# Typecheck everything
pnpm typecheck
```

Each package ships its own `wrangler.jsonc`, `vitest.config.ts`, and migrations. See the package READMEs for usage.

### prompt-blame end-to-end

```bash
cd packages/prompt-blame

# Apply local D1 migrations
pnpm db:migrate:local

# Start the Worker on localhost:8787
pnpm dev

# In another shell — record metadata for the latest commit
node bin/prompt-blame.mjs post --agent=claude-code --session-id=demo

# Query it back
node bin/prompt-blame.mjs get
```

### Full toolkit composing against an Artifacts repo

```ts
import { WasmEngine } from "@gitmode/wasm-git";
import {
  fetchArtifactsCommit,
  discoverArtifactsRefs,
  blameWalk,
} from "@gitmode/edge-compute-pool";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const wasm = await WasmEngine.create();
    const url = "https://x.artifacts.cloudflare.net/git/repo-1.git";

    // 1. Resolve a branch to its tip
    const adv = await discoverArtifactsRefs({ artifactsUrl: url, token: env.ARTIFACTS_TOKEN });
    const headSha = adv.refs.get("refs/heads/main")!;

    // 2. Stage that commit's transitive closure in R2
    await fetchArtifactsCommit({
      artifactsUrl: url,
      token: env.ARTIFACTS_TOKEN,
      commitSha: headSha,
      repoPath: "repo-1",
      bucket: env.OBJECTS,
      wasm,
    });

    // 3. Blame a file using the staged objects
    const lookup = (sha: string) => ({ looseKey: `repo-1/loose/${sha}` });
    const blame = await blameWalk({
      startSha: headSha,
      filePath: "src/index.ts",
      repoPath: "repo-1",
      lookup,
      pool: env.PACK_WORKER,
    });

    // 4. (optionally) enrich each line's commit with prompt-blame provenance
    //    by querying the @gitmode/prompt-blame Worker for { prompt_id, agent, session }.

    return Response.json({ blame });
  },
};
```

### Building WASM from source

The `.wasm` binaries are committed at `packages/wasm-git/src/wasm/`. Rebuild from the Zig sources at `wasm/`:

```bash
pnpm run build:wasm        # gitmode.wasm (full + libgit2)
pnpm run build:wasm-core   # gitmode-core.wasm (lightweight)
```

Requires Zig 0.16, `wasm-metadce`, `wasm-opt`. See the [package README](./packages/wasm-git#building-wasm-from-source) for build details.

## Project structure

```
gitmode/
├── packages/                       # the toolkit (pnpm workspace)
│   ├── prompt-blame/               # Worker + CLI + D1 schema
│   ├── edge-compute-pool/          # PackWorkerDO + dispatchToPool
│   └── wasm-git/                   # Zig WASM engines
├── wasm/                           # Zig source for the WASM engines
├── deps/libgit2/                   # libgit2 source for the full module
├── docs/                           # Astro Starlight documentation site (mid-rewrite for the pivot)
├── DESIGN-NOTES.md                 # pivot strategy + open R&D questions
├── DISCLAIMER.md                   # personal-OSS / no-CF-affiliation statement
└── pnpm-workspace.yaml
```

## License

MIT. See [LICENSE](./LICENSE).
