# Ingress observations and usage reports

This contract separates HTTP requests, controller tool calls, durable executions, and independently verified effects. A successful HTTP response is not proof that a client consumed it or that a task completed.

## Entry points and attribution

| Route into the system | Observation location | What the evidence establishes |
|---|---|---|
| Modern or legacy MCP HTTP | Controller HTTP lifecycle and tool diagnostics | Local response finish, premature close or request abort; client consumption stays unknown. |
| MCP stdio | Tool diagnostics and outgoing agent dispatch | Tool/agent correlation; there is no HTTP client connection to describe. |
| Controller AgentClient JSON requests | Dispatch counters, agent ingress hooks and response receipt | One HTTP attempt linked to one agent event when its receipt matches. Capability probes count too. |
| Controller raw-file reads | Dispatch counters and the same agent hooks | Headers received, body completion, cancellation, timeout and protocol errors remain distinct. |
| Direct HTTP clients and automation | Agent ingress hooks | Every admitted request counts; caller identity remains unassigned unless separately authenticated. |
| Agent-to-agent direct transfer GET/HEAD | Receiving agent ingress hooks | Requests count as unattributed. This path does not yet propagate the parent controller correlation. |
| TCP relays, tunnels and reverse proxies | Their own configured logs plus downstream observations | The final socket peer can be a relay. Loopback is not the original caller. |
| Android reverse transport | Existing Android command and connection journals | Separate transport/effect semantics; HTTP-agent ingress counters do not represent the Android workload. |

Keep the actual route map, credentials, proxy configuration and coverage gaps private. A difference between controller tool calls and agent requests is not proof of direct traffic: one tool can dispatch multiple requests, probes can be unobserved at tool level, and retained traces can omit detail.

## Correlation and trust

A controller-to-agent HTTP request sends bounded version-1 correlation in `x-rcmcp-correlation`. Only UUID fields are accepted: controller instance, dispatch, optional operation trace, optional controller HTTP request, optional diagnostic scope, and optional ContextKeep project/task/run. Unknown fields, oversized headers and noncanonical encodings are rejected as diagnostic metadata. They do not cause workload replay.

The agent authenticates the bearer independently. A shared bearer establishes credential possession. It does not identify a controller process, original client, person or task. Correlation is therefore labelled `controller_claimed`. Unauthenticated correlation cannot create that attribution, and no request label can replace the agent's configured execution identity.

A request authenticated with the configured bearer receives `x-rcmcp-ingress`, with the agent instance, monotonic request sequence, stable event ID and matching dispatch UUID. The controller validates the schema and echoed dispatch before using the receipt for diagnostic correlation. This header is not a signed endpoint attestation. Endpoint authenticity still depends on the configured transport and credential boundary; a substituted endpoint that receives the bearer cannot be authenticated by adding a MAC based on that same bearer. Older agents without the header continue to work; their receipt state is explicitly missing. No diagnostic match authorizes an action, resolves an execution fence or verifies an external effect.

These IDs are independent:

| Identifier | Purpose | Not a substitute for |
|---|---|---|
| JSON-RPC request ID | Identify one protocol request | A command fingerprint or deduplication key |
| Existing requestHash | SHA-256 of the JSON-encoded JSON-RPC request ID | A hash of command/cwd/environment |
| Controller HTTP request UUID | Correlate local HTTP lifecycle and downstream dispatch | Proof of client acceptance |
| Operation trace / diagnostic scope | Associate diagnostic evidence | Authorization or execution identity |
| Dispatch UUID | Identify one HTTP attempt | A durable job key |
| Agent instance + sequence | Deduplicate delivery of the same ingress event | An execution result |
| Durable job/operation key and recovery receipt | Recover the original intended execution | Permission to replay after uncertainty |

A new HTTP request can refer to the same durable job or operation. Propagating correlation does not modify request bodies, input fingerprints, keys, leases, coordination fences or the strict version-1 operation journal.

ContextKeep correlation is copied only from the existing validated observation association. It contains no lease token. It is not a new attachment or a claim that ContextKeep accepted, verified or completed work.

Detailed samples use the existing bearer-authorized diagnostic access boundary. Any holder of that credential can read the recent correlation UUIDs. These labels are not credentials or authenticated principals, and this endpoint does not promise per-caller isolation. Detailed diagnostics require authentication even when workload access is deliberately configured otherwise.

## Counters, history and bounds

Agent hooks count arrivals before the authentication gate. They include successful, rejected, direct and controller-labelled traffic. Registered route templates and a fixed method/authentication/origin vocabulary bound cardinality. Unknown URLs collapse to `other`; query strings and arbitrary paths are not telemetry dimensions. Commands, arguments, environment values, secrets and raw output are not collected.

`counterScope: current_process` identifies totals, source buckets, route series and sequence. They reset with a new process/instance and remain independent of the last-request sample window. `history.scope: retained_utc_arrival_days` identifies the separately retained daily cohorts, while `coverage.persistenceScope: daily_aggregates` states what is written to disk. A sample starts at revision 1 and finishes at revision 2 with the same event ID. Duplicate completion cannot increment totals. The observer's duplicate counter detects repeated direct `finish(handle)` calls. HTTP close/abort/finish signals for one ending are deliberately coalesced before that call; their normal repetition is not counted as a duplicate workload. Repeated page delivery is not a new request.

Controller dispatch outcomes describe what this process observed. When the combined signal is aborted, its first abort reason determines timeout versus caller cancellation. A simultaneous socket failure does not establish a separately attributable network cause. These counters are not physical link-failure measurements.

A raw body is complete when the consumer receives all declared `Content-Length` bytes, or when the stream ends normally without a declared length. Stopping after all declared bytes is successful payload delivery to that consumer even if it does not request a final iterator step. Stopping early remains cancellation. This does not prove downstream client acceptance or an independently verified effect. Controller `/v1/fs` counters group text reads and raw transfers; byte throughput and per-mode capacity attribution are not supplied by that fixed family.

| Setting or dimension | Default / bound |
|---|---|
| Daily retention | 90 UTC days; RCMCP_INGRESS_RETENTION_DAYS accepts 60–90 |
| Registered route templates | At most 256 |
| Current route/method/origin/authentication series | At most 256; overflow requests remain in total counters |
| Agent trace samples | Last 128 requests in production |
| Controller dispatch samples | Last 128 completed dispatches globally, before device/identity filtering |
| Agent aggregate file | Default maximum 2 MiB, separate from recovery journals |
| Aggregate flush | One-second debounce; pending changes and actual flush duration are reported |
| usage_report sample page | Default 16, maximum 32; zero disables detail |
| usage_report series page | Default 0, maximum 32 |
| usage_report daily page | Default 7, maximum 14; newest date first |

The controller retains one shared dispatch-sample ring across all targets and filters it by device/identity afterward. Traffic to another target can evict a selected target's dispatch while the corresponding agent event is still retained. Quieting only the selected agent does not protect the controller ring. Preserve bounded original matching metadata promptly when it is needed as evidence; counters and retained daily aggregates do not recreate an evicted dispatch. A missing live sample states a coverage limit, not failed execution, and does not authorize a replacement job.

Daily aggregates use the UTC arrival day. A late completion updates that arrival cohort while it is retained. Older completions are reported outside retention. Received minus completed means missing completion evidence, not proof of a currently running command. Daily route, execution outcome, effect verification and client acceptance dimensions remain explicitly unsupported.

The aggregate file is `agent-ingress-v1/aggregate.json` under the configured agent state root. A writer must exclusively create `aggregate.json.writer`, retain its descriptor and verify its file identity before each publication. A second writer keeps current observations in memory and can read retained history, but reports unavailable persistence and required repair. A missing or replaced claim also blocks publication explicitly. This exclusion assumes cooperative writers and a private state directory. It does not provide transaction isolation against an administrator replacing the claim or directory between the ownership check and publication; never change that namespace while a writer is active. A confirmed save describes a successful publication under those checks, not continuous attestation of namespace ownership. Atomic snapshots are independent of operation/recovery retention and do not replay logs. Corrupt or incompatible evidence stays intact; collection continues in memory with unavailable persistence. No recovery journal is pruned to make room for a usage report.

SIGTERM/SIGINT begins one shared shutdown sequence. Its handlers are installed before the writer claim is acquired, and repeated signals do not bypass cleanup. The HTTP server and tracked sockets have five seconds to drain gracefully. Tracking includes the primary listener's accepted connections and admitted HTTP requests on every listener, including additional localhost bindings. If they remain, the agent destroys those tracked sockets and preserves a full three additional seconds for existing request-owned cancellation and drain. Secondary connections whose headers were never parsed are not admitted HTTP requests; final process termination closes their descriptors without inventing an HTTP completion.

After recording observed ingress state and attempting claim release, normal POSIX shutdown restores the requested stop signal's default handling and sends that signal only to `process.pid`. This avoids the native threadpool join in `process.exit()` when a worker is blocked opening a FIFO. A detected cleanup failure uses SIGKILL only on that same process, after the cleanup attempts; it is distinct from a normal stop and produces no core dump. No process group or detached job is signalled by this final step. Windows retains its exit-code path and is not qualified by the Linux FIFO probes. SIGTERM/SIGINT are reserved for application shutdown; native signal overrides, a blocked main event loop and uninterruptible kernel I/O are outside this bound. Unfinished HTTP requests remain unfinished, and a normal agent stop does not prove successful requests, child termination or external effects. Durable-job code and execution fences are unchanged.

Normal POSIX shutdown ends by SIGTERM or SIGINT rather than exit code zero. Node's child-process exit event reports a null code and the terminating signal. Bash on Linux commonly exposes wait status 143 or 130; the SIGKILL failure path commonly appears as 137. These shell conventions are distinct from an application exit code. Under systemd's default clean-signal classification, a `Type=simple` service treats SIGTERM and SIGINT as clean termination; these signals alone do not trigger `Restart=on-failure`. See the [official systemd restart rules](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart=). A wrapper that converts a signal result into a numeric exit code can change what its supervisor observes, so interpret the actual wrapper and unit policy.

A clean restart interval still represents time without observation. An abrupt crash can leave an orphaned writer claim. It survives every later restart until an operator inspects and recovers ownership; restarting repeatedly does not restore durable collection. Retained history remains readable and current memory counters continue, with unavailable persistence and required repair. The claim is never reclaimed automatically, even when a PID appears absent. An `EEXIST` from exclusive creation of the claim pathname reports `state_writer_locked`; it establishes blocked acquisition, not a live owner or a valid regular-file claim. An orphaned claim, directory or other object producing that result follows the same conservative path and produces `writer_continuity_unknown` when valid prior history is available, including prior unfinished observations. Failures creating the state directory, and claim-open errors other than `EEXIST`, retain the saved clean/unclean shutdown marker while reporting unavailable persistence. The process UUID must be fresh for every boot; persisted `lastSequence` is a checkpoint of that instance, not a durable allocator for reused instance IDs.

Read each `history.gaps` reason separately. `writer_continuity_unknown` does not assert that its interval lacked observations: another writer may have continued collecting. Its `from` is the retained checkpoint and its `to` is this reader's start, not proof that durable collection resumed. This non-owner view is transient and is never published while ownership is unavailable. Current-process memory counters and persistence coverage remain separate.

An abrupt shutdown can lose the unflushed tail. Storage failures and event-loop stalls can extend the debounce interval. Restart intervals, prior unfinished requests, persistence failures and omitted gap detail are reported. Increasing retention cannot restore missing history. A historical gap must not be presented as a current-process collection loss; current `processCountsComplete` and hook errors are reported separately. A hook failure invalidates that coverage claim without failing the requested workload.

Filesystem synchronization is platform-specific. The implementation synchronizes the file and, where supported, its directory. This is not arbitrary power-loss or restored-storage certification.

## Inspecting a blocked aggregate writer

Recovery of this telemetry claim requires an exclusive maintenance window. It does not recover execution journals, repository locks or uncertain operations.

1. Preserve the authenticated coverage report and private copies of the aggregate and claim, including hashes, file identity, ownership, permissions and observation time. Record the configured state root and the process/instance that uses it. An invalid, empty or nonregular claim is evidence to inspect, not permission to delete it. An empty claim still has bytes to hash and filesystem identity, ownership, mode and timestamps; a missing valid PID/instance payload leaves its provenance uncertain.
2. Stop the exact configured writer services through their supported shutdown path after checking their active work. Verify the captured process identities and service groups are stopped, and prevent another writer or maintenance actor from starting during recovery. Do not select processes by a command-line pattern, and do not treat PID absence alone as proof of quiescence.
3. With all writers for this state root confirmed stopped, recheck the original claim's type, identity and hash. If anything changed, inspect the new state. Otherwise move that exact telemetry claim to private quarantine without overwriting existing evidence. Preserve the aggregate. Do not alter coordination journals or locks belonging to other subsystems.
4. Start one configured writer. Verify the new runtime/claim identity and read bounded diagnostics. Require persistence to be available, no ownership repair fault, and a later successful save that includes an earlier observed sequence. A current `pending` state is normal because the diagnostic request itself changes counters. Keep the historical gap visible.
5. If ownership or storage remains unavailable, retain the evidence and inspect the directory permissions, filesystem and capacity. Do not repeatedly remove claims or infer that missing history has been restored.

`state_writer_release_failed` groups unconfirmed removal, directory synchronization and descriptor close into one release-phase fault. It also covers a release correctly declined after ownership changed; it does not distinguish these subcauses. The path may already be absent or belong to another owner. Inspect identity and accompanying faults before choosing recovery; this code alone never authorizes removing a claim. A partial acquire closes its descriptor and removes only a claim whose captured file identity still matches. If identity could not be established, the uncertain path remains for inspection. Automated orphan recovery remains open under HIS-01/HIS-04.

## Reading a report

`usage_report` selects one configured device and execution identity. It returns the agent's current-process counters, source buckets, bounded history/series/sample pages, and the controller's separately scoped dispatch observations. Offsets are live views, not frozen snapshots; use stable event IDs and revisions when combining pages. A disabled page has a terminal null cursor.

The report requires authenticated agent diagnostics even when an installation deliberately permits unauthenticated workload requests. Its agent read has a five-second timeout. If the agent is unreachable, returns an unsupported contract or lacks the diagnostic route, the result retains the controller snapshot with `agent: null` and an explicit `agentStatus` of `unsupported`, `timeout` or `error`. A healthy result reports `available` and uses one agent dispatch. Missing agent totals or history are never inferred from controller data. Explicit caller cancellation still ends the tool.

The controller's `totals` cover all agent dispatches in that controller process, as stated by `totalScope`; its selected peers and samples are filtered to the requested device/identity. Do not relabel the global total as a selected-device denominator.

The agent snapshot includes the diagnostic request currently producing it. Controller and agent process lifetimes and snapshot instants usually differ. The report therefore does not automatically divide one lifetime total by the other or present a controller success fraction as fleet workload success.

`usage_report` retains its independent-snapshot default. `usage_window` supplies a
separate bounded public collection workflow for OBS-04/HIS-02. Console reporting
and deployed acceptance remain separate and unqualified by source tests.

For an independently qualified fixed-window reconciliation:

1. Capture agent instance, sequence, counters, coverage and UTC time at both boundaries. A restart or incomplete coverage changes the interpretation.
2. Select events in that sequence/time window. Retain original pages and record which detail is absent or arrived late.
3. Match strict agent receipts to controller dispatches, including their immutable device, identity and correlation binding. Deduplicate stable identities.
4. Keep conflicting records unassigned in either delivery order. Malformed diagnostic metadata must not abort the whole comparison.
5. Report attributed requests plus explicitly unattributed requests against the agent denominator. Missing event detail can reflect sampling, collection gaps or late delivery; its cause is not inferred.

`reconcileIngressSamples` is the bounded primitive used by `usage_window`; `usage_report` does not invoke it. Its conservation residual and conflict/invalid counts remain visible. The caller must supply the correct complete window and independently bind its configured peer and execution identity. The helper does not reconstruct a window from unrelated lifetimes or authenticate an endpoint.

## Public same-window workflow

Use `usage_window` with one **canonical configured device name** and explicit
`identity: "root" | "owner" | "interactive"` on every call. Aliases and automatic
identity selection are rejected. This is read-only telemetry, with local memory
allocation; it neither executes workloads nor changes execution/recovery state.
The existing authenticated diagnostic trust domain applies: windows are not
isolated from another holder of the controller credential.

1. Call `action: "open"` without a window ID. Save `report.windowId` and require
   `agentStatus.state: "available"` with an established `report.start`. Only
   agents advertising `windowCollectionVersion: 1` establish a boundary. An old,
   malformed or unavailable agent leaves an `opening` report, with no inferred
   denominator; retry collection on that ID or let it expire.
2. Call `action: "collect"` with that ID periodically. Each call makes one
   authenticated, five-second-bounded agent read, requesting up to 32 events
   after the last collected sequence. Repeat to catch up before closing. There
   is no background poller and a busy window rejects concurrent actions. Samples
   are live; a burst can outpace collection or evict detail before it is read.
3. Call `action: "close"`. The first successful close freezes the end sequence
   and observation instant. Failed/unsupported reads and caller cancellation
   leave an established window active; they do not fabricate a boundary.
   A detected different agent instance produces `state: "restart"`, null
   denominator/reconciliation and incomplete coverage, never a subtraction
   across process lifetimes. A regressing same-instance snapshot is rejected.
4. Call `action: "read"` for retained reports. This makes no agent request.
   Repeating close after success also makes no agent request. Optional
   `detailOffset` (0–256) and `detailLimit` (0–16, default zero) page original
   selected-peer dispatch envelopes. A disabled page has a terminal null cursor.

The arrival window is `start.sequence < sequence <= end.sequence` on one agent
instance. The opening diagnostic is excluded. Intermediate and closing
requests count in the denominator. Boundary UTC times describe agent snapshot
instants; they are not synchronized controller/agent clocks. Sequence equality
with the received counter is validated. The report never divides unrelated
controller and agent lifetime counters.

The controller preserves envelopes at dispatch start, receipt and finish,
**before** insertion/eviction in its global 128-entry ring. An already-started
request whose receipt arrives during retention can also be captured. Unrelated
peer traffic cannot evict retained window envelopes. Dispatch UUID, canonical
peer, selected identity, route family, original start time, strict receipt and
correlation binding are preserved. An immutable conflict remains unassigned in
either delivery order. Invalid agent metadata is counted and never reflected
as arbitrary producer fields. Repeated event delivery does not increase the
denominator; invalid/conflicting revisions cannot restore attribution.

`agentDenominator` is the same-instance received-counter delta.
`denominatorExact` additionally requires complete current-process hooks and no
counter saturation at every collected boundary. `collectionResidual` is the exact received delta minus attributed and observed
unassigned events; it includes missing or excluded conflicting detail.
`reconciliation` additionally partitions that unknown remainder as explicitly
unattributed traffic and reports its own arithmetic conservation residual. A zero
conservation residual alone is not proof of complete detail,
correct origin, successful execution or complete collection. Conflicting event
identities are excluded from assignable detail and stay unattributed.
`missingEventDetail` counts absent identities separately. The portion no longer
in the agent's advertised arrival ring is
`missingNoLongerRetainedAtAgent`; `missingStillRetainedOrLate` has an unknown
collection/late-delivery cause. These fields do not infer that an operation
failed, never started or should be replayed.

`duplicateReceiptBindings` counts extra dispatch bindings to a single agent event;
all such conflicting receipt identities remain unassigned.
`receiptInvalid`, `receiptMissing` and `receiptPending` describe retained
envelopes, including attempts whose arrival cannot be assigned to the window.
Optional dispatch detail also includes such attempts and known out-of-window
receipts; only validated in-window receipts enter reconciliation. A controller
cancellation is an observation outcome, not proof of absent effects.
`lateReceiptDeliveries` counts first receipts observed after a boundary had
already included their arrival sequence. `lateDispatchObservations` counts
post-close envelope updates, including finishes. Late receipts/finishes for
retained attempts can improve a closed report until expiry, but never move its
end boundary. Agent samples are not collected after close; their later missing
or revised detail is explicitly unsupported. Offset detail pages can change
while late dispatch updates arrive.

Bounds are **8 retained windows per AgentClient, 256 event identities and 256
original dispatch envelopes per window, 15 minutes from open**, and 16 dispatch
details per output page. Expiry removes memory without extending on reads;
opening at capacity fails instead of evicting another retained window. Overflow
counts dropped *observations*, not unique requests, and prevents a complete
detail claim. Agent detail still has its independent 128-arrival ring.
Controller restart loses every window; an unknown/expired ID cannot be resumed
or reconstructed from aggregates. There is no durable window export.

`complete` means a closed, comparable collection with all event identities,
valid nonconflicting retained evidence, no pending receipt, no observed hook or
collector fault and no retention overflow. Explicit unattributed traffic can
remain. It never means complete fleet history, task success, client acceptance,
source attestation, authorization or verified effects. Historical gap counts,
collection start and retention days remain separate from the current window;
a legacy persistence gap alone does not invalidate complete current hooks.
Failures between polls and pre-observation requests cannot be independently
detected beyond reported hook/counter coverage. No physical platform or deployed
runtime acceptance follows from synthetic tests. Console integration remains
open under HIS-02/UX-07.

## Capability probe bounds

`capability_report` accepts at most 64 device entries, including an implicit full-inventory selection. It resolves aliases and probes each canonical device once. The input limit is checked before any endpoint is contacted. The reported budget is a per-endpoint timeout, not a shared quota across callers. A timeout and an explicit caller cancellation have distinct outcomes; cancellation also prevents queued endpoints from starting.

## Controller HTTP delivery

The controller issues a distinct `x-rcmcp-delivery-id` and records bounded HTTP lifecycle samples. A response finish, a premature connection close, and an aborted request have separate outcomes. A premature close remains incomplete even if status 200 was already sent. A normal finish followed by close counts once.

These are local server observations. They do not prove receipt by a proxy, mobile application or person. Long-lived SSE durations include connection lifetime. They are not command execution latency or pre-handler queue time.

Authenticated controller health exposes HTTP delivery and agent-dispatch diagnostics. Collection stays local and bounded. This change adds no mandatory trace exporter and no dependency on a remote telemetry service.

## Qualification and remaining scope

Synthetic tests cover all-counts-versus-sampling, direct/proxied attribution, batch dispatches, immutable duplicate conflicts, malformed metadata, ordinary and streaming cancellation, legacy agents, actual SDK discovery/pages, restart/rollover/corrupt-state handling, and coverage failures.

Private live qualification must independently verify the deployed source, identity, authentication, same-window receipts and preserved recovery evidence. A passing source suite does not resolve a historical uncertain execution, certify every fleet platform, or establish the cause of a client reconnect banner. Startup version drift, historical job-reference reconciliation, richer console reports and optional stage/export work retain their separate tracker acceptance.
