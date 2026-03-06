// SSH protocol handler for git operations
//
// Cloudflare Workers support TCP via the connect() API.
// This module handles SSH-based git operations:
//   git clone git@gitmode.example.com:owner/repo.git
//   git push  git@gitmode.example.com:owner/repo.git
//
// SSH transport wraps the same upload-pack/receive-pack logic
// used by HTTP, but over an SSH channel.
//
// Implementation approach:
//   1. TCP listener accepts SSH connections
//   2. SSH handshake (key exchange, auth)
//   3. Parse git command from SSH exec request
//   4. Route to upload-pack or receive-pack
//   5. Stream packfile over SSH channel
//
// SSH key authentication uses D1 for key→user mapping.

import type { Env } from "./worker";
import { GitEngine } from "./git-engine";

export interface SSHCommand {
  service: "git-upload-pack" | "git-receive-pack";
  repoPath: string;
}

/** Parse an SSH exec command like "git-upload-pack '/owner/repo.git'" */
export function parseSSHCommand(command: string): SSHCommand | null {
  // Formats:
  //   git-upload-pack '/owner/repo.git'
  //   git-receive-pack '/owner/repo.git'
  //   git upload-pack '/owner/repo.git'
  //   git receive-pack '/owner/repo.git'
  const match = command.match(
    /^git[- ](upload-pack|receive-pack)\s+'?\/?([^']+?)(?:\.git)?'?$/
  );
  if (!match) return null;

  const [, action, repoPath] = match;
  return {
    service: `git-${action}` as SSHCommand["service"],
    repoPath,
  };
}

/**
 * SSH server implementation sketch for Cloudflare Workers TCP.
 *
 * Cloudflare Workers can handle TCP connections via the `connect()` API
 * and socket handlers. A full SSH implementation requires:
 *   - Key exchange (curve25519-sha256)
 *   - Host key signing (ed25519)
 *   - User authentication (publickey)
 *   - Channel multiplexing
 *   - Exec request handling
 *
 * Libraries that could be compiled to WASM for this:
 *   - libssh2 (C) via zig cc
 *   - A minimal SSH implementation in Zig
 *
 * The SSH layer would unwrap the transport and delegate to the same
 * upload-pack/receive-pack handlers used by HTTP.
 */
export class SSHServer {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /** Handle an incoming TCP connection (called from socket handler). */
  async handleConnection(
    socket: { readable: ReadableStream; writable: WritableStream }
  ): Promise<void> {
    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();

    try {
      // SSH protocol version exchange
      await writer.write(
        new TextEncoder().encode("SSH-2.0-gitmode_1.0\r\n")
      );

      // Read client version string
      const { value } = await reader.read();
      if (!value) return;

      const clientVersion = new TextDecoder().decode(value).trim();
      if (!clientVersion.startsWith("SSH-2.0-")) {
        await writer.close();
        return;
      }

      // Full SSH implementation requires key exchange, auth, and channel handling.
      // This will be implemented using a Zig SSH library compiled to WASM,
      // following the same host-import pattern as the git engine.
      //
      // The SSH handshake, authentication, and channel multiplexing happen in
      // Zig WASM. Once a channel exec request is received, the git command
      // is parsed and routed to the appropriate handler.

      await writer.close();
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }

  /** Authenticate a user by SSH public key fingerprint. */
  async authenticateKey(fingerprint: string): Promise<string | null> {
    const engine = new GitEngine(this.env, "");
    return engine.getSSHKeyOwner(fingerprint);
  }
}
