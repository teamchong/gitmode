# Disclaimer

This is a personal open-source project. It is **not** affiliated with, endorsed by, sponsored by, or representative of Cloudflare or any other organization. All opinions, design decisions, code, and documentation in this repository reflect the author's personal views, not those of any employer.

## Relationship to Cloudflare Artifacts

[Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) is Cloudflare's managed Git-compatible storage product (announced April 16, 2026). This project — gitmode — is an independent OSS exploration that:

- Is **not** an official Cloudflare product
- Is **not** a fork or extension of Artifacts source code (the Artifacts server is closed-source; only [ArtifactFS](https://github.com/cloudflare/artifact-fs), the FUSE driver, is OSS)
- **Is** an OSS toolkit designed to extend Artifacts via its public REST and Git protocol APIs
- **Is** a research vehicle for ideas (prompt-blame, edge compute pool extensions) that may or may not align with the Artifacts roadmap

## Conflict-of-interest disclosure

The maintainer is currently employed by Cloudflare. Relevant facts:

- This project predates the public launch of Cloudflare Artifacts (April 16, 2026). Git history is public and reflects ongoing development from earlier dates.
- The project was developed independently of any Cloudflare-internal information. Architectural similarities to Artifacts reflect the fact that both projects respond to the same public design constraints (running Git on Cloudflare Workers + Durable Objects + R2).
- The project pivoted in April 2026 from a parallel Git-server implementation to a toolkit *on top of* Artifacts, explicitly to avoid competing with the maintainer's employer. See [DESIGN-NOTES.md](./DESIGN-NOTES.md) for the pivot rationale.
- Any contributions or design proposals that emerge from this project's R&D and might be useful to Artifacts will be shared via normal public channels (blog posts, issue discussions, RFCs) and will not use any Cloudflare-internal information.

## No warranty

This software is provided "as-is" without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

See [LICENSE](./LICENSE) for full terms.

## Trademarks

"Cloudflare," "Workers," "R2," "Durable Objects," and "Artifacts" are trademarks of Cloudflare, Inc. Use of these names in this repository is for descriptive and interoperability purposes only and does not imply endorsement.

Other trademarks are property of their respective owners.
