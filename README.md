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

The read-only console is built with `pnpm build:console` (included in `pnpm check`).
Build it before starting the controller from a fresh checkout or immutable
release. Ship `apps/console/dist/console.html` and its SHA-256 manifest alongside
the verified source; the source attestation alone does not attest generated
assets. Keep the build receipt with the private release record. Both MCP HTTP
protocols and every legacy session expose the same `ui://` resource. The opener
is `open_remote_control_console`; actual placement depends on the app host.

MCP Apps 1.7.5 is pinned with a declaration-only patch adding the missing `.js`
extensions to relative type imports for NodeNext. Runtime SDK code is unchanged;
the project retains full type checking. The console uses the SDK host bridge,
bundles its assets, permits no direct network access, and keeps credentials on
the server. It loads output only on request and renders it as text. Automated
bridge/browser tests use synthetic data and do not certify a real ChatGPT host.

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

Journal recovery keeps a durable directory-preparation intent in the journal's
state directory before creating nested recovery directories. Preserve these
`.recovery-directory-*.json` files with journal backups: retries and concurrent
entries reuse their original synchronization boundary after interruption.
A partial or invalid intent fails closed and requires inspection; do not remove
it to force a retry. If a saved anchor is missing after restore, restore the
anchor or select a fresh recovery location before retrying. Recovery directories
belong to their configured journal. The saved anchor is retained through
publication on platforms supporting directory descriptors and its identity is
rechecked immediately before committing the resolution. Stop recovery before
administratively moving its directory tree; these checks are not filesystem
snapshot isolation against uncoordinated namespace changes.


**Bounded MCP results:** final structured results validate against the advertised JSON Schema after compaction. Large results use explicit pages/previews or `resultOmitted`, with authenticated `result_recover` access to the original JSON. Text and structured previews share cursors and counts. Limits are 64 KiB structured and 256 KiB total tool result. For an ID known before effects, call `result_recovery_prepare` and pass its ID as `_meta.resultRecoveryId`; read it after delivery rejection without replay. Memory retention is up to 15 minutes/64 slots, not restart durability. Use keyed durable jobs for crash recovery. See [result contracts and limits](docs/RELIABILITY.md#bounded-results-and-delivery-recovery-r01r02r04).

**Execution facts:** batch `ok`/`partial` describe agent requests. Additive `summary`/`executionPartial` cover all items, even omitted previews; exit status, signal, timeout, cancellation, uncertainty and effect verification remain distinct. A successful read of a failed job is still a successful read. Client acceptance is unknown to the controller.

**RPC and raw-file reads:** redirects are rejected, including redirects to the same origin. A caller selects a configured endpoint; a redirect is not permission to send commands or import bytes elsewhere. Raw HTTP error bodies are consumed only up to a bounded read budget (64 KiB plus at most an incoming stream chunk), then cancelled. Diagnostics retain selected error fields, not unrelated credentials. HTTP errors are not automatically retried.

**Secret installation:** activation must return an explicit successful receipt. `secret_install_failed` and `secret_install_uncertain` are structured errors, also used by template rendering. After activation is attempted, staging/recovery material is retained: inspect `destination`, `temporaryPath` and the optional `recovery` metadata before cleanup or retry. The response never includes secret bytes or arbitrary activation exception text. A staging failure before activation attempts cleanup and reports when cleanup remains pending.

**Directory synchronization:** same-host trees must be disjoint. A read-only preflight resolves existing ancestors and symlink/junction targets on each agent; overlapping trees fail before any destination mutation. Same-host agents must support the internal `resolve-path` operation. This is a copy/update operation, not an atomic multi-file transaction. On failure, `directory_sync_partial` records transferred, unchanged, failed and not-attempted paths, confirmed byte counts and directory attempts. Already-started workers are drained before this receipt is returned. A failed file's destination is marked unverified, not assumed unchanged. Large lists may be explicitly compacted by the common MCP result limit; counts remain meaningful. Concurrent external filesystem changes can invalidate any preflight snapshot.

**Relay transfers:** the source agent must advertise `runtime.relaySourceVersion >= 1`. Each chunk is bound to one filesystem generation (`dev`, `ino`, size and nanosecond modification/change times), checked around the read and confirmed again before publication. A changing source aborts without publishing a hybrid file. `allowLegacyAgent` does not disable this check; update source agents first or explicitly use the independently verified direct transport where available. `sourceStableVerified` describes these checks, not filesystem snapshot isolation or power-loss durability. Windows native file/ACL operations use extended-length literal paths, retaining source data, destination ACLs and no-replace behavior.

**Durable batches:** `batch_exec` with a caller-chosen `operationKey` (or explicit `mode:"durable"`) uses an absolute controller `RCMCP_STATE_DIR`, starts keyed durable agent jobs and returns a bounded recovery inventory. `batch_recover` reads existing work after restart without dispatch or replay. Agents must advertise `job-key-recovery-v1`. A stale client omitting both `operationKey` and `mode` receives deprecated synchronous compatibility with `restartRecoverable:false`; explicit durable mode without a key still fails before effects, and no hidden key is generated. Explicit `mode:"legacy"` has the same restart limit and rejects keys. Durable jobs use separate `job_cancel`, and reject synchronous timeout/output-cap fields. See [durable recovery and migration](docs/RELIABILITY.md#durable-batch-recovery-r03).

**Batch identities:** `job_start_many` validates every requested route before dispatch and executes each device with its own resolved identity. A heterogeneous automatic batch has per-item `identity` and `context`, without a misleading top-level route. Uniform batches retain their summary route. List order does not change the selected identity.

**Jobs:** without `idempotencyKey`, each `job_start` intentionally starts a new job. An optional key (1–200 characters) identifies one input on one agent/state directory. Retries with that key return the existing job; different command/cwd/environment produces `job_start_conflict`. If a reserved start has no verifiable job metadata, `job_start_uncertain` requires inspection, not automatic replay. Reservation files in `job-start-keys` must be backed up with job state and remain after job-output deletion. Do not delete them to retry an uncertain command. New intended execution requires a new key. This is restart/retry deduplication, not a claim of exactly-once execution under disk loss or arbitrary power failure.

**Job waits:** one `job_wait` call defaults to and is capped at 20 seconds so it returns below typical connector/gateway deadlines. A normal expiry is a successful resumable result with `terminal:false`, `waitExpired:true`, preserved stream cursors and `retryAfterMs`. Wait for that hint, then call `job_wait` again with the returned cursor; do not alternate rapid `job_status` polling. Cancelling or disconnecting a wait never cancels the durable job; only `job_cancel` requests termination.

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

## Performance and history observations

Device inventories may declare explicit `aliases` and
`expectedAvailability: "intermittent"`. Aliases resolve to the canonical name
before tool handlers construct durable keys or coordination resources. Names and
aliases must be unique across HTTP and Android devices, ignoring case. Alias
resolution never rewrites command text, environment variables or arbitrary data.

`fleet_status` accepts `identity: "auto" | "root" | "owner" | "interactive"`.
Auto chooses system for HTTP agents and owner for Android; the selected identity
and whether it is configured are reported separately from reachability. A missing
identity is not a failed network probe. Conflicting explicit identity/context
selectors are rejected for fleet observation; effectful routing is unchanged.

Controller previews preserve `agentStdoutTruncated`/`agentStderrTruncated` and
add `controllerStdoutTruncated`/`controllerStderrTruncated` when shortening output.
Recovery restores only the captured receipt, never bytes discarded by the agent.

Observed tools expose an `operationTrace` with a unique trace and controller
instance ID. Selected starting tools accept optional `diagnosticScopeId` (UUID)
for client-declared association, independently of durable effect keys. This
metadata is removed before agent dispatch. Observations preserve bounded metadata
only under `RCMCP_STATE_DIR/operation-observations-v1`; without a configured state
root they are memory-only. Keep that directory private and owned by one controller.
Limits are 5,000 entries, 16 MiB and seven days for terminal observations. Active
and uncertain observations are retained at capacity; coverage becomes partial
instead of blocking workload execution. After restart an unfinished handler is
unknown. A returned handler is not proof of client consumption, job completion
or effect verification. Job references must be reconciled through the agent.
Diagnostic UI reads do not consume operation result-recovery slots.

`fleet_status` probes authenticated host info and light metrics in parallel within
one read-only budget (`probeTimeoutMs`, default 1500 ms; configurable through
`RCMCP_HEALTH_PROBE_TIMEOUT_MS`). A responding agent remains reachable when its
metrics fail. No response means connectivity and power state are unknown. Caller
cancellation reaches active probes and prevents queued probes from starting.
These budgets do not change effectful execution deadlines or replay behavior.

Light metrics use native root-filesystem statistics, with a one-second shared
sample and in-flight deduplication. Filesystem timestamps, age, warnings and
partial status describe freshness explicitly. Full collectors are bounded and
retain valid partial data. Root disk percentage is also populated on Windows.

Synchronous search cancellation terminates and reaps its child; persistent
searches and durable jobs remain independent of a cancelled start/wait request.
A result set exactly at `maxResults` is complete unless another match or a byte
limit demonstrates truncation. `search_sessions` retains its legacy array;
`diagnostics=true` returns an additive envelope with items and corruption counts.
Unreadable metadata is isolated and preserved.

`job_list` retains its legacy array for untruncated responses; oversized results use the documented bounded recovery envelope. `job_history` returns items, `nextCursor`,
state filtering and partial/corruption counts. Its process-local index is derived
from metadata and rebuilds after restart; receipt, lineage and idempotency files
remain authoritative. Pages order by descending start time then ID. Use the
returned cursor until null to access histories exceeding 1000 entries. Paging is
a live view: additions newer than the cursor appear on a fresh first page;
deletions do not cause duplicate entries. It is not a snapshot transaction.
Only selected receipts and active jobs are reconciled, rather than summarizing
every historical job synchronously.

Authenticated controller health includes bounded per-tool/device timing and
outcome samples and event-loop delay. It stores no raw commands, arguments,
outputs or exception messages. Clients supplying a progress token may receive
elapsed/stage notifications for fleet probes and job waits; those values are
elapsed time, never estimated completion percentages.

## High-level coordination and SDK compatibility

High-level repo/service/project/deploy operations with an identifiable resource
use agent-side reservations, persistent fencing generations and base-version
revalidation. Use `resource_coordination` to inspect/acquire/release a resource
and pass its token as `coordination` to a write. Owner override is explicit,
audited and cannot evict active/uncertain effects. Raw exec and control/read
paths remain available. Shared cross-identity coordination requires the same
absolute `RCMCP_COORDINATION_DIR` on that device, a pre-provisioned shared directory
and `RCMCP_COORDINATION_FILE_MODE=0660` on each agent. The default file mode is
private `0600`; directory permissions/group ownership are never changed. Arbitrary shell/external edits
remain outside fencing; see [bounds and recovery](docs/RELIABILITY.md#high-level-resource-coordination-r10).

SDK 1.30.0 remains pinned. Authenticated health reports observed initialize
protocol versions and session/JSON/SSE modes, without inferring negotiation from
headers or documentation. The synthetic compatibility matrix covers the
installed client and production HTTP path, including discovery, validation,
recovery and stateful cancellation. Upgrade agents before the controller, then
reconnect clients and refresh `listTools`. Unsupported high-level/UTF-8/durable
batch combinations fail clearly; base64 and compatible control reads remain
available. See the [supported matrix and rollout order](docs/RELIABILITY.md#mcp-sdk-compatibility-matrix-r11).

## HTTP protocol compatibility

The HTTP endpoint serves MCP 2026-07-28 through the official v2 handler and keeps the existing v1 session transport for initialization-based clients. Authentication and origin checks run before either path. The SDK classifier selects the wire protocol; malformed modern envelopes are not silently downgraded.

Both paths reuse the same registered tool handlers, output contracts and controller-memory recovery store. The modern adapter maps request cancellation, progress notifications, request IDs and caller recovery metadata into the existing handlers. Modern requests do not create legacy sessions. Authenticated health diagnostics expose the modern protocol revision and request count alongside the legacy SDK diagnostics.

Transport changes must pass the official modern client, legacy session/cancellation, tool catalog parity and cross-request result-recovery regressions. Native device capabilities remain independent of the HTTP protocol.
