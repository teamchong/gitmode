#!/usr/bin/env node
// SSH-to-HTTP proxy for gitmode
//
// Runs alongside the Cloudflare Worker (wrangler dev) and translates
// git SSH commands into HTTP requests to the Worker's git endpoints.
//
// Usage:
//   npx tsx ssh/proxy.ts [--port 2222] [--http http://localhost:8787]
//
// Then:
//   git clone ssh://git@localhost:2222/owner/repo.git

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Server } = require("ssh2") as typeof import("ssh2");
import type { Connection, Session, ExecInfo } from "ssh2";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import http from "node:http";

// --- Config ---

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const SSH_PORT = parseInt(getArg("--port", "2222"), 10);
const HTTP_BASE = getArg("--http", "http://localhost:8787");

// --- Host key ---

const KEY_DIR = dirname(new URL(import.meta.url).pathname);
const KEY_PATH = join(KEY_DIR, "host_key");

function ensureHostKey(): Buffer {
  if (!existsSync(KEY_PATH)) {
    console.log(`Generating host key at ${KEY_PATH}`);
    execSync(`ssh-keygen -t ed25519 -f ${KEY_PATH} -N "" -q`);
  }
  return readFileSync(KEY_PATH);
}

const hostKey = ensureHostKey();

// --- SSH command parsing ---

interface GitCommand {
  service: "git-upload-pack" | "git-receive-pack";
  repoPath: string;
}

function parseGitCommand(command: string): GitCommand | null {
  const match = command.match(
    /^git[- ](upload-pack|receive-pack)\s+'?\/?([^']+?)(?:\.git)?'?$/
  );
  if (!match) return null;
  return {
    service: `git-${match[1]}` as GitCommand["service"],
    repoPath: match[2],
  };
}

// --- HTTP helpers ---

function httpGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

function httpPost(url: string, contentType: string, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "content-type": contentType, "content-length": body.length },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- Pkt-line helpers ---

/**
 * Strip the HTTP smart protocol service announcement from ref advertisement.
 * HTTP: pkt-line("# service=git-upload-pack\n") + flush(0000) + refs
 * SSH: raw refs only
 */
function stripServiceAnnouncement(body: Buffer, service: string): Buffer {
  let offset = 0;
  if (body.length < 4) return body;

  const lenHex = body.subarray(0, 4).toString("ascii");
  const len = parseInt(lenHex, 16);

  if (len > 4 && len <= body.length) {
    const content = body.subarray(4, len).toString("ascii");
    if (content.includes(`# service=${service}`)) {
      offset = len;
      if (body.length >= offset + 4) {
        const nextLen = body.subarray(offset, offset + 4).toString("ascii");
        if (nextLen === "0000") {
          offset += 4;
        }
      }
    }
  }

  return body.subarray(offset);
}

/**
 * Read from stream until "done\n" appears (upload-pack client request).
 */
function readUntilDone(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;

    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve(Buffer.concat(chunks));
      }
    };

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      if (combined.toString("ascii").includes("done\n")) {
        finish();
      }
    });

    stream.on("end", finish);
    stream.on("close", finish);
    (stream as any).on("eof", finish);
  });
}

/**
 * Read receive-pack client data: ref-update pkt-lines + flush + optional packfile.
 *
 * For regular push: ref-updates + flush(0000) + PACK...data... + EOF
 * For delete-only push: ref-updates + flush(0000) — no packfile, no EOF
 *
 * Strategy: parse pkt-lines until we find the flush after ref-updates.
 * Then peek at the next bytes: if "PACK" follows, read until EOF.
 * If nothing follows within a short window, the client is done (delete).
 */
function readReceivePackData(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    let flushOffset = -1;
    let waitingForPackOrEof = false;
    let packTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (!resolved) {
        resolved = true;
        if (packTimer) clearTimeout(packTimer);
        resolve(Buffer.concat(chunks));
      }
    };

    const checkData = () => {
      const buf = Buffer.concat(chunks);

      // If we already found the flush, check for PACK header
      if (flushOffset >= 0) {
        if (buf.length > flushOffset) {
          const afterFlush = buf.subarray(flushOffset);
          if (afterFlush.length >= 4) {
            const magic = afterFlush.subarray(0, 4).toString("ascii");
            if (magic === "PACK") {
              // Packfile follows — read until EOF
              waitingForPackOrEof = true;
              if (packTimer) clearTimeout(packTimer);
              return;
            }
          }
          // Data after flush but not PACK — should not happen normally
          // Wait for more data or EOF
          return;
        }
        // No data after flush yet — start a timer
        if (!waitingForPackOrEof && !packTimer) {
          packTimer = setTimeout(() => {
            // No PACK arrived — this is a delete-only push
            finish();
          }, 200);
        }
        return;
      }

      // Parse pkt-lines to find the flush packet
      let pos = 0;
      while (pos + 4 <= buf.length) {
        const lenHex = buf.subarray(pos, pos + 4).toString("ascii");
        const pktLen = parseInt(lenHex, 16);

        if (pktLen === 0) {
          // Flush packet — end of ref-update lines
          flushOffset = pos + 4;
          checkData();
          return;
        }

        if (isNaN(pktLen) || pktLen < 4 || pos + pktLen > buf.length) {
          // Incomplete pkt-line, wait for more data
          return;
        }

        pos += pktLen;
      }
    };

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      // Reset the no-pack timer on new data
      if (packTimer && flushOffset >= 0) {
        clearTimeout(packTimer);
        packTimer = null;
        const buf = Buffer.concat(chunks);
        const afterFlush = buf.subarray(flushOffset);
        if (afterFlush.length >= 4) {
          const magic = afterFlush.subarray(0, 4).toString("ascii");
          if (magic === "PACK") {
            waitingForPackOrEof = true;
            return;
          }
        }
        // Restart timer
        packTimer = setTimeout(finish, 200);
      }
      checkData();
    });

    stream.on("end", finish);
    stream.on("close", finish);
    (stream as any).on("eof", finish);
  });
}

// --- Git protocol over SSH ---

async function handleUploadPack(
  cmd: GitCommand,
  stream: any,
): Promise<void> {
  const repoUrl = `${HTTP_BASE}/${cmd.repoPath}.git`;

  // Step 1: Get ref advertisement, strip HTTP framing, send to client
  const refsBody = await httpGet(`${repoUrl}/info/refs?service=git-upload-pack`);
  const stripped = stripServiceAnnouncement(refsBody, "git-upload-pack");
  stream.write(stripped);

  // Step 2: Read client wants/haves until "done"
  const clientData = await readUntilDone(stream);

  if (clientData.length === 0) {
    stream.exit(0);
    stream.end();
    return;
  }

  // Step 3: Forward to HTTP upload-pack endpoint
  const packResp = await httpPost(
    `${repoUrl}/git-upload-pack`,
    "application/x-git-upload-pack-request",
    clientData,
  );

  stream.write(packResp);
  stream.exit(0);
  stream.end();
}

async function handleReceivePack(
  cmd: GitCommand,
  stream: any,
): Promise<void> {
  const repoUrl = `${HTTP_BASE}/${cmd.repoPath}.git`;

  // Step 1: Get ref advertisement
  const refsBody = await httpGet(`${repoUrl}/info/refs?service=git-receive-pack`);
  const stripped = stripServiceAnnouncement(refsBody, "git-receive-pack");
  stream.write(stripped);

  // Step 2: Read client ref-updates + optional packfile
  const clientData = await readReceivePackData(stream);

  if (clientData.length === 0) {
    stream.exit(0);
    stream.end();
    return;
  }

  // Step 3: Forward to HTTP receive-pack, preserving sideband capability.
  // The git client expects sideband responses since it advertised it.
  const pushResp = await httpPost(
    `${repoUrl}/git-receive-pack`,
    "application/x-git-receive-pack-request",
    clientData,
  );

  stream.write(pushResp);
  stream.exit(0);
  stream.end();
}

// --- SSH Server ---

const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
  client.on("authentication", (ctx) => {
    ctx.accept();
  });

  client.on("ready", () => {
    client.on("session", (accept: () => Session) => {
      const session = accept();

      session.on("exec", (accept: () => any, _reject: () => void, info: ExecInfo) => {
        const cmd = parseGitCommand(info.command);
        if (!cmd) {
          const stream = accept();
          stream.stderr?.write(`fatal: unsupported command: ${info.command}\n`);
          stream.exit(128);
          stream.end();
          return;
        }

        const stream = accept();
        const handler = cmd.service === "git-upload-pack"
          ? handleUploadPack
          : handleReceivePack;

        handler(cmd, stream).catch((err) => {
          console.error(`SSH git error:`, err);
          try {
            stream.stderr?.write(`fatal: ${err.message}\n`);
            stream.exit(1);
            stream.end();
          } catch {}
        });
      });
    });
  });

  client.on("error", () => {});
});

server.listen(SSH_PORT, "127.0.0.1", () => {
  console.log(`gitmode SSH proxy listening on port ${SSH_PORT}`);
  console.log(`Forwarding to ${HTTP_BASE}`);
  console.log(`Usage: git clone ssh://git@localhost:${SSH_PORT}/owner/repo.git`);
});

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); process.exit(0); });
