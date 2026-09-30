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

**RPC and raw-file reads:** redirects are rejected, including redirects to the same origin. A caller selects a configured endpoint; a redirect is not permission to send commands or import bytes elsewhere. Raw HTTP error bodies are consumed only up to a bounded read budget (64 KiB plus at most an incoming stream chunk), then cancelled. Diagnostics retain selected error fields, not unrelated credentials. HTTP errors are not automatically retried.

**Secret installation:** activation must return an explicit successful receipt. `secret_install_failed` and `secret_install_uncertain` are structured errors, also used by template rendering. After activation is attempted, staging/recovery material is retained: inspect `destination`, `temporaryPath` and the optional `recovery` metadata before cleanup or retry. The response never includes secret bytes or arbitrary activation exception text. A staging failure before activation attempts cleanup and reports when cleanup remains pending.

**Directory synchronization:** same-host trees must be disjoint. A read-only preflight resolves existing ancestors and symlink/junction targets on each agent; overlapping trees fail before any destination mutation. Same-host agents must support the internal `resolve-path` operation. This is a copy/update operation, not an atomic multi-file transaction. On failure, `directory_sync_partial` records transferred, unchanged, failed and not-attempted paths, confirmed byte counts and directory attempts. Already-started workers are drained before this receipt is returned. A failed file's destination is marked unverified, not assumed unchanged. Large lists may be explicitly compacted by the common MCP result limit; counts remain meaningful. Concurrent external filesystem changes can invalidate any preflight snapshot.

**Relay transfers:** the source agent must advertise `runtime.relaySourceVersion >= 1`. Each chunk is bound to one filesystem generation (`dev`, `ino`, size and nanosecond modification/change times), checked around the read and confirmed again before publication. A changing source aborts without publishing a hybrid file. `allowLegacyAgent` does not disable this check; update source agents first or explicitly use the independently verified direct transport where available. `sourceStableVerified` describes these checks, not filesystem snapshot isolation or power-loss durability. Windows native file/ACL operations use extended-length literal paths, retaining source data, destination ACLs and no-replace behavior.

**Batch identities:** `job_start_many` validates every requested route before dispatch and executes each device with its own resolved identity. A heterogeneous automatic batch has per-item `identity` and `context`, without a misleading top-level route. Uniform batches retain their summary route. List order does not change the selected identity.

**Jobs:** without `idempotencyKey`, each `job_start` intentionally starts a new job. An optional key (1–200 characters) identifies one input on one agent/state directory. Retries with that key return the existing job; different command/cwd/environment produces `job_start_conflict`. If a reserved start has no verifiable job metadata, `job_start_uncertain` requires inspection, not automatic replay. Reservation files in `job-start-keys` must be backed up with job state and remain after job-output deletion. Do not delete them to retry an uncertain command. New intended execution requires a new key. This is restart/retry deduplication, not a claim of exactly-once execution under disk loss or arbitrary power failure.

**Process termination:** on Linux the agent still signals and escalates every identity-bound process it can observe, including setsid descendants already captured by the lineage ledger. Generic `/proc` observation is not kernel containment, however: a command can detach and scrub its environment before it is observed. Therefore timeout/cancel/PTY receipts do not claim `terminationVerified=true` merely because all observed processes disappeared. They return an unverified scope/reason instead; durable jobs become `lost` rather than falsely `cancelled` when whole-tree absence cannot be proved. This does not reduce kill capability—it makes the receipt match the evidence.

**Moves:** two names of the same inode produce `same_file_noop` with `sourceRemoved=false` when replacement is allowed. Neither name is implicitly deleted. `force=false` preserves an existing destination. Cross-filesystem moves retain capture/recovery evidence on incomplete publication. Completed Windows moves report crash durability as `unverified`; successful completion must not be interpreted as power-loss certification. Follow returned recovery paths and inspect both sides before cleanup or retry.

**Health:** unauthenticated `/health` is minimal liveness. Authenticated `/health` retains detailed diagnostic compatibility; `/health/details` explicitly requires a configured bearer token. Diagnostic callers must send authentication. Even deliberately unauthenticated MCP mode does not disclose detailed health without a configured token.

## Upgrade and rollback

Verify the candidate commit and tests before changing runtime. Keep the previous release and service definitions; back up private configuration and persistent state consistently. Stop or account for in-flight operations before switching. Set `RCMCP_RUNTIME_SHA` only to the verified release whose source is actually running, then confirm authenticated runtime information and actual MCP operations after restart. Upgrade source agents before a controller that requires generation-bound relay reads. A controller upgrade alone does not make an old source agent compatible.

Use `node scripts/verify-release.ts <repository> <release-directory> <full-commit-id>` to compare every tracked blob and applicable executable mode against the immutable commit. Store the successful JSON receipt privately with the release, together with the service/identity and validation results; the script does not assert which process is active. Confirm actual process paths and runtime identity separately. See [Reliability and release qualification](docs/RELIABILITY.md).

On failure, restore the prior service/release configuration rather than deleting job or move-recovery journals. Inspect `job_status`, `job_output` and recovery receipts before retrying commands. Preserve the private deployment log and its exact source identity. Physical Windows/Android, power-loss and full-restore qualification are separate from unit tests and must not be marked passed when unavailable.

## Publication boundary and CI

Public workflows run only on GitHub-hosted Linux/Windows. Never register a persistent personal-network runner to this public repository. Owner-native qualification belongs to a separate private execution flow or an isolated ephemeral environment; an editable workflow condition alone is not an isolation boundary.

The publication guard scans current/index content, all distinct historical paths and modes, commit messages, selected secret formats, and UTF-8/UTF-16 text. A PASS is not a universal secret-detection guarantee. Hooks run before publication; full-history CI is an independent backstop, not prevention of the first public exposure. If private material is detected, stop publication and preserve/remediate it privately rather than posting the matching values in an issue.

Read `AGENTS.md` and `DEVELOPMENT_TRACKER.md`. Use GitHub noreply addresses for both author and committer, including merges and imported commits. Keep public issues, test fixtures and reports wholly synthetic. Never copy private operational reports into this repository.

## Optional ContextKeep result bridge

Set RCMCP_CONTEXTKEEP_URL, RCMCP_CONTEXTKEEP_TOKEN and an absolute
RCMCP_CONTEXTKEEP_STATE_DIR privately to enable correlation. The endpoint must
use HTTPS or loopback HTTP. Configure the same directory after restart.

For a correlated job_start, provide the existing ContextKeep projectId, taskId,
runId and begin_run leaseToken in contextKeep, plus a stable idempotencyKey.
Reserve the run and its subscription before invoking a fast job. inputHash in
ContextKeep must match jobInputHash exported by the bridge (canonical command,
cwd and sorted environment). Uncorrelated jobs retain their existing behavior.

The bridge journals before execution, attaches the receipt and retries terminal
observations while ContextKeep is unavailable. It never copies command text,
environment values or raw output into events. A lost start receipt remains
job_start_uncertain and is never automatically replayed. Inspect retained agent
job-start-key metadata and correlate the known job through ContextKeep manually.
Keep bridge journals in private backups. A delivered observation is not an
independently verified result or a completed task.

The client validates correlated JSON-RPC and tool acknowledgements, supports JSON
and incremental SSE, and enforces response-size and lifetime limits without
reconnecting or replaying a start. Corrupt journal entries are isolated and kept
as evidence; they cannot make unrelated receipts stop progressing. Version-1
journals remain readable. Durable version-2 stages record acknowledgement,
observation and bounded retry backoff. Delivered entries remain deduplication
tombstones, not disposable logs.

Reconciliation requires exact project/task/run/job/device/identity correlation
and proof of the hash-checked attachment. A legacy entry missing that proof stays
pending (`proof_missing`) rather than being declared delivered from terminal status
alone. The authenticated health response exposes aggregate pending age/count,
corruption count and safe error categories, never commands or lease credentials.
The bridge avoids writing to known terminal/verified runs; concurrent observation
and verification ordering ultimately depends on the ContextKeep write contract.
