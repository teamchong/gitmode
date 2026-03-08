#!/usr/bin/env node

// gitmode CLI — scaffold and deploy a gitmode Worker
//
// Usage:
//   npx gitmode init           Create wrangler.jsonc + worker entry in current dir
//   npx gitmode deploy         Deploy to Cloudflare Workers (runs wrangler deploy)

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templateDir = join(__dirname, "template");

const [, , command] = process.argv;

switch (command) {
  case "init":
    init();
    break;
  case "deploy":
    deploy();
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    console.error(`Unknown command: ${command ?? "(none)"}`);
    usage();
    process.exit(1);
}

function usage() {
  console.log(`
gitmode — Git server on Cloudflare Workers

Commands:
  init      Scaffold a gitmode Worker project in the current directory
  deploy    Build and deploy to Cloudflare Workers

Options:
  --help    Show this help message

Examples:
  npx gitmode init
  npx gitmode deploy
`);
}

function init() {
  const cwd = process.cwd();

  // Create worker entry
  const workerDir = join(cwd, "worker");
  const workerFile = join(workerDir, "index.ts");
  if (!existsSync(workerDir)) {
    mkdirSync(workerDir, { recursive: true });
  }

  if (existsSync(workerFile)) {
    console.log("  skip  worker/index.ts (already exists)");
  } else {
    copyFileSync(join(templateDir, "worker.ts"), workerFile);
    console.log("  create  worker/index.ts");
  }

  // Create wrangler.jsonc
  const wranglerFile = join(cwd, "wrangler.jsonc");
  if (existsSync(wranglerFile)) {
    console.log("  skip  wrangler.jsonc (already exists)");
  } else {
    copyFileSync(join(templateDir, "wrangler.jsonc"), wranglerFile);
    console.log("  create  wrangler.jsonc");
  }

  // Create or update package.json
  const pkgFile = join(cwd, "package.json");
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
    let changed = false;
    if (!pkg.dependencies?.gitmode) {
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies.gitmode = "latest";
      changed = true;
    }
    if (changed) {
      writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
      console.log("  update  package.json (added gitmode dependency)");
    } else {
      console.log("  skip  package.json (gitmode already in dependencies)");
    }
  } else {
    const pkg = {
      name: "my-git-server",
      version: "0.1.0",
      type: "module",
      dependencies: {
        gitmode: "latest",
      },
      devDependencies: {
        wrangler: "^4.0.0",
        "@cloudflare/workers-types": "^4.0.0",
        typescript: "^5.0.0",
      },
    };
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
    console.log("  create  package.json");
  }

  console.log(`
Done! Next steps:
  1. npm install
  2. npx gitmode deploy   (or: npx wrangler deploy)
`);
}

function deploy() {
  const cwd = process.cwd();

  // Check for wrangler.jsonc
  if (!existsSync(join(cwd, "wrangler.jsonc")) && !existsSync(join(cwd, "wrangler.toml"))) {
    console.error("No wrangler.jsonc found. Run `npx gitmode init` first.");
    process.exit(1);
  }

  console.log("Deploying gitmode to Cloudflare Workers...\n");

  try {
    execSync("npx wrangler deploy", { cwd, stdio: "inherit" });
  } catch {
    process.exit(1);
  }
}
