# Remote Control MCP

An owner-operated MCP controller and host agent for Linux, Windows and the Android companion. Owner execution capabilities remain unrestricted; authentication identifies the transport peer, not a command allowlist.

This public repository contains reusable source, configuration examples and synthetic fixtures only. Device inventories, real endpoints, credentials, databases, screenshots, deployment manifests and rollback records belong in private operator storage.

## Development

Use Node.js 24.21.0 and pnpm 10.29.3 (also specified in CI). Native features need their platform tools: Git and ripgrep; a supported browser for browser automation; Go for the relevant runtime probes. Windows interactive tests need a real interactive desktop. Hosted Windows is not a substitute for those tests.

```sh
pnpm install --frozen-lockfile
pnpm check
node .github/check-public-data.mjs --history HEAD
```

Tests use isolated temporary state. Do not override them with production state directories. The lockfile fixes resolved packages; direct versions and action commit hashes are pinned. Change those deliberately and rerun the entire relevant suite, including SDK/session compatibility tests.

## Configuration and startup

Copy `.env.example` into a private configuration directory. Replace placeholders with independently generated secrets; never commit the resulting file. Start an agent per required execution identity. Give owner and system agents separate ports and state directories; keep their existing private data directories stable across upgrades.

The agent reads `RCMCP_AGENT_HOST`, `RCMCP_AGENT_PORT`, `RCMCP_AGENT_TOKEN` and optional `RCMCP_STATE_DIR`. Prefer private-network binding or loopback behind your authenticated transport. Explicitly unauthenticated mode is for deliberate isolated operation, not an installation default.

Create a private device inventory from `config/devices.example.json`, and point `RCMCP_DEVICES_FILE` at its absolute path. Configure the controller using `RCMCP_MCP_HOST`, `RCMCP_MCP_PORT`, `RCMCP_MCP_TOKEN` and the agent credentials/inventory. Supply absolute paths for private configuration so a release-directory switch does not move state.

```sh
node --env-file=/home/operator/.config/rcmcp/agent.env apps/agent/src/index.ts
node --env-file=/home/operator/.config/rcmcp/controller.env apps/mcp-server/src/index.ts
```

Connect an MCP client to the configured controller's `/mcp` endpoint using the configured bearer token. `deploy/` contains generic service/install templates, not a live inventory. Preserve existing Android application identifiers during upgrades. Android baseline control and optional Shizuku shell have different capabilities; the companion interface documents that distinction.

## Result and recovery contracts

**RPC:** redirects are rejected, including redirects to the same origin. A caller selects a configured endpoint; a redirect is not permission to send its command elsewhere. HTTP errors are not automatically retried.

**Jobs:** without `idempotencyKey`, each `job_start` intentionally starts a new job. An optional key (1–200 characters) identifies one input on one agent/state directory. Retries with that key return the existing job; different command/cwd/environment produces `job_start_conflict`. If a reserved start has no verifiable job metadata, `job_start_uncertain` requires inspection, not automatic replay. Reservation files in `job-start-keys` must be backed up with job state and remain after job-output deletion. Do not delete them to retry an uncertain command. New intended execution requires a new key. This is restart/retry deduplication, not a claim of exactly-once execution under disk loss or arbitrary power failure.

**Moves:** two names of the same inode produce `same_file_noop` with `sourceRemoved=false` when replacement is allowed. Neither name is implicitly deleted. `force=false` preserves an existing destination. Cross-filesystem moves retain capture/recovery evidence on incomplete publication. Completed Windows moves report crash durability as `unverified`; successful completion must not be interpreted as power-loss certification. Follow returned recovery paths and inspect both sides before cleanup or retry.

**Health:** unauthenticated `/health` is minimal liveness. Authenticated `/health` retains detailed diagnostic compatibility; `/health/details` explicitly requires a configured bearer token. Diagnostic callers must send authentication. Even deliberately unauthenticated MCP mode does not disclose detailed health without a configured token.

## Upgrade and rollback

Verify the candidate commit and tests before changing runtime. Keep the previous release and service definitions; back up private configuration and persistent state consistently. Stop or account for in-flight operations before switching. Set `RCMCP_RUNTIME_SHA` only to the verified release whose source is actually running, then confirm authenticated runtime information and actual MCP operations after restart.

On failure, restore the prior service/release configuration rather than deleting job or move-recovery journals. Inspect `job_status`, `job_output` and recovery receipts before retrying commands. Preserve the private deployment log and its exact source identity. Physical Windows/Android, power-loss and full-restore qualification are separate from unit tests and must not be marked passed when unavailable.

## Publication boundary and CI

Public workflows run only on GitHub-hosted Linux/Windows. Never register a persistent personal-network runner to this public repository. Owner-native qualification belongs to a separate private execution flow or an isolated ephemeral environment; an editable workflow condition alone is not an isolation boundary.

The publication guard scans current/index content, all distinct historical paths and modes, commit messages, selected secret formats, and UTF-8/UTF-16 text. A PASS is not a universal secret-detection guarantee. Hooks run before publication; full-history CI is an independent backstop, not prevention of the first public exposure. If private material is detected, stop publication and preserve/remediate it privately rather than posting the matching values in an issue.

Read `AGENTS.md` and `DEVELOPMENT_TRACKER.md`. Use a GitHub noreply author address. Keep public issues, test fixtures and reports wholly synthetic. Never copy private operational reports into this repository.
