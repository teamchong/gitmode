# gitmode

> **Disclaimer.** Personal open-source project. Not affiliated with, endorsed by, or representative of Cloudflare. Opinions and design decisions are the author's own. See [DISCLAIMER.md](./DISCLAIMER.md) for the full statement.

> **Status: POC for learning.** Proof-of-concept and learning vehicle. Not a product. Packages are not published to npm; there is no launch or roadmap commitment.

POC toolkit exploring how to extend [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) (or any Git remote) with agent-aware capabilities Artifacts itself does not ship: prompt provenance, edge-compute fan-out for diff/grep/walk, and the WASM git primitives that make those fast.

The repository previously hosted a self-hosted Git server. After Cloudflare launched Artifacts in April 2026 with the same architecture, the project pivoted to a toolkit *on top of* Artifacts. See [DESIGN-NOTES.md](./DESIGN-NOTES.md) for the full pivot rationale.

## Packages

| Package | What it does |
|---|---|
| [`@gitmode/prompt-blame`](./packages/prompt-blame) | Worker + D1 schema + CLI for capturing prompt/session/model/agent metadata per commit and querying it back. |
| [`@gitmode/edge-compute-pool`](./packages/edge-compute-pool) | Fan-out compute for git operations on Cloudflare. `PackWorkerDO` slots execute six actions: `build-segment`, `write-worktree`, `diff-blobs`, `grep-blobs`, `walk-trees`, `parse-commits`. |
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

### Building WASM from source

The `.wasm` binaries are committed at `packages/wasm-git/src/wasm/`. Rebuild from the Zig sources at `wasm/`:

```bash
pnpm run build:wasm        # gitmode.wasm (full + libgit2)
pnpm run build:wasm-core   # gitmode-core.wasm (lightweight)
```

Requires Zig 0.15.2, `wasm-metadce`, `wasm-opt`. See the [package README](./packages/wasm-git#building-wasm-from-source) for known build-environment caveats.

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
