#!/usr/bin/env node
// Bridge: read timeline snapshots (git notes under refs/notes/timeline-metadata)
// and POST their metadata to a prompt-blame Worker.
//
// Timeline (https://github.com/teamchong/timeline) captures Claude Code edits
// as snapshot commits on `timelines/<branch>/+<n>_snapshot` branches and stores
// `{sessionId, timestamp, branch, tool, files, projectPath}` as git notes.
//
// This bridge walks those snapshots and uploads the provenance to prompt-blame,
// composing the local capture and the server-side query layers.
//
// Usage:
//   node import.mjs                        # import all timeline snapshots in the current repo
//   node import.mjs --since=<sha>          # only snapshots newer than <sha>
//   node import.mjs --worker=<url>         # override Worker URL
//   node import.mjs --dry-run              # print what would be sent, don't POST

import { execSync } from "node:child_process";

const DEFAULT_WORKER = "http://localhost:8787";

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
      else args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function normalizeRepoUrl(url) {
  if (!url) return null;
  let u = url.trim();
  if (!u) return null;

  const sshMatch = u.match(/^([\w.-]+)@([\w.-]+):(.+?)$/);
  if (sshMatch) u = `https://${sshMatch[2]}/${sshMatch[3]}`;
  else u = u.replace(/^(ssh|git):\/\//, "https://");

  u = u.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  u = u.replace(/\/+$/, "");
  if (!/\.git$/i.test(u)) u += ".git";

  return u.toLowerCase();
}

function listTimelineSnapshots(sinceSha) {
  // List commits that have a note in the timeline-metadata ref.
  const cmd = "notes --ref=timeline-metadata list";
  const output = git(cmd);
  if (!output) return [];

  const pairs = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2)
    .map(([noteSha, commitSha]) => ({ noteSha, commitSha }));

  if (!sinceSha) return pairs;

  const sinceTimestamp = parseInt(git(`show -s --format=%ct ${sinceSha}`) ?? "0", 10);
  return pairs.filter(({ commitSha }) => {
    const ts = parseInt(git(`show -s --format=%ct ${commitSha}`) ?? "0", 10);
    return ts > sinceTimestamp;
  });
}

function readTimelineNote(commitSha) {
  const raw = git(`notes --ref=timeline-metadata show ${commitSha}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function postOne(workerUrl, repoId, commitSha, note, dryRun) {
  const body = {
    repo_id: repoId,
    commit_sha: commitSha,
    agent: "claude-code",
  };

  if (note?.sessionId) body.session_id = note.sessionId;
  if (note?.tool || note?.files) {
    body.metadata_json = {};
    if (note.tool) body.metadata_json.tool = note.tool;
    if (note.files) body.metadata_json.files = note.files;
    if (note.timestamp) body.metadata_json.snapshot_at = note.timestamp;
    if (note.branch) body.metadata_json.branch = note.branch;
  }

  if (dryRun) {
    process.stdout.write(`[dry-run] ${commitSha} ${JSON.stringify(body)}\n`);
    return { ok: true, dryRun: true };
  }

  const res = await fetch(`${workerUrl}/metadata`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, error: text };
  }
  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workerUrl = args.worker ?? process.env.PROMPT_BLAME_URL ?? DEFAULT_WORKER;
  const dryRun = !!args["dry-run"];

  const repoConfigured = git("config --get remote.origin.url");
  const repoFallback = git("remote get-url origin");
  const repoId = normalizeRepoUrl(repoConfigured ?? repoFallback);
  if (!repoId) {
    process.stderr.write("error: no git origin detected\n");
    process.exit(2);
  }

  const snapshots = listTimelineSnapshots(args.since);
  if (snapshots.length === 0) {
    process.stdout.write("no timeline snapshots found\n");
    return;
  }

  process.stdout.write(`importing ${snapshots.length} snapshot(s) for ${repoId}\n`);

  let posted = 0;
  let failed = 0;
  for (const { commitSha } of snapshots) {
    const note = readTimelineNote(commitSha);
    const result = await postOne(workerUrl, repoId, commitSha, note, dryRun);
    if (result.ok) {
      posted++;
    } else {
      failed++;
      process.stderr.write(`failed ${commitSha}: ${result.status} ${result.error}\n`);
    }
  }

  process.stdout.write(`done — posted ${posted}, failed ${failed}\n`);
  if (failed > 0) process.exit(1);
}

await main();
