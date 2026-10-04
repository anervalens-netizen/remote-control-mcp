# Reliability and release qualification

This guide describes the source contracts. Live inventory, completion receipts, source mappings, rollback bundles and outstanding device checks are private operator records. GitHub issue #11 tracks the A01–A12 remediation; a passing unit test is not a deployment receipt.

## Integrity invariants

A command receipt, coherent file contents, the selected execution identity and a correlated delivery acknowledgement are separate facts. Never infer one from another. Timeout, a disconnected caller or a missing receipt does not authorize effect replay.

Relay transfers bind all byte reads to one regular-file generation and validate it before/after each read and before requesting destination publication. File size and preserved modification time alone are insufficient. The source must advertise generation-bound reads; an old source is rejected before destination mutation even when metadata-legacy compatibility is explicitly enabled. Direct transport remains a separate hash/final-confirmation protocol. Neither transport claims a multi-file snapshot or transactional directory synchronization. Filesystems with unusual change metadata need separate qualification.

Windows PowerShell/.NET file and ACL operations receive extended-length paths as literal environment values, not script interpolation. New destinations retain no-replace publication; existing destinations retain their security descriptors and prior data on preparation failure. Windows can normalize the discretionary ACL AUTO_INHERITED bookkeeping flag; permissions, ordered ACE bytes, owner/group and other relevant control flags are not intentionally changed. Native tests must cover long new/existing paths and literal Unicode/shell-significant names. UNC path normalization tests do not establish connectivity or behavior of every SMB server.

Every batch route is resolved before dispatch. An explicit unavailable identity fails preflight. Automatic heterogeneous batches use each device's own route and publish per-item identities. Optional top-level routing is present only for a uniform batch; result compaction must not invent a route for a mixed batch.

## ContextKeep bridge

The opt-in bridge is an executor-result adapter, not a task verifier. Use an absolute private journal directory, HTTPS or loopback HTTP, independent credentials and a ContextKeep reservation whose canonical input hash matches the command, working directory and sorted environment.

Canonical input hashes sort environment keys by locale-independent UTF-16 code-unit order and serialize that order directly, including numeric-looking names such as `10` and `2`; rebuilding a JavaScript object would reorder those names. Producers must use the same explicit rule; historical journal hashes are never rewritten in place to make a conflicting start appear retryable.

A durable exclusive reservation precedes the only executor start. Invalid/corrupt/partial records remain evidence, and a missing job receipt stays uncertain. Do not delete or rewrite a reservation to make a command retryable. A new intended execution uses a new key. Delivered records remain permanent deduplication tombstones; preserve them with backups even when output logs are rotated.

Acknowledgements must be valid correlated JSON-RPC tool results with the expected run/job scope. An HTTP 200, empty object or unrelated response ID is not delivery. JSON and incremental SSE are supported, including a server keeping the stream open after the matching event. Byte and time budgets, cancellation and redirect rejection bound one attempt; transport uncertainty never causes a new executor start.

Version-2 journals persist attachment acknowledgement, observed terminal facts and delivery separately. Version-1 journals remain readable, but missing historical proof is not invented. Reconciliation can confirm a terminal remote run only with exact correlation and a proven hash-checked attachment. When proof is insufficient, keep `proof_missing` pending and investigate read-only evidence; do not blindly mark the row delivered or overwrite a verified remote result.

Authenticated health diagnostics report pending count/oldest age, corrupt count and safe error categories. A corrupt entry does not stop healthy entries. Processing has bounded concurrency, exponential retry backoff and bounded shutdown. Idle pumps and diagnostics use an in-memory index of unresolved records, not the permanent delivered history. A full bootstrap scan and reconciliation 60 seconds after the previous scan finishes discover external additions, repairs and removals. Duplicate starts and scheduled attempts still read the durable record before acting; no cached acknowledgement authorizes replay. Both HTTP and stdio shutdown abort and drain correlated start requests as well as receipt workers. A cancelled request does not prove that an already-received remote command did not execute: its uncertain reservation remains, and a late response cannot update the closed bridge. Version-2 delivered entries require durable attachment proof; the historical version-1 tombstone exception does not legitimize an unacknowledged version-2 entry. Aggregate HTTP failures are not a measured command-failure rate.

ContextKeep owns atomic ordering between observations and independent verification. The bridge avoids known terminal/verified writes, but a client-side read alone cannot fence a simultaneous server-side write. Changes to that contract must be coordinated in the ContextKeep project, not silently invented by this controller.

## Release procedure

1. Keep implementation in an isolated worktree; preserve concurrent work, private state and previous release/service definitions. Validate the exact candidate with typecheck, relevant regressions and full Linux/native Windows suites. Build/lint/JVM tests do not replace Android device checks.
2. Check current/index content and the complete reachable publication history. Use noreply author and committer metadata. A metadata-only correction must preserve every source tree/message, retain a private recovery bundle and publish with an expected remote ref, not an unchecked history replacement. Never weaken the publication guard to make a candidate pass.
3. Build an immutable release directory containing source and locked dependencies. Run `scripts/verify-release.ts` with a full object ID matching the repository hash format, and keep its successful JSON output privately. A symbolic release root is rejected; ancestor aliases resolve to the physical directory named in the receipt. Record actual services, identities, test reports and rollback target separately. Do not commit an operational manifest or private source mapping to this repository.
4. Upgrade source agents before the controller when a new protocol capability is required. Use a separate live control context and account for running jobs before a restart. Preserve all credentials, absolute state paths, job keys, bridge and move-recovery journals. An unavailable host is not implicitly upgraded.
5. Confirm authenticated runtime SHA, process/executable path and usable capabilities after activation. Exercise synthetic transfer, batch and result-delivery canaries without touching personal data. A mismatch or failed canary requires investigation or restoring the previous release; do not relabel the intended version as the observed one.

## Platform qualification and retention

Report transport, identity, interactive desktop, Android Accessibility, screenshot and optional shell readiness separately. A device marked online does not imply screenshots or interactive controls work. Android screen-capture consent and OS lifecycle behavior must be tested on physical devices without bypassing local permission requirements. An unavailable Work host, omitted interactive suite or uninstalled APK remains explicitly pending.

Keep public CI on hosted workers. Do not register a persistent personal-network runner with a public repository; an editable workflow condition is not isolation. Private owner-native qualification remains available through the control plane and does not restrict owner execution privileges.

Clean up only identified obsolete staging/install services and bounded temporary artifacts after checking usage and preserving needed release evidence. Do not delete deduplication/recovery journals as generic log cleanup. Review Android lint warnings individually; a warning count is neither a confirmed defect count nor a reason for indiscriminate stack upgrades.

## Windows directory transfer qualification

The cross-volume fallback uses literal DOS/UNC arguments for Robocopy, which handles long paths itself but rejects extended namespace prefixes. File/ACL APIs still receive extended-length paths. Tree compression is applied through native file/directory handles rather than `compact.exe`; directory timestamps use directory APIs, and joining native paths does not depend on PowerShell drive providers. Native regressions exercise compressed and uncompressed trees against opposite staging defaults at short and extended path lengths. The regression injects the initial cross-volume error on synthetic files; it does not format or mount a test volume.

Terminal status requests receive the attempt/shutdown abort signal rather than merely abandoning their returned promise. Task-run reconciliation scans at most ten pages per attempt and carries an in-memory cursor across bounded attempts, so older runs beyond offset 500 remain discoverable. Process restart starts the lookup at zero without mutating historical journal formats; completed, removed or corrupt entries do not retain lookup state.

Windows transfer staging normalizes the temporary-directory prefix as well as file/ACL paths. Native regressions cover both new and existing destinations inside parent directories longer than 260 characters; a long filename in a short parent is not equivalent coverage.

Historical reconciliation is an explicit operator disposition, not an attachment ACK. The historical_resolved journal state retains the original reservation key/hash/job/run, stores a SHA-256 of the unresolved receipt plus the retrospective evidence record ID, is excluded from delivery retries, and still blocks executor replay for the same idempotency key. Normal journal writes and historical disposition share an exclusive per-receipt lock; a stale lock fails closed for inspection. The operator command requires absolute journal/recovery directories, applies the normal bounded no-follow read before hashing, and writes a durable byte-for-byte recovery copy before replacement. It may only be created from a tracking receipt with no attachment ACK and exact expected identifiers.

## Bounded results and delivery recovery (R01/R02/R04)

The final tool result is validated after compaction against both semantic Zod
checks and the exact advertised JSON Schema. Unknown properties are not accepted
merely because Zod would strip them. All tool schemas explicitly advertise result
metadata and an alternative `{resultOmitted:true,resultRecovery:...}` envelope.
A validation failure returns a typed `result_validation_failed` receipt with a
read-only recovery reference; serialization/delivery preparation failures use
`result_delivery_failed`. Neither permits replay. Non-JSON callback results have
an explicitly labelled inspection representation, not a fabricated exact JSON
receipt. Normal retained results preserve the original JSON tool result, including
its original text and structured representations.

`structuredContent` is limited to 64 KiB and the entire JSON tool result
(`content` plus `structuredContent`, before JSON-RPC/HTTP framing) to 256 KiB.
Small legacy text arrays/objects remain compatible. A compacted response puts the
same bounded page/envelope in text and structured content; full legacy JSON is
no longer secretly carried as an unbounded second copy. Clients must inspect
`structuredContentTruncated`, `contentTruncated`, `resultOmitted` and `resultRecovery`. Unknown payload
shapes are omitted explicitly instead of recursively clipping IDs, base64 data,
recovery paths, counts or cursor semantics. Images/resources exceeding the total
budget are accessible in the retained original result, through authenticated
recovery pages. An absent immediate image is not evidence that capture failed.

`fs_read` pages preserve canonical base64 and count only bytes actually returned.
A shortened page advances `nextOffset` by those bytes and clears `eof`; line-mode
continuation also updates `linesRead`, `nextLine` and `partialLine`. Continue with
the returned byte offset, or recover the original receipt to avoid rereading a
changing source. Versioned reads retain `sourceVersion`. UTF-8 byte pages and
previews end on codepoint boundaries; a requested page smaller than one codepoint
can return up to three extra bytes to make progress. An explicit offset inside a
codepoint is rejected; arbitrary byte offsets require base64. Invalid UTF-8 input
is not promised to round-trip through a UTF-8 string; use base64 for arbitrary
binary content. Strict writer base64 validation still precedes any mutation.

History pages shorten at row boundaries. An oversized row retains ID, state,
start time and a bounded command preview with `commandTruncated`/`detailsOmitted`.
`job_status` reads its details; the page recovery reference retains the full
original rows, including any fields absent from the preview. `nextCursor` refers
to the last row actually delivered. Text and structured clients see the same
navigation. Ordinary history corruption `partial` keeps its existing meaning.

For exec, `requestSucceeded` means an agent execution receipt was received.
`executionOutcome` distinguishes `exit_zero`, `exit_nonzero`, `signal`, `timeout`,
`cancelled`, `uncertain` and `not_started`. Verified cancellation requires
`terminationVerified`; cancellation requested without that proof is uncertain.
A request exception after dispatch is uncertain even for HTTP errors: it does
not prove the effect was absent. Exit zero with stderr is still exit zero.
`effectVerification:"unverified"` and `clientAcceptance:"unknown"` are separate
facts. Exit zero never independently certifies the intended effect.

Batch `ok`, `errors` and `partial` retain their request-level meanings. New
`summary` counts every input before preview selection, including omitted items;
`executionPartial` is true unless all commands report exit zero. `totalItems` and
`previewItems` describe a shortened preview. Request failures retain selected
agent/HTTP category, code, route and typed recovery fields through the same
bounded error serializer as individual calls. Cancellation prevents queued
batch dispatch, drains active calls and retains all slots as settled, uncertain
or not started. Resolving an identity still preflights every route before effects.
Diagnostics expose bounded execution-outcome counts, request errors,
`finalValidationFailures` and `resultPreparationFailures`, but reading a failed job remains a successful read. Diagnostics cannot
observe SDK/UI acceptance and do not claim effect verification.

### Read-only result recovery and its limits

Every ordinary tool invocation reserves a controller-memory result slot before
its handler runs and retains the result before final validation/compaction.
`result_recover({id,offset,length})` returns base64 pages of the original JSON,
with a maximum 12 KiB of decoded bytes per call. Concatenate decoded pages, then
parse JSON. This tool only reads; it never reruns the original operation. It uses
the same owner-authenticated MCP connection and creates no public file or URL.
HTTP sessions on the same controller share the registry/recovery store.

For an ID known **before** dispatch, call `result_recovery_prepare`, then supply
its ID in the normal MCP `tools/call` metadata:

```json
{
  "name": "exec",
  "arguments": {"device": "fixture", "command": "printf synthetic"},
  "_meta": {"resultRecoveryId": "<id returned by result_recovery_prepare>"}
}
```

After client rejection or disconnect, read that ID through `result_recover`.
Without a pre-reserved ID, call `result_recover({})` for an index of up to 64
retained IDs, states and tool/request correlation. It contains no arguments or
output. Request IDs whose JSON encoding exceeds 200 bytes are represented by `requestIdHash`
(SHA-256 of JSON-encoded request ID), never a silently truncated ID. Session IDs
are similarly represented by `sessionIdHash`. Do not guess between concurrent
calls; inspect correlation or read the candidate receipts. Reservations are single use. Reusing one, using an expired/released ID or an ID
from another controller fails closed before dispatch. This is not a durable
idempotency key or retry API. An unknown ID never authorizes a fresh execution.
`result_recovery_release` frees a completed or unused slot and cannot release an
active invocation. The index permits discovery even when the whole response is rejected; a
pre-reserved ID provides unambiguous correlation before dispatch.

Retention is up to 15 minutes after completion and at most 64 slots. Oldest
completed results may be evicted to admit a new call; active/unused reservations
are pinned until completion/expiry. If all slots are pinned, new admission fails
before dispatch. Read/release tools do not consume result slots. Paging is
bounded, but retained receipt memory scales with the original output size; this
is not a storage quota or a substitute for durable large-output jobs. Controller
restart/crash, expiry and eviction can make memory recovery unavailable. Absence
always means inspect existing durable evidence, never replay. Use `job_start`
with a stable agent idempotency key and `job_output` for restart-safe execution
and complete durable output.

Controller-memory result recovery remains distinct from the durable batch
recovery below. Physical power-loss durability and client/platform qualification
remain separate acceptance work (R11–R12).

Controller compaction is compatible with existing agent result fields. The
source-side UTF-8 fix requires the updated agent; a new controller cannot
reconstruct codepoints already replaced by an older agent. Agent/controller
rollout and live acceptance remain separate from source tests.


## Durable batch recovery (R03)

`batch_exec` defaults to durable mode and requires an `operationKey` chosen by
its caller before effects. Configure the controller's existing `RCMCP_STATE_DIR`
as an absolute private path and preserve it across releases. The controller
uses `batch-operations` below that directory and the agent's existing keyed-job
reservations and output files. Every route is resolved before dispatch; every
agent identity must advertise `job-key-recovery-v1` before the first start.
Upgrade agents before enabling durable batches on a new controller. Old agents
fail closed before command dispatch.

The complete bounded manifest and permanent operation reservation precede the
first start. Each item records its route, route configuration hash, fingerprint,
working-directory hash, deterministic agent key, timestamps, state, job ID and
output reference. Command/environment values and stdout are absent. Fingerprints
cover ordered items, resolved routes, command, cwd and environment sorted by
code-unit key order. Concurrency is scheduling, not command identity. Identity
configuration changes cannot redirect recovery to a different endpoint.

An existing key with different inputs conflicts. An existing key with identical
inputs only reconciles existing work, including after a controller crash; it
never starts even the remaining `not_started` items. Use
`batch_recover({operationKey})` or `batch_recover({operationId})` to inspect the
same manifest plus read-only agent status/key lookups. A key lookup must prove
the original agent input fingerprint and matching job ID before its result is
associated with the batch; a collision remains explicit conflict. Unknown/corrupt/missing
records remain unavailable or uncertain. A missing agent reservation does not
turn `start_uncertain` into `not_started`. Recovery never calls exec/start.
`lastCheckedAt` and `observation` distinguish current observation from retained
facts. Recovery does not write over the dispatch writer's manifest.
Recovery reads use at most four concurrent requests. Cancellation of either
`batch_recover` or an identical-key `batch_exec` retry stops queued lookups and
forwards the caller signal to active status/key requests, which are drained.
Cancellation rejects the recovery call after draining active reads. It neither
cancels durable jobs nor changes their stored manifest.

Durable batch results are admission/recovery inventories, not synchronous exec
receipts. States are `not_started`, `start_uncertain`, `running`, `terminal` and
`failed`; `executionState` and `exitCode` retain the agent outcome. Verification
is always `unknown`. Read full output using `job_output`/`job_wait` with the
recorded device, context and job ID; each stream reference begins at cursor 0.
Cancellation prevents new starts, drains started requests and records remaining
items. It does not kill jobs. Termination requires a separate explicit
`job_cancel`. Synchronous `timeoutMs`/`maxOutputBytes` are rejected in durable
mode before effects rather than silently ignored.

For deliberate compatibility, `mode:"legacy"` retains synchronous batch exec,
its existing timeouts and output contract, plus a visible generated operation
ID and `restartRecoverable:false`. It does not accept an operation key. Its
memory result recovery cannot survive restart. Existing clients must explicitly
select this mode or migrate to keyed durable jobs; omission of a key in default
mode fails before effects. Owner/raw exec and execution identities are unchanged.

Manifests are at most 128 KiB, batches at most 64 items, and permanent operation
slots at most 512 per configured state directory. Aggregate admission/persistence
checks enforce a 64 MiB ceiling including orphan staging files. Capacity
exhaustion fails before further starts; no age-based eviction frees a key for
reuse. Reservations and tombstones are recovery evidence, not disposable logs.
Archive/migrate state only through an explicit owner-controlled retention plan
that preserves no-replay keys. Abandoned admission locks fail closed. SIGKILL
tests are not physical power-loss or arbitrary disk-loss certification.

## Bridge convergence and journal cost (R05–R06)

Bridge diagnostics distinguish transient errors, lookup in progress, missing or
conflicting proof, reconciliation required and terminal-negative evidence.
Bounded pending details include age, last/next attempt, actual attempt/retry
counts and a separately capped backoff exponent. Retry failures are durably counted; unchanged successful polls are counted in
process memory until the next durable fact. Counters introduced after a legacy
receipt cannot reconstruct its earlier retry history. Successful unchanged
running polls update only process-local scheduling, except that the first
successful running poll after failures persists one reset of the backoff and
error category. Subsequent healthy polls make zero scheduling writes. A saved
reset survives disk reconciliation and restart. A failed reset write retains
the last durable failure count and uses process-local journal-write retry
backoff. Restart before a saved reset recovers the old durable count and due
time, not that process-local delay. Reservation, attachment ACK,
terminal observation and delivery remain durable; retry failures still persist
backoff and categories. Restart can poll sooner, never execute again. Diagnostics
count durable writes and scheduling writes avoided and expose the last directory
snapshot's age and 60-second external reconciliation bound.

Directory snapshots explicitly count locks and locks without JSON receipts.
Neither age nor a dead PID authorizes deletion. `reconcile-contextkeep-lock.ts`
requires all writers fenced, the exact lock hash, original bounded receipt bytes,
a matching receipt hash, and the complete CK evidence tuple. It durably backs up
receipt and lock, publishes a historical no-replay tombstone, and archives the
lock. Missing/mismatched evidence fails closed. A failed or crashed reconciliation
can retain a reconciliation lock and requires inspection, not automatic cleanup.

`resolve-contextkeep-history.ts` now requires an absolute evidence JSON file in
addition to its original identifiers. Evidence binds journal SHA-256, project,
task, run, job, revision, evidence-record ID, terminal status and verification.
New historical resolutions require that tuple; existing v1/v2/v3 journals remain
readable. Original bytes are backed up before replacement. Historical resolution
is not an attachment ACK and preserves negative executor/CK evidence. Known
failed/lost outcomes and failed verification cannot be rewritten as passed.
Validated terminal remote evidence is retained on ordinary reconciliation too.
No production cohort is modified by this source feature.

## Incremental history and shared observation (R07–R08)

Own metadata transitions/removals update the process-local history index after
successful persistence. Directory namespace and generation checks detect external additions and
deletions even when filesystem timestamps collide. Metadata reconciliation runs after one second; an unconditional content sweep
after 30 seconds bounds same-size edits whose filesystem timestamps also collide.
Intervals start after a scan finishes and apply on the next query; scan duration
is additional. Generation changes can trigger earlier reconciliation. `freshness` states the last
reconciliation timestamp, age and bound. Active reconciliation updates filters
before page selection. The warm unchanged activeIds/page pair performs no
receipt stats/JSON reads. It still lists directory names, performs directory stats, scans
in-memory entries and sorts matching rows; this is not a persistent database.
The synthetic `scripts/benchmark-history.ts` measures both the previous warm
2N-stat pattern and the new index on 100/1k/5k/10k/100k receipts. It does not open
configured agent state. Existing tie/cursor/delete/corruption semantics remain.

Each agent identity/state directory shares a status sample and in-flight status
read per job for 200 ms. Across device/identity boundaries observers are separate.
Up to 1024 active subscribers share polls; no output queue is retained. Each
subscriber reads its own bounded output pages and cursors. Slow readers do not
retain copies for other readers. Cancelling a follower releases only that
subscriber; the job and other followers continue. The last release removes the
observer; a new observer or restarted agent reads authoritative disk state.
Distinct cursors still require distinct output reads and HTTP requests.

## Observable diagnostic stages (R09)

Bounded process-local traces correlate request, operation, job and CK project/
task/run separately using hashes. They retain no commands, arguments, credentials
or private output. Observable durations include handler, agent request, intentional
execution wait, persistence, reconciliation, result preparation and final schema
validation; total bytes cover the final tool result before RPC/HTTP framing.
Stages overlap: remote wait is part of the agent request, and validation is part
of preparation. An unobservable pre-handler queue is `queueMs:null`, not zero.
CK retry/persistence counts, persistence time, last pump duration and
reconciliation freshness are available in bridge diagnostics. Agent error kinds
include timeout separately from caller cancellation. Final validation/preparation failures remain explicit counters.

`diagnostic_wait_report` accepts a bounded request identifier and a client or
orchestrator source for an explicit caller-reported wait expiry. This is separate
from controller-to-agent request timeout and from observed caller cancellation.
A disconnect does not prove a client timer expired. Neither this report nor a
validated result proves client/UI/platform acceptance, which remains unknown.

## Remaining work

R10 and R11 source contracts and the installed-SDK HTTP matrix are documented
below. R12 still needs native Windows
and physical-device qualification, exact release review/CI, supported rollout,
recovery-copy checks, runtime identity, live connector catalog refresh and
post-deployment functional evidence.
Source tests and synthetic SIGKILL/I/O injection do not close those packages.

## Durable Linux job cgroup isolation (R12)

Detaching a process does not move it out of its parent's systemd cgroup. Heavy
durable workloads sharing the agent service can therefore cause a cgroup OOM
kill to take down the agent and interrupt unrelated MCP sessions. A
`KillMode=process` agent can also leave helpers and descendants behind on stop.

On Linux with cgroup v2 and a usable systemd user manager, durable jobs are
admitted with `systemd-run --user` as separate transient services named only
`rcmcp-job-<job-UUID>.service`. They are not bound to the agent service lifetime.
Admission uses `Type=exec`, does not wait for the workload to finish, and obtains
the actual service MainPID. The service has `Restart=no`,
`KillMode=control-group`, bounded TERM-to-KILL escalation and
`RemainAfterExit=yes` for recovery inspection. Retained units are released when
their job is removed. The user-agent template uses `KillMode=control-group` so
non-durable helpers are cleaned on stop while separate durable services survive.
This fixes the cgroup boundary; it does not raise memory limits or rely on
`OOMPolicy=continue`. An OOM policy targeting the entire user slice can still
affect multiple services and requires separate host qualification.
Before promoting the cleanup policy, drain or explicitly account for legacy
jobs still inside the agent cgroup: restarting with the new policy would stop
those pre-isolation workloads. Existing jobs are not silently migrated.

Command text and environment values are carried in a private mode-0600 launch
file, never in unit names, descriptions, systemd command arguments or admission
errors. An immutable launcher in the state directory publishes and fsyncs a
process identity/cgroup receipt before execing the existing shell runner. The
runner appends to the existing private stdout/stderr files and uses the same
durable exit-marker helper. Launcher, runner and helper do not depend on a
mutable repository checkout. Retain these files, job metadata and key
reservations together for recovery.

`JobMeta.systemdUnit`, `systemdInvocation` and `systemdCgroup` are optional,
additive fields. Metadata is published before admission; a reserved but
unresolved admission reports PID 0 and an explicit recovery reason. A failed
or interrupted admission returns `job_start_uncertain` with its job UUID,
preserving private launch/output/receipt files. Retrying the same key inspects
that reservation, service and receipt; it never submits another service or
falls back to spawn. A failed unit lookup alone never means not-started.
Unknown outcomes remain inspectable, and a new intended execution needs a new
key. These guarantees preserve R03; they do not promise exactly-once effects
under disk loss or arbitrary power failure.

Status/wait/output recovery uses the durable launcher receipt, service state,
MainPID/invocation and recursive cgroup population. An exit marker cannot make
a job terminal while background descendants still occupy its cgroup. Verified
cancel stops only the UUID-bound transient unit and requires successful stop
plus kernel evidence of an empty cgroup. An unavailable manager, identity
mismatch or incomplete stop remains unverified. A crash between stop and the
terminal metadata write can recover as `lost`, not falsely verified cancelled.
Legacy/non-systemd jobs retain their process-lineage cancellation fallback.
Containment describes members of the job cgroup; privileged workloads that
deliberately move work into unrelated services are outside this boundary.

`job-cgroup-isolation-v1` is advertised only after a successful harmless user
service probe using the required systemd options. The process caches that
probe; it is not a continuous manager-health guarantee. Runtime diagnostics
include `checks.jobCgroupIsolation` with a safe readiness reason. Non-Linux,
unavailable/unsupported systemd, non-v2 cgroups, or
`RCMCP_JOB_CGROUP_ISOLATION=0` use legacy spawn without advertising isolation.
An unavailable runtime does not silently retry an already-attempted admission.
Windows keeps its existing launch and recovery path.

The systemd integration suite reports an explicit unavailable reason when
skipped. On a usable Linux user manager it checks separate agent/job cgroups,
parent exit, durable output and wait/recovery, lost admission replies without
replay, private command/environment transport and cancellation of detached,
environment-scrubbed descendants. Existing legacy cancellation tests run with
isolation explicitly disabled. Synthetic local tests do not qualify production
OOM behavior, a deployed agent restart, Windows hardware, live client recovery
or the remaining R12 release gates above.

## High-level resource coordination (R10)

Agent high-level repository writes, service mutations, project execution and
resource-identifiable deployments share a durable resource journal. Raw exec,
raw filesystem/editor operations, job controls, service status and unrelated
reads do not acquire a resource reservation. A deployment without `repoPath`
or `cwd` has no identifiable resource and remains outside this coordination.

Use `resource_coordination` with `action:"acquire"` and a repository/project path
or service name. Pass its `token` as `coordination` to the high-level mutation.
Without a supplied token, the current agent performs a one-shot reservation and
base revalidation. `inspect` exposes the current writer/operation UUID,
generation, observed base version, creation/update times and state. Conflicts
return a bounded reason and the current record. `release` cancels a reservation;
use `job_cancel` for an already-started job.

The agent resolves symlinks, common Git directories (including linked worktrees) and service aliases before
hashing the key. Records contain device, actual execution identity and canonical
resource digests, not commands, paths, environment values or patches. The
physical resource lock excludes execution identity so two identities cannot
silently claim the same resource. Linux user-scoped services additionally include the
user identity. Windows services are machine-wide: user/system scope aliases and
caller identities share the same resource key. Keep one shared, absolute `RCMCP_COORDINATION_DIR` for agents on a
device that need to coordinate across identities; defaults use
`RCMCP_STATE_DIR/coordination`. Separate directories are separate coordination
domains. Provision shared directory permissions and group inheritance externally,
then set `RCMCP_COORDINATION_FILE_MODE=0660` on every participating agent. Journal
replacements, budget slots and admission locks retain that mode regardless of
process umask. Only `0600` (the private default) and `0660` are accepted. Existing
directories and their ownership are never changed; existing private files need
operator-managed migration before cross-identity sharing.

A lease is only a reservation deadline (default 30 seconds, maximum 5 minutes).
Every admission increments its persisted generation. Apply checks the operation
UUID, generation, identity and freshly observed base. Repository bases include
the symbolic HEAD target (or detached marker), refs, index and working contents.
Bare repositories use the common Git directory, HEAD, refs and bounded repository
metadata without worktree scans. Expired, released,
replaced or stale tokens cannot apply. Owner override explicitly supplies the
observed generation and current base digest and a fixed reason; the journal
retains both writer IDs and the timestamp. It only replaces reservations,
never active/uncertain effects, and does not bypass apply-time revalidation.

Active operations do not expire. Durable job IDs remain associated with the
resource across controller/agent restart. Subsequent coordination requests
reconcile completed jobs; lost jobs and unverifiable effects remain blocked.
Before `job_remove` deletes terminal metadata, it durably preserves a small
`job-terminal-evidence` record in the job state directory. Reconciliation requires
an exact journal token, associated job ID, device and execution identity. Missing
or corrupt evidence remains fenced. Keep these tombstones with job-start keys in
private backups; removal never authorizes replay.

Product execution boundaries distinguish planning/validation failures from effect
submission. An invocation-scoped no-effect proof releases only that invocation's
exact matching active reservation, preserving its generation and base digest.
Unknown errors after submission remain uncertain; error status alone is not proof.
A crash between admission/effect/receipt is uncertainty, not permission to
replay. Existing keyed retries still resolve the original derived command and
validate its durable fingerprint before consulting mutable project state.
Never delete journals to retry uncertain work. A foreground operation settles
before release; cancellation without verified termination retains uncertainty.

Admission is fail-fast, with four reserved/active/uncertain operation slots per device and
four concurrent base probes per agent. Control/read requests use neither lane.
There is no unbounded waiting queue. New-resource admission refuses a directory
scan containing 512 journals; concurrent first admissions can overshoot this
retention threshold. Each resource allows up to 32 override audit entries and
each record is bounded to 16 KiB. Limits refuse admission instead of discarding
fencing evidence. The four-slot device budget is atomic across processes.
Atomic exclusive budget-slot files share that bound across coordinator processes.
Short exclusive resource locks are held only during journal transitions, not
while commands run. Expired reservations release their slots under their own
resource fence. An orphan resource lock, missing/mismatched slot journal or corrupt slot is retained and blocks
that resource/slot; other resources can use remaining slots. Private inspection
is required; age/PID alone never clears uncertain evidence. Health and job
controls remain available even when every slot is occupied.

Base revalidation detects repository HEAD/refs/index and tracked/non-ignored
file changes using bounded metadata/content hashing (4,096 entries, 64 MiB).
Larger resources fail closed with `base_probe_limit`; use raw owner operations
when deliberately working outside this bounded high-level contract. Non-Git
projects cover immediate entries/files, not a recursive dependency snapshot.
Service bases use the service manager's resolved status. Files ignored by Git,
remote refs changed externally after the probe, arbitrary shell/deployment
phase effects, detached descendants and external editors are not fenced by
this protocol. Checks before dispatch reduce stale-base errors but do not
provide a filesystem transaction or prevent an external edit after the last
check. Command phases within an admitted deployment retain the resource until
the job settles; they are not individually transactional commits.

## MCP/SDK compatibility matrix (R11)

The pinned SDK remains **1.30.0**. Authenticated HTTP health includes a bounded
`compatibility` snapshot (last 32 observations): installed SDK version, catalog
revision, session mode, response mode and the protocol version actually emitted
by the SDK's initialize response. Legacy calls without initialize report
`protocolVersion:null`/`not_negotiated`. A request header or documentation URL
is not evidence of negotiated protocol. The observation adapter uses the SDK's
public transport `send`; private registry reuse remains isolated in
`sdk-tool-registry.ts`.

| Client / server path | Supported behavior and qualification |
| --- | --- |
| Installed SDK client → production HTTP, stateful SSE (default) | Initialize, listTools, independent sessions, schema validation, result recovery, catalog rediscovery and cancellation |
| Installed SDK client → production HTTP, stateful JSON | Same matrix; `RCMCP_MCP_JSON_RESPONSE=1` selects JSON responses |
| Installed SDK client → production HTTP, stateless JSON/SSE | Initialize/discovery/results/recovery; `RCMCP_MCP_SESSION_MODE=stateless`; cross-request cancellation notifications have no persistent session to target |
| Legacy HTTP without initialize | Existing stateless discovery/calls remain supported; negotiation is explicitly unknown |
| Installed SDK in-memory client | Existing contract, output validation, recovery and durable batch regressions |
| Stdio server | Negotiation observation uses the same adapter; transport/hardware qualification remains separate from the HTTP matrix |
| ChatGPT connector/catalog cache | A new live ChatGPT session must rediscover changed schemas; automated SDK discovery does not certify that external cache |

Catalog definitions are immutable for a running controller. Reconnect and call
`listTools` after changing the controller release. The diagnostic catalog
revision identifies this contract family; actual runtime SHA still identifies
the release. No test in this matrix proves a live external client's UI accepted
a result.

| Agent combination | Gate / fallback |
| --- | --- |
| Current controller + current agent | `high-level-coordination-v1`, `utf8-byte-pages-v1`, `job-key-recovery-v1` advertised and checked for their operations |
| Current controller + old agent missing coordination | Coordinated/resource-identifiable high-level mutations fail before dispatch with `agent_upgrade_required` |
| Current controller + old agent missing UTF-8 byte-page semantics | UTF-8 file reads fail clearly; explicit base64 reads preserve access to exact bytes without assuming old UTF-8 cursors are safe |
| Current controller + old agent missing durable key recovery | Durable batch checks every selected identity before any start; explicit legacy synchronous batch mode retains its documented limits |
| Additive read endpoints absent on an old agent | Existing process/docker summary fallbacks use the compatible full read only on 404; no effect replay |
| Old controller + current agent | Existing routes remain; agent high-level coordination adds receipts/conflicts. Old clients do not gain explicit reservation/override control |

Roll out compatible agents first (including every configured execution
identity), configure the shared coordination directory where needed, then
upgrade the controller and refresh client catalogs. Preserve job/key and
coordination state on rollback. This source matrix does not authorize an
operational rollout or certify physical Windows/Android behavior.
