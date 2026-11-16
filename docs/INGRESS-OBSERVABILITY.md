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

The authenticated response includes `x-rcmcp-ingress`, with the agent instance, monotonic request sequence, stable event ID and matching dispatch UUID. The controller validates the receipt before using it for correlation. Older agents without this header continue to work; their receipt state is explicitly missing.

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

## Counters, history and bounds

Agent hooks count arrivals before the authentication gate. They include successful, rejected, direct and controller-labelled traffic. Registered route templates and a fixed method/authentication/origin vocabulary bound cardinality. Unknown URLs collapse to `other`; query strings and arbitrary paths are not telemetry dimensions. Commands, arguments, environment values, secrets and raw output are not collected.

Current process counters remain independent of the last-request sample window. A sample starts at revision 1 and finishes at revision 2 with the same event ID. Duplicate completion cannot increment totals. Repeated page delivery is not a new request.

| Setting or dimension | Default / bound |
|---|---|
| Daily retention | 90 UTC days; RCMCP_INGRESS_RETENTION_DAYS accepts 60–90 |
| Registered route templates | At most 256 |
| Current route/method/origin/authentication series | At most 256; overflow requests remain in total counters |
| Agent trace samples | Last 128 requests in production |
| Controller dispatch samples | Last 128 completed dispatches |
| Agent aggregate file | Default maximum 2 MiB, separate from recovery journals |
| Aggregate flush | One-second debounce; pending changes and actual flush duration are reported |
| usage_report sample page | Default 16, maximum 32; zero disables detail |
| usage_report series page | Default 0, maximum 32 |
| usage_report daily page | Default 7, maximum 14; newest date first |

Daily aggregates use the UTC arrival day. A late completion updates that arrival cohort while it is retained. Older completions are reported outside retention. Received minus completed means missing completion evidence, not proof of a currently running command. Daily route, execution outcome, effect verification and client acceptance dimensions remain explicitly unsupported.

The aggregate file is `agent-ingress-v1/aggregate.json` under the configured agent state root. One agent owns that directory. Atomic snapshots are independent of operation/recovery retention and do not replay logs. Corrupt or incompatible evidence stays intact; collection continues in memory with unavailable persistence. No recovery journal is pruned to make room for a usage report.

An abrupt shutdown can lose the unflushed tail. Storage failures and event-loop stalls can extend the debounce interval. Restart intervals, prior unfinished requests, persistence failures and omitted gap detail are reported. Increasing retention cannot restore missing history. A historical gap must not be presented as a current-process collection loss; current `processCountsComplete` and hook errors are reported separately. A hook failure invalidates that coverage claim without failing the requested workload.

Filesystem synchronization is platform-specific. The implementation synchronizes the file and, where supported, its directory. This is not arbitrary power-loss or restored-storage certification.

## Reading a report

`usage_report` selects one configured device and execution identity. It returns the agent's lifetime counters, source buckets, bounded history/series/sample pages, and the controller's separately scoped dispatch observations. Offsets are live views, not frozen snapshots; use stable event IDs and revisions when combining pages. A disabled page has a terminal null cursor.

The report requires authenticated agent diagnostics even when an installation deliberately permits unauthenticated workload requests. An old agent that lacks `agent-ingress-v1` cannot supply historical data by inference.

The agent snapshot includes the diagnostic request currently producing it. Controller and agent process lifetimes and snapshot instants usually differ. The report therefore does not automatically divide one lifetime total by the other or present a controller success fraction as fleet workload success.

For a private fixed-window reconciliation:

1. Capture agent instance, sequence, counters, coverage and UTC time at both boundaries. A restart or incomplete coverage changes the interpretation.
2. Select events in that sequence/time window. Retain original pages and record which detail is absent or arrived late.
3. Match strict agent receipts to controller dispatches, including their immutable device, identity and correlation binding. Deduplicate stable identities.
4. Keep conflicting records unassigned in either delivery order. Malformed diagnostic metadata must not abort the whole comparison.
5. Report attributed requests plus explicitly unattributed requests against the agent denominator. Missing event detail can reflect sampling, collection gaps or late delivery; its cause is not inferred.

`reconcileIngressSamples` implements this bounded comparison. Its conservation residual and conflict/invalid counts remain visible. The caller must supply the correct complete window; the helper does not reconstruct one from unrelated lifetimes.

## Controller HTTP delivery

The controller issues a distinct `x-rcmcp-delivery-id` and records bounded HTTP lifecycle samples. A response finish, a premature connection close, and an aborted request have separate outcomes. A premature close remains incomplete even if status 200 was already sent. A normal finish followed by close counts once.

These are local server observations. They do not prove receipt by a proxy, mobile application or person. Long-lived SSE durations include connection lifetime. They are not command execution latency or pre-handler queue time.

Authenticated controller health exposes HTTP delivery and agent-dispatch diagnostics. Collection stays local and bounded. This change adds no mandatory trace exporter and no dependency on a remote telemetry service.

## Qualification and remaining scope

Synthetic tests cover all-counts-versus-sampling, direct/proxied attribution, batch dispatches, immutable duplicate conflicts, malformed metadata, ordinary and streaming cancellation, legacy agents, actual SDK discovery/pages, restart/rollover/corrupt-state handling, and coverage failures.

Private live qualification must independently verify the deployed source, identity, authentication, same-window receipts and preserved recovery evidence. A passing source suite does not resolve a historical uncertain execution, certify every fleet platform, or establish the cause of a client reconnect banner. Startup version drift, historical job-reference reconciliation, richer console reports and optional stage/export work retain their separate tracker acceptance.
