# `blame-with-provenance` example

A Worker that exercises the full toolkit composition against any Artifacts repo.

## Endpoint

```
GET /blame?repo=<artifacts-url>&sha=<commit-sha>&path=<file-path>
```

## Flow

```
fetchArtifactsCommit   →   stage commit's transitive closure in R2
       ↓
blameWalk              →   per-line attribution for `path` at `sha`
       ↓
PROMPT_BLAME_DB join   →   enrich each line's commit with { prompt_id, model, agent, session_id }
       ↓
JSON response
```

## Response shape

```json
{
  "repo": "https://x.artifacts.cloudflare.net/git/repo-1.git",
  "sha": "abc123...",
  "path": "src/foo.ts",
  "lines": [
    {
      "lineNumber": 1,
      "line": "export function hello() {",
      "commit": "abc...",
      "prompt_id": "prompt-init",
      "model": "claude-opus-4-7",
      "agent": "claude-code",
      "session_id": "session-A"
    }
  ]
}
```

## Bindings required

```jsonc
{
  "main": "examples/blame-with-provenance/worker.ts",
  "compatibility_flags": ["nodejs_compat"],
  "rules": [{ "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": false }],
  "durable_objects": {
    "bindings": [{ "name": "PACK_WORKER", "class_name": "PackWorkerDO" }]
  },
  "migrations": [{ "tag": "v1", "new_classes": ["PackWorkerDO"] }],
  "r2_buckets": [{ "binding": "OBJECTS", "bucket_name": "your-objects" }],
  "d1_databases": [
    {
      "binding": "PROMPT_BLAME_DB",
      "database_name": "prompt_blame_db",
      "migrations_dir": "../../../prompt-blame/migrations"
    }
  ],
  "vars": {
    "ARTIFACTS_TOKEN": ""
  }
}
```

The Worker also needs to export the `PackWorkerDO` class:

```ts
export { PackWorkerDO } from "@gitmode/edge-compute-pool";
export { default } from "./examples/blame-with-provenance/worker";
```

## Status

Typechecked against the package's exports as part of `pnpm typecheck`. If
the package API drifts (e.g., `fetchArtifactsCommit` parameter shape
changes), this file fails to compile — keeping the documented composition
honest.

Not deployed by default; the package itself is library-only. To deploy
this example, copy the directory into a Worker project and supply the
bindings above.
