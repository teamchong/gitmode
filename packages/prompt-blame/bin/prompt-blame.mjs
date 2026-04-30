#!/usr/bin/env node
// prompt-blame CLI — post and query commit metadata against a prompt-blame Worker.
//
// Subcommands:
//   post   — POST /metadata with explicit fields
//   get    — GET /metadata for a (repo, sha)
//   hook   — read Claude Code PostToolUse hook JSON from stdin, auto-detect repo + HEAD,
//            POST metadata. Designed to be installed as a Claude Code hook command.
//
// Configuration (in priority order):
//   --worker=<url>              CLI flag
//   PROMPT_BLAME_URL=<url>      env var
//   default: http://localhost:8787

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

function workerUrl(args) {
  return args.worker ?? process.env.PROMPT_BLAME_URL ?? DEFAULT_WORKER;
}

function gitOrNull(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Normalize a git remote URL to a canonical https form so that the same repo
// addressed via SSH, https, or with/without `.git` produces the same repo_id.
//
//   git@github.com:user/repo.git   → https://github.com/user/repo.git
//   ssh://git@github.com/u/r       → https://github.com/u/r.git
//   https://USER:TOKEN@host/u/r    → https://host/u/r.git
//   https://github.com/User/Repo   → https://github.com/user/repo.git
export function normalizeRepoUrl(url) {
  if (!url) return null;
  let u = url.trim();
  if (!u) return null;

  const sshMatch = u.match(/^([\w.-]+)@([\w.-]+):(.+?)$/);
  if (sshMatch) {
    u = `https://${sshMatch[2]}/${sshMatch[3]}`;
  } else {
    u = u.replace(/^(ssh|git):\/\//, "https://");
  }

  u = u.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  u = u.replace(/\/+$/, "");
  if (!/\.git$/i.test(u)) u += ".git";

  return u.toLowerCase();
}

function detectRepo() {
  // Use `git config` to read raw configured URL, bypassing insteadOf rewrites
  // so that downstream normalization sees the user's intent rather than the
  // pushInsteadOf / insteadOf rewrite target.
  const configured = gitOrNull("config --get remote.origin.url");
  const fallback = gitOrNull("remote get-url origin");
  return normalizeRepoUrl(configured ?? fallback);
}

function detectHeadSha() {
  const sha = gitOrNull("rev-parse HEAD");
  return sha ? sha.toLowerCase() : null;
}

async function post(args) {
  const url = workerUrl(args);
  const body = {};

  body.repo_id = args.repo ? normalizeRepoUrl(args.repo) : detectRepo();
  body.commit_sha = (args.sha ?? detectHeadSha())?.toLowerCase();

  if (!body.repo_id) die("repo not provided and no git origin detected");
  if (!body.commit_sha) die("sha not provided and no HEAD detected");

  for (const field of [
    "prompt_id",
    "model",
    "agent",
    "session_id",
    "parent_session_id",
    "human_author_email",
  ]) {
    const cliKey = field.replace(/_/g, "-");
    if (args[cliKey] !== undefined) body[field] = args[cliKey];
    if (args[field] !== undefined) body[field] = args[field];
  }

  if (args["human-edited"] !== undefined) {
    body.human_edited = args["human-edited"] === "true" || args["human-edited"] === true;
  }

  if (args["metadata-json"] !== undefined) {
    try {
      body.metadata_json = JSON.parse(args["metadata-json"]);
    } catch {
      die("--metadata-json must be valid JSON");
    }
  }

  const res = await fetch(`${url}/metadata`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  process.stdout.write(text + "\n");
  if (!res.ok) process.exit(1);
}

async function get(args) {
  const url = workerUrl(args);
  const repo = args.repo ? normalizeRepoUrl(args.repo) : detectRepo();
  const sha = (args.sha ?? detectHeadSha())?.toLowerCase();

  if (!repo) die("repo not provided and no git origin detected");
  if (!sha) die("sha not provided and no HEAD detected");

  const target = `${url}/metadata?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`;
  const res = await fetch(target);
  const text = await res.text();
  process.stdout.write(text + "\n");
  if (!res.ok) process.exit(1);
}

async function hook(args) {
  // Claude Code passes JSON on stdin to PostToolUse hooks.
  // Fields used: session_id, transcript_path, tool_name, tool_input.
  let stdin = "";
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) stdin += chunk;
  }

  let hookData = null;
  try {
    if (stdin.trim()) hookData = JSON.parse(stdin);
  } catch {
    // ignore — fall through with no hook data
  }

  const url = workerUrl(args);
  const repo = detectRepo();
  const sha = detectHeadSha();

  // No commit yet? Nothing to record. Exit silently — hook must not block.
  if (!repo || !sha) {
    process.exit(0);
  }

  const body = {
    repo_id: repo,
    commit_sha: sha,
    agent: args.agent ?? "claude-code",
  };

  if (hookData?.session_id) body.session_id = hookData.session_id;
  if (hookData?.tool_name) {
    body.metadata_json = { tool: hookData.tool_name };
  }

  if (args.model) body.model = args.model;

  try {
    await fetch(`${url}/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Network errors must not break Claude Code. Exit 0 silently.
  }

  process.exit(0);
}

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function usage() {
  process.stdout.write(`prompt-blame — record and query commit provenance.

usage:
  prompt-blame post  [--repo=<url>] [--sha=<sha>] [--prompt-id=<id>]
                     [--model=<m>] [--agent=<a>] [--session-id=<id>]
                     [--parent-session-id=<id>] [--human-edited=true|false]
                     [--metadata-json=<json>] [--worker=<url>]
  prompt-blame get   [--repo=<url>] [--sha=<sha>] [--worker=<url>]
  prompt-blame hook  [--agent=<a>] [--model=<m>] [--worker=<url>]
                     # reads Claude Code PostToolUse JSON from stdin

config:
  --worker=<url>              override Worker URL
  PROMPT_BLAME_URL=<url>      env var (used if --worker absent)
  default: ${DEFAULT_WORKER}

examples:
  prompt-blame post --agent=claude-code --session-id=abc123
  prompt-blame get --sha=\$(git rev-parse HEAD)
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || args.help || args.h) {
    usage();
    process.exit(0);
  }

  switch (cmd) {
    case "post":
      await post(args);
      break;
    case "get":
      await get(args);
      break;
    case "hook":
      await hook(args);
      break;
    default:
      die(`unknown command: ${cmd}`);
  }
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  await main();
}
