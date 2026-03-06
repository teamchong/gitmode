// SSH command parsing for git operations
//
// Used by the SSH-to-HTTP proxy (ssh/proxy.ts) to parse git commands
// from SSH exec requests and route to the appropriate handler.
//
// SSH transport:
//   git clone ssh://git@host:port/owner/repo.git
//   git push  ssh://git@host:port/owner/repo.git
//
// The SSH proxy accepts connections, parses the git command, and
// forwards to the HTTP Worker endpoints (info-refs, upload-pack,
// receive-pack). See ssh/proxy.ts for the full implementation.

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
