# Reliability and usability improvement plan

Plan version: 2026-11-16. Status: implementation backlog; current states are recorded in the linked tracker.

The [implementation tracker](2026-11-16-improvement-tracker.md) is the single checklist for this plan. It contains 61 stable work-item IDs: the original 60 and the implementation follow-up RC26-INV-05. This document defines their purpose, dependencies, acceptance criteria and required evidence. The initial-state labels below preserve the planning baseline; they are not current completion claims. The tracker separates accepted source changes, qualified runtime behavior and unresolved operational work.

## Objective and scope

Make every operation explainable from request to verified result: which route accepted it, which execution identity ran it, whether it is still running, what evidence is retained, and which effect is actually verified. Prioritize supported recovery, correct desktop integration and complete measurement before optional new integrations.

The plan covers all eight finding areas F01–F08, all ten ecosystem comparisons E01–E10, the methodology limits, existing capabilities to preserve and follow-up verification. A comparison is a design input; it is not automatically a new dependency or implementation requirement. The full operational audit, raw measurements, device inventory, incident IDs, review receipts and deployment records stay in private project memory. The source tree contains reusable requirements and synthetic acceptance scenarios.

Implementation starts by refreshing evidence. A finding may already have changed since the audit. A current fix should be qualified and recorded, not duplicated. An experiment can conclude that the existing implementation should be retained.

### Problem map and desired outcome

| Finding | Engineering problem to address | Desired outcome |
|---|---|---|
| F01 | A synchronous repository operation can leave coordination uncertain without the durable-job evidence used by automatic reconciliation. | Supported reconciliation bound to the original operation and evidence, with no replay or eviction of a real writer. |
| F02 | A system agent and a desktop CLI installation do not establish an operational owner desktop route; archive runtime provenance can be missing. | Verifiable release identity and actual owner/managed-engine behavior through MCP, persistent after relaunch. |
| F03 | One controller's observation journal does not account for every request reaching agents. | Complete ingress accounting with attributed and explicitly unattributed traffic. |
| F04 | Read-only annotations and observer effect classification can disagree. | Failed observation and uncertain mutation have distinct, consistent semantics. |
| F05 | Selective recovery retention cannot support unbiased multi-week usage statistics. | Independent daily aggregates, explicit coverage and bounded reconciliation of old evidence. |
| F06 | Device roles, expected availability, installed versions, startup targets and actual runtimes can drift. | A private canonical inventory and a capability-aware version/startup matrix. |
| F07 | A broad tool catalog and fragmented diagnostic steps increase agent effort. | Clear route selection, bounded doctor diagnostics, compact results and resumable progress. |
| F08 | Repository review evidence and private task state can diverge. | Exact-head review dispositions, correctly scoped task closure and resumable handoffs. |

### Existing capabilities to preserve

- Owner-authorized host control and root/owner/interactive identities remain available. This plan does not introduce command allowlists, speculative enterprise permission gates or a replacement access model.
- Durable jobs, stable idempotency, synchronous exec receipts and retained-result recovery already exist. Extend or qualify them; do not build parallel engines.
- Preserve `requestSucceeded`, `executionOutcome`, `clientAcceptance` and `effectVerification` as separate facts. A successful status read can describe a failed job; a zero exit code does not independently verify the intended effect.
- Preserve observation/session-bound desktop references and their stale-reference protection.
- Extend the current MCP Apps console and modern/legacy transports. Do not create a second console or treat modern protocol support as missing.
- Preserve bounded fleet probes, per-item batch identities, explicit truncation and exact captured-result recovery.
- Preserve Android connection state separately from keyguard, consent and action capability. A locked device can remain connected.
- Preserve complementary Codex Connector and DSH reviews for application changes and the existing optional ContextKeep bridge.
- Keep raw commands, arguments, secrets, real UI data and private inventory out of usage telemetry and public repository artifacts.

## Delivery order

There is no calendar promise before baseline and dependency checks. The lots below order work by impact and prerequisites. Independent work can proceed in parallel, while dependent mutations and recovery decisions remain sequential.

| Lot | Scope | Work items | Exit gate |
|---|---|---:|---|
| 0 | Baseline, comparable measurements, finite benchmark and tracker discipline | 4 | Evidence is current; all planned work has a source and acceptance contract. |
| 1 | Synchronous recovery, release/desktop integration and effect classification | 14 | RC26-DEL-01: original failure scenario recovered without replay; actual managed desktop route persists after relaunch. |
| 2 | All-entry-point observation, historical aggregates and fleet/version inventory | 15 | RC26-DEL-02: same-window accounting, explicit coverage, bounded retention and visible startup drift. |
| 3 | Doctor, tool/result ergonomics, review reconciliation, protocol/client compatibility and documentation | 18 | RC26-DEL-03: measured real workflow benefit with preserved recovery and control. |
| 4 | Conditional Tasks, Android, Windows and browser comparisons; measured performance work | 9 | RC26-DEL-04: an evidence-backed adopt/defer/not-adopted decision for every option. |

P1 means high impact on truthful recovery, operation identity or the immediate integration gap. P2 means observability, correctness of history, maintainability or usability. P3 means an optional experiment or optimization requiring a measured benefit. Priorities express value; dependencies determine the executable order.

### Critical dependencies and parallel lanes

| Lane | Must happen first | Can progress independently |
|---|---|---|
| Synchronous recovery | Reproduce → evidence contract → implementation → fault/concurrency qualification → original incident | Release/desktop integration and effect classification can proceed in parallel after baseline. |
| Measurement | Effect model and ingress identity → all-entry-point counters → accounting and daily aggregates | Inventory cleanup and review-evidence inspection can start after baseline. |
| Usability | Stable observation/result semantics → doctor and progress → console and workflow comparison | Tool-selection guidance and compact-result measurements can start from the baseline scenarios. |
| Protocol | Actual client matrix → conformance/discovery/cancellation qualification → real-host canaries | Modern and legacy tests share the same behavior contracts. |
| Experiments | Supported client/device plus comparable measurement → finite pilot → decision | No conditional experiment blocks delivery of lots 1–3. |
| Performance | Profile representative workloads → demonstrate material hotspot → smallest justified optimization | No indexing or broad refactor is required merely because a linear scan exists. |

## Evidence and measurement contract

For each comparison, retain the exact source/release and environment, start/end instants, timezone, population, event identity, sample size, coverage and exclusions. Use an analysis cutoff that excludes the audit itself where applicable. Aggregate duplicate log delivery by stable event identity; do not confuse an RPC request-ID hash with a durable execution key.

The same-window accounting target is:

`agent ingress = attributed ingress + explicitly unattributed ingress`

If collection is incomplete or late events are outstanding, report the measured residual and the coverage limitation. A ratio from one controller is not a global fleet result. Compare agent dispatches as well as high-level calls, because a batch may dispatch several operations.

For latency, separate the observed duration of the command from transport, queue and serialization overhead. State how percentiles are calculated and which returned observations are included. Long-poll time is partly intentional waiting. Nonzero command exits and coordination conflicts require classification before being called product failures.

Historical recovery metadata is selected for recoverability, not statistical representativeness. Old uncertain entries and entries missing terminal job evidence can be retained preferentially. Do not calculate a multi-week error rate from that surviving set. A missing terminal receipt does not mean the job is still running. A current-window coverage flag can be accurate even when a legacy gap exists. Higher retention cannot reconstruct evicted records.

The audit did not establish a memory leak, general hardware bottleneck, duplicate-command storm or the identity of unattributed callers. A point-in-time RSS sample, last-hop loopback address and repeated RPC request ID do not establish those conclusions. Future measurements must preserve these limits.

## Risk and design decisions

| Decision or risk | Required treatment |
|---|---|
| Partial repository effects | Keep fetch/ref/index effects distinct from command success; reconcile the original execution rather than repeat it. |
| Old or mismatched evidence | Bind resource, generation, operation and execution identity; reject stale proof. Expiry does not authorize replay. |
| Caller disconnect | Separate waiting, foreground cancellation, durable execution and actual termination evidence. |
| State migration | Preserve original evidence and verified recovery material; use bounded dry runs and explicit dispositions. |
| Desktop version drift | Compare PATH, managed engine, adapter, startup target and running route. Test the actual MCP path. |
| Observer cost and cardinality | Bound counters, aggregation and tracing independently of recovery; profile before optimizing. |
| Platform or client unavailable | Record blocked/deferred native acceptance with a concrete reopening condition; do not substitute hosted tests for physical capability evidence. |
| External project change | Re-read the exact pinned source before implementation. Release notes suggest tests; they do not prove the same defect exists here. |
| Review/task drift | Verify current head and source before closing; keep incident and review tasks distinct. |
| Public/private boundary | Public engineering requirements and synthetic evidence stay in Git. Operational details and exact private correlations stay in private task memory. |

Implementation detail choices such as the synchronous reconciliation API shape, effect taxonomy migration, aggregate layout and trace exporter remain design work. The acceptance criteria below constrain their behavior without prematurely selecting a large new framework.

## Detailed work packages

### Baseline and measurement

#### RC26-BASE-01

**Refresh the baseline and bind the evidence**

Lot 0 · P1 · verify · Initial state: `planned`.

Dependencies: None. Sources: F01–F08; M01, M07, M08.

Before implementation, inspect current code, runtime, inventory and the relevant private task. Resolve the canonical checkout and exact candidate commit. Record which observations are live, historical agent reports, assumptions or recommendations. Preserve existing local edits and use isolated branches/worktrees.

**Acceptance:** A dated evidence index maps every finding to a source, component, current disposition and verification limit. Previously fixed behavior is verified instead of reimplemented. Unavailable hosts remain unverified.

**Evidence to retain:** Private audit/evidence index; sanitized source references; clean scoped diff.

#### RC26-BASE-02

**Define comparable usage and outcome measurements**

Lot 0 · P1 · design/verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F03, F05, F07; M02–M04.

Define fixed start/end instants, timezone, collection cutoff, denominator, event identity, coverage and deduplication. Measure nearest-rank percentiles on returned observations, with sample size. Separate request outcome, process outcome, client acceptance and independently verified effect.

**Acceptance:** Reports cannot label selectively retained history as a complete population. Command duration is distinguished from transport overhead; normal long-poll waits, nonzero exits and coordination protection are not automatically product failures. Windows with different cutoffs are not compared as identical.

**Evidence to retain:** Metric definitions; synthetic complete/partial-history examples; privately retained baseline.

#### RC26-BASE-03

**Create a small repeatable behavior and ergonomics benchmark**

Lot 0 · P2 · design/verify · Initial state: `planned`.

Dependencies: RC26-BASE-02. Sources: F07; E03, E08, E10; M06.

Select finite synthetic scenarios: a read-only inspection, short effect with a lost response, variable-duration job, repository recovery, desktop observation/action, intermittent device diagnosis and browser task. Fix input, environment and the expected visible result.

**Acceptance:** Each scenario records calls, returned bytes, elapsed time, result correctness and diagnostic usefulness. Actual client token usage is recorded only when exposed; schema characters or response bytes are not billed-token estimates. Baseline and candidate use equivalent conditions.

**Evidence to retain:** Versioned synthetic scenarios; raw measurements and environment metadata kept privately.

### Synchronous resource recovery

#### RC26-REC-01

**Reproduce partial synchronous repository failure**

Lot 1 · P1 · verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F01; E01.

Use a disposable repository to reproduce successful fetch followed by an index-lock failure, including a response lost after dispatch. Inspect process identity, repository refs/index, operation state and the coordination generation without rerunning the failed command.

**Acceptance:** The test exposes the synchronous path that can remain uncertain without a durable job ID. It distinguishes partial effects from no effect, and a protected live writer from a completed process. The fixture never changes an operator repository.

**Evidence to retain:** Synthetic reproduction; before/after repository state; operation and process receipts.

#### RC26-REC-02

**Specify evidence-bound synchronous reconciliation**

Lot 1 · P1 · design · Initial state: `planned`.

Dependencies: RC26-REC-01. Sources: F01.

Define a supported reconciliation contract binding device, identity, canonical resource, operation ID, generation, base version, process/execution identity and observed repository state. Specify terminal, partial-effect and still-unverified outcomes. Retain immutable historical evidence and no-replay identity.

**Acceptance:** Stale, wrong-operation, wrong-generation and wrong-resource evidence is rejected. Elapsed lease time or a missing process alone cannot prove the effect or whole process-tree termination. Active writers remain protected. The design does not add a force-unlock or metadata-deletion escape hatch.

**Evidence to retain:** State-transition table; evidence schema; compatibility and migration decision.

#### RC26-REC-03

**Implement supported reconciliation for synchronous operations**

Lot 1 · P1 · implement/verify · Initial state: `planned`.

Dependencies: RC26-REC-02. Sources: F01.

Implement the smallest protocol/agent/controller change needed to attach and inspect terminal synchronous evidence and reconcile a reservation. Reuse existing durable receipts where appropriate. Preserve inspect/acquire/release compatibility and clearly advertise new agent capabilities.

A null execution binding reports only that the returned record view has no binding available. It is not proof of absent artifact publication, absent admission or permission to replay. Report `not_started` only from invocation-bound pre-dispatch proof; a failed or unreadable publication view cannot supply that proof.

**Acceptance:** An eligible completed synchronous operation can be reconciled without replay. A partial repository effect remains described rather than overwritten as success. Unsupported agents fail clearly before an unsupported mutation. Retained state survives the documented restart boundary.

**Evidence to retain:** Scoped code diff; protocol/schema tests; synthetic MCP calls and recovery receipts.

#### RC26-REC-04

**Qualify recovery under concurrency and interrupted delivery**

Lot 1 · P1 · verify · Initial state: `planned`.

Dependencies: RC26-REC-03. Sources: F01; E01, E05; M06.

Exercise concurrent writers, reused tokens, stale generations, agent/controller restart, loss of response after effect, malformed or missing terminal evidence and incompatible agents. Cover the original partial-fetch/index-lock sequence and inspect the same operation after interruption.

The DSHv4 directory follow-ups remain deferred under REC-04/HIS-04/MCP-04. The current sharing-root comparison is lexical: a symlinked parent can redirect a shared-mode directory outside the physical root. Separately, external deletion of a pre-created receipt parent can make the generic atomic writer recreate it using the umask default. A future hardening change must qualify both boundaries with temporary fixtures, preserve existing ownership/group/setgid and private defaults, and keep incomplete publication evidence protected without replay. Existing normal-path permission tests do not close these follow-ups.

**Acceptance:** No duplicate execution occurs. A live writer is never evicted. Missing evidence remains explicit uncertainty. A valid reconciliation releases only the intended resource generation and preserves its audit history. Termination claims retain the existing containment limits.

**Evidence to retain:** Targeted fault/concurrency results; exact candidate commit; observed effect counts.

#### RC26-REC-05

**Resolve the existing incident through the qualified path**

Lot 1 · P1 · operational verification · Initial state: `planned`.

Dependencies: RC26-REC-04. Sources: F01; M08–M10.

After the candidate passes source/behavior checks and required application review/CI, promote the needed recovery component through the existing rollout process and verify its actual runtime identity. Then resume the existing private incident task, re-inspect the original resource and execution, preserve current repository edits/recovery material, and apply only the evidence-supported reconciliation. Reconcile the intended repository state separately from the coordination receipt.

**Acceptance:** The incident receives an explicit evidence-backed disposition. The repository is usable without losing unrelated work; no command was replayed to guess its previous result. If required evidence is unavailable, the limitation and next supported recovery step remain recorded.

**Evidence to retain:** Private original task, exact operation/generation, repository diff and recovery receipt.

### Release and managed desktop integration

#### RC26-DEP-01

**Report verifiable archive release identity**

Lot 1 · P1 · implement/verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F02, F06.

Reuse the existing release attestation mechanism to supply a manifest for archive installations. Bind full source identity, tracked artifact hashes, generated assets where applicable, component and version to authenticated runtime diagnostics. Compare the manifest with actual executable/process paths; do not infer integrity from a directory name.

**Acceptance:** A verified archive installation reports its real release without requiring .git. Missing or mismatched evidence is explicit. A claimed environment SHA alone cannot certify running bytes. Existing configured identities and state directories stay stable.

**Evidence to retain:** Synthetic archive/manifest tests; attestation receipt; private running-process verification.

#### RC26-DEP-02

**Complete the owner route and graphical-session integration**

Lot 1 · P1 · integration/verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F02; E02.

Qualify an owner endpoint on the primary Linux host with separate existing-style state/configuration and the intended user session. Verify DBus, accessibility, display/window-manager and endpoint routing prerequisites. Preserve root administration and explicit owner/root/interactive selection.

**Acceptance:** System administration remains available. Owner diagnostics distinguish a missing endpoint, missing graphical session, permission/accessibility failure and unsupported platform. A shell login is not treated as proof of desktop access.

**Evidence to retain:** Private endpoint/session configuration; authenticated capability probes; synthetic missing-session checks.

#### RC26-DEP-03

**Bind the adapter to the managed desktop engine**

Lot 1 · P1 · integration/verify · Initial state: `planned`.

Dependencies: RC26-DEP-02. Sources: F02, F06; E02.

Configure the managed engine manifest used by the MCP adapter. Report effective binary, engine version, JSON contract, adapter identity, execution context and manifest provenance. Compare the PATH binary, installed engine and active managed engine explicitly.

**Acceptance:** The same MCP route reports the binary and version it actually uses. A CLI version check alone cannot close the item. Compatibility is checked before an engine change; valid independently versioned components are not forcibly synchronized.

**Evidence to retain:** Sanitized contract tests; private manifest and actual MCP status response.

#### RC26-DEP-04

**Verify desktop behavior through the actual MCP route**

Lot 1 · P1 · verify · Initial state: `planned`.

Dependencies: RC26-DEP-01, RC26-DEP-03. Sources: F02; E02; M06.

Observe a synthetic application, perform one reversible action and observe its result through the same owner MCP route. Cover session changes, stale observation references, trace continuity and wait transitions relevant to the chosen engine release.

**Acceptance:** Observation succeeds and the intended effect is independently visible. Stale/session-mismatched references are rejected. A missing graphical session reports the correct prerequisite instead of a generic transport failure.

**Evidence to retain:** Before/action/after traces; controlled screenshots where needed; exact running versions.

#### RC26-DEP-05

**Verify startup persistence and a reversible rollout**

Lot 1 · P1 · operational verification · Initial state: `planned`.

Dependencies: RC26-DEP-04. Sources: F02, F06; M08, M09.

Inspect service, login/startup and updater targets. Preserve a verified previous release and configuration. After the candidate passes relevant checks and required application review/CI, promote it through the existing rollout process, verify runtime identity and perform an authorized controlled relaunch. Compare desired, installed, startup target and running identity, including the managed desktop engine. Repeat on each relevant platform when available.

**Acceptance:** Relaunch does not restore an old owner agent or engine. The same MCP route remains usable. Rollback has an inspected target and documented verification; unavailable native platforms remain unqualified, not passed.

**Evidence to retain:** Private before/after startup and runtime receipts; rollback reference; native MCP probes.

### Effect classification

#### RC26-EFF-01

**Centralize tool effect classification**

Lot 1 · P1 · implement/verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F04.

Define one typed effect model shared by tool annotations, observation and recovery. Audit read-only tools, including desktop observation, and classify mixed tools by their requested operation rather than a single coarse tool name.

**Acceptance:** Schema hints and observer classification cannot diverge silently. Read-only, mutating and mixed operations have explicit test cases. Existing typed tools remain available.

**Evidence to retain:** Effect-model diff; catalog consistency check; mixed-operation examples.

#### RC26-EFF-02

**Separate failed observation from uncertain effect**

Lot 1 · P1 · implement/verify · Initial state: `planned`.

Dependencies: RC26-EFF-01. Sources: F04; F03, F05.

Represent a failed read such as a missing window as an observation failure while retaining the actual request error. Keep mutation-after-dispatch uncertainty separate. Align result schemas, diagnostics and retention decisions with the shared model.

**Acceptance:** A failed desktop observation does not imply an uncertain external effect. A possibly dispatched action remains uncertain until its evidence supports a stronger conclusion. Actual SDK output validates against the advertised schema.

**Evidence to retain:** Regression for missing-window/unsupported-platform reads and interrupted effectful actions.

#### RC26-EFF-03

**Reconcile historical classification without fabricating proof**

Lot 1 · P2 · design/verify · Initial state: `planned`.

Dependencies: RC26-EFF-02. Sources: F04, F05.

Evaluate whether retained records can be safely reclassified using their original operation kind and evidence. Version any migration and preserve originals/recovery copies. If evidence is insufficient, retain uncertainty and annotate the limitation rather than retroactively declaring success.

**Acceptance:** Only provably read-only failures change category. Mutation evidence and durable tombstones are preserved. Retention pressure improves only where the new classification is justified, with before/after counts.

**Evidence to retain:** Synthetic migration tests; private dry-run/reconciliation receipt; count comparison.

### End-to-end observation

#### RC26-OBS-01

**Inventory every agent entry point**

Lot 2 · P1 · verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F03; E07; M04.

Identify configured controllers, direct clients, automation and transport/proxy paths that can reach agents. Record what can and cannot be authenticated at each hop. Treat loopback as the observed final hop, not the original caller identity.

**Acceptance:** Every known route has an instrumentation location. Unidentified traffic is explicitly unassigned; no client, retry loop or malicious source is inferred without evidence.

**Evidence to retain:** Private entry-point map; sanitized interface design; attribution gaps.

#### RC26-OBS-02

**Propagate trace and origin without changing effect identity**

Lot 2 · P1 · implement/verify · Initial state: `planned`.

Dependencies: RC26-OBS-01. Sources: F03; E07.

Propagate versioned correlation through client, controller and agent, including direct entry points. Distinguish authenticated origin from caller-declared labels and attach confidence/provenance. Keep JSON-RPC request IDs, diagnostic scopes, trace IDs and durable effect keys as separate concepts.

**Acceptance:** A new transport request can refer to the same durable operation. Existing requestHash is documented as a hash of the JSON-RPC ID, not a command fingerprint or deduplication key. Untrusted labels cannot override verified peer identity.

**Evidence to retain:** Schema/propagation tests; direct and proxied synthetic trace examples.

#### RC26-OBS-03

**Count all ingress independently of sampled traces**

Lot 2 · P1 · implement/verify · Initial state: `planned`.

Dependencies: RC26-OBS-02, RC26-EFF-02. Sources: F03; E07.

Add bounded agent-side counters by route, entry point, selected identity, duration and outcome. Keep total counts independent of trace sampling. Deduplicate log delivery using stable boot/process/request or event identities and record collection interruptions.

**Acceptance:** Direct traffic and controller traffic are represented. Sampling or duplicate log delivery does not silently change request totals. No command text, arguments, environment values, secret or raw output is needed for usage telemetry.

**Evidence to retain:** Counter tests with direct/proxy traffic, duplicate events, restart and partial collection.

#### RC26-OBS-04

**Reconcile agent totals with attributed and unattributed traffic**

Lot 2 · P1 · verify · Initial state: `planned`.

Dependencies: RC26-OBS-03. Sources: F03, F05; M02, M04.

Produce a same-window reconciliation that compares agent ingress with controller dispatch and direct-client attribution. Count dispatches as well as high-level calls so batches are not mistaken for missing traffic. Track unmatched events and late delivery explicitly.

**Acceptance:** Agent total equals attributed plus explicitly unattributed traffic for the defined complete window, or a measured collection residual is reported. A controller success fraction is never presented as a fleet-wide workload success rate.

**Evidence to retain:** Synthetic reconciliation cases and private fixed-window repeat of the audit comparison.

#### RC26-OBS-05

**Measure latency stages and map optional OTel conventions**

Lot 2 · P2 · design/verify · Initial state: `planned`.

Dependencies: RC26-OBS-03. Sources: F03; E07.

Measure queue, dispatch, execution, serialization and response stages where observable. Keep a stable internal schema and document the exact OpenTelemetry MCP convention revision, currently a development convention. Add export only if it serves a concrete diagnostic need.

**Acceptance:** Stage durations and missing spans are explicit. Trace export is optional and failure does not block execution. No claim of overhead reduction is made from total command duration alone.

**Evidence to retain:** Stage timing tests; schema mapping; optional export pilot decision.

#### RC26-OBS-06

**Correlate diagnostics with existing ContextKeep tasks and runs**

Lot 2 · P2 · verify/extend · Initial state: `planned`.

Dependencies: RC26-OBS-02. Sources: F03, F08; E07.

Reuse the existing optional result bridge and correlation fields. Attach exact project/task/run/execution identity when supplied, without making ContextKeep availability an execution prerequisite or treating an association as authorization.

**Acceptance:** Diagnostic correlation cannot attach one execution to unrelated work. Delivery, terminal observation and independent effect verification remain separate. Existing uncertainty and retry/backoff semantics remain intact.

**Evidence to retain:** Synthetic correct/wrong-correlation cases; private task-linked canary.

### History and retention

#### RC26-HIS-01

**Persist 60–90 days of daily aggregates independently of recovery**

Lot 2 · P2 · implement/verify · Initial state: `planned`.

Dependencies: RC26-BASE-02, RC26-EFF-02, RC26-OBS-03. Sources: F05; E07.

Design bounded daily aggregates with configurable retention in the 60–90 day target range. Preserve request, execution and verification dimensions, source coverage and unattributed counts. Specify late events, day rollover, timezone display and restart behavior.

**Acceptance:** Recovery-journal expiry/eviction cannot alter already accumulated historical totals. Reprocessing events does not double count. Gaps and unsupported dimensions are represented rather than reconstructed as facts.

**Evidence to retain:** Synthetic rollover/restart/deduplication tests; aggregate schema and capacity estimate.

#### RC26-HIS-02

**Publish coverage-aware reports and denominators**

Lot 2 · P2 · implement/verify · Initial state: `planned`.

Dependencies: RC26-HIS-01, RC26-OBS-04. Sources: F05; M02, M03.

Expose start/end instants, timezone, collection start, sample count, denominator, retention bounds and coverage in usage reports and the console. Separate current-window coverage from legacy gaps. Explain long-poll waits and command-inclusive execution latency.

**Acceptance:** A short retained window is not labeled as a multi-week SLA. requestSucceeded is not task success. A legacy gap does not automatically make a current window incomplete, and missing historical data cannot be recovered by increasing retention.

**Evidence to retain:** Synthetic complete/current-gap/legacy-gap report fixtures and private recent-window comparison.

#### RC26-HIS-03

**Reconcile old job references with bounded read-only inspections**

Lot 2 · P2 · verify/extend · Initial state: `planned`.

Dependencies: RC26-EFF-03. Sources: F05; M06.

Inspect original agent/job identities in bounded pages to obtain available terminal evidence. Reuse existing status/output recovery; checkpoint progress and back off unavailable agents. Preserve missing, running, lost and unknown states distinctly.

**Acceptance:** Old references without terminalJobs are not counted as running jobs. No job is restarted and no idempotency reservation is deleted. Only authoritative, matching evidence advances finalization; unavailable evidence stays visible.

**Evidence to retain:** Synthetic old/missing/lost/terminal cases; private reconciliation inventory and receipts.

#### RC26-HIS-04

**Bound aggregate and recovery pressure independently**

Lot 2 · P2 · verify · Initial state: `planned`.

Dependencies: RC26-HIS-01, RC26-HIS-03. Sources: F05; M05.

Define storage/cardinality budgets for aggregates separately from recovery metadata. Exercise capacity, publication failure, corrupt entries and restart. Preserve recovery control capacity and unresolved evidence under pressure.

**Acceptance:** Limits and saturation are explicit; recovery evidence is not sacrificed to improve a dashboard. The configured limit and code default are reported separately. Performance measurements identify the cost of collection and reconciliation.

**Evidence to retain:** Capacity/failure fixtures; boundedness measurements; documented operating limits.

### Fleet and version inventory

#### RC26-INV-01

**Reconcile the canonical fleet inventory**

Lot 2 · P2 · operational verification · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F06; M07.

Maintain one private inventory with canonical name/aliases, role, expected availability, execution identities and capabilities. Reconcile primary/backup/retired roles with current owner intent. Review always-on assumptions rather than inferring power state from a probe.

**Acceptance:** A retired or intermittent host does not appear as an unexpectedly failed continuous service. Alias resolution preserves durable identities. Reachability, runtime readiness, capability and unknown physical power state remain distinct.

**Evidence to retain:** Private inventory diff and owner-intent reference; synthetic alias/availability tests.

#### RC26-INV-02

**Expose desired, installed, startup and running versions**

Lot 2 · P2 · implement/verify · Initial state: `planned`.

Dependencies: RC26-DEP-01, RC26-INV-01. Sources: F02, F06.

Record separate desired, installed, startupTarget and running identities for each component/endpoint, including desktop engine and protocol compatibility. Detect startup drift and missing manifest evidence without requiring all components to share a SHA.

**Acceptance:** A component can be intentionally versioned independently when its capability contract is compatible. A stale startup target is visible even when the current process is correct. Missing evidence is not replaced by a directory-name guess.

**Evidence to retain:** Version-matrix fixtures; private fleet readback; compatibility rationale.

#### RC26-INV-03

**Use bounded probes and backoff for intermittent devices**

Lot 2 · P2 · verify/optimize · Initial state: `planned`.

Dependencies: RC26-INV-01. Sources: F06, F07; E04.

Reuse existing finite fleet budgets and add or tune backoff only where measurements show repeated unnecessary probes. Keep selected identity configuration, transport reachability and metrics availability independent; preserve cancellation of queued probes.

**Acceptance:** One unresponsive host cannot consume the full diagnostic workflow indefinitely. An agent with unavailable metrics remains reachable. Explicit user actions can request fresh diagnostics, and an expected intermittent absence is not reported as a confirmed failure.

**Evidence to retain:** Synthetic unavailable/slow/partial-metrics cases; before/after probe counts.

#### RC26-INV-04

**Separate canonical source workspaces from immutable releases**

Lot 2 · P2 · documentation/verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F06; M08.

Document how the operator identifies the canonical source checkout and immutable release location. Inventory older workspaces and their local edits privately. Use isolated worktrees for changes and explicit release attestations for runtime.

**Acceptance:** No stale checkout is reset or overwritten to make it look current. Repository HEAD does not certify deployment. Follow-up agents can locate the intended source and runtime using private records without relying on an old path.

**Evidence to retain:** Generic workflow documentation; private workspace/release mapping and preserved-diff reference.

#### RC26-INV-05

**Isolate automated review probes from installed services**

Lot 3 · P1 · review execution isolation · Added during implementation: `planned`.

Dependencies: RC26-INV-04, RC26-GOV-02. Sources: implementation review follow-up; M06, M08, M10.

Run automated source probes in a suitable isolated test account or disposable runtime with synthetic credentials and fixture state. Keep the review worker separate from installed service credentials, state roots and process-control authority. Preserve normal owner-authorized Remote Control identities and workflows; this item does not add command allowlists, owner confirmation gates or a replacement application access model.

**Acceptance:** A synthetic review worker can build and test its own checkout and clean up its identity-bound fixtures. It cannot signal an unrelated installed process, control an installed service or alter installed state. Verify the boundary rather than inferring it from a temporary directory or a documented rule. Unsupported native/platform scenarios remain explicitly unverified. Keep the existing review publication and operator workflows usable.

**Evidence to retain:** Synthetic positive fixture tests and denied cross-boundary operations; verified review-worker configuration and cleanup evidence. Keep real host, process and incident records private. Procedural guidance alone does not close this item.

### Agent and console usability

#### RC26-UX-01

**Provide a bounded read-only doctor workflow**

Lot 3 · P2 · implement/verify · Initial state: `planned`.

Dependencies: RC26-BASE-03, RC26-INV-02, RC26-EFF-02. Sources: F07; E03, E04.

Compose existing probes for controller, transport, system agent, owner agent, graphical session, managed engine, capture and input capability. Return timestamp, source, elapsed duration, status and concrete cause for each stage. Parallelize independent reads within one total budget; do not remediate automatically.

**Acceptance:** One invocation localizes system-ready/owner-unconfigured, unreachable transport, unavailable desktop and unsupported capability. A functioning owner desktop is not a prerequisite for building or validating the diagnostic. Input capability is inspected without generating input. Full screenshots or UI trees are not prerequisites for basic diagnosis.

**Evidence to retain:** Typed result contract; synthetic healthy/missing-owner/missing-session/unreachable cases; native canary.

#### RC26-UX-02

**Guide tool and identity selection by intent**

Lot 3 · P2 · documentation/verify · Initial state: `planned`.

Dependencies: RC26-BASE-03. Sources: F07.

Provide concise workflow guidance for reading files, inspecting state, short effects, long work, desktop actions and recovery. Recommend root/owner/interactive explicitly where relevant and reuse typed tool schemas. Validate actual client discovery behavior before changing catalog exposure.

**Acceptance:** Common scenarios choose a suitable route without a trial-and-error sequence. All existing owner capabilities remain accessible. No opaque action:string replacement or unmeasured claim about token savings is introduced.

**Evidence to retain:** Intent-to-tool examples; measured before/after scenario results.

#### RC26-UX-03

**Keep default results compact with exact recovery**

Lot 3 · P2 · verify/optimize · Initial state: `planned`.

Dependencies: RC26-BASE-03. Sources: F07.

Review common result shapes using measured response sizes. Retain summaries, explicit truncation, recovery pointers and byte/cursor semantics; load verbose output and images on request. Reuse existing compaction rather than creating another recovery store.

**Acceptance:** Smaller routine responses preserve every fact needed to select the next action. Paging recovers original captured data without replay; it does not claim bytes discarded by the agent are recoverable. Final actual MCP results match their schemas.

**Evidence to retain:** Before/after response sizes; paging/recovery and SDK-schema regressions.

#### RC26-UX-04

**Batch independent reads using existing facilities**

Lot 3 · P2 · documentation/verify · Initial state: `planned`.

Dependencies: RC26-BASE-03. Sources: F07.

Document and validate bounded parallel batches for independent read operations. Respect per-item device and identity, output budgets and cancellation. Keep dependent operations, writes and recovery decisions sequential.

**Acceptance:** A representative read workflow uses fewer round trips or lower wall time without losing per-item error/evidence. No read optimization silently changes execution identity or turns a retry into a repeated effect.

**Evidence to retain:** Equivalent sequential/batch measurements; per-item identity and partial-result checks.

#### RC26-UX-05

**Select durable jobs and receipts according to the operation**

Lot 3 · P2 · documentation/verify · Initial state: `planned`.

Dependencies: RC26-REC-04, RC26-BASE-03. Sources: F01, F07; E01.

Use existing durable jobs for variable/long work and exec_prepare receipts for short effects whose response must be recoverable. Evaluate actual effectful use before setting guidance. Keep ordinary reads lightweight. Distinguish controller-memory result recovery from agent-disk receipts and durable jobs.

**Acceptance:** A lost response is recovered with its original identity, never by repeating the effect. A foreground receipt does not make execution restartable. Receipt adoption is measured on eligible operations; a low raw count alone is not called a defect.

**Evidence to retain:** Decision table; short-effect and long-job interruption probes; measured workflow comparison.

#### RC26-UX-06

**Expose actionable job progress without invented certainty**

Lot 3 · P2 · implement/verify · Initial state: `planned`.

Dependencies: RC26-OBS-03, RC26-UX-05. Sources: F07; E01, E03.

Represent running, possible/confirmed waiting for input, terminal, connection lost, result unconfirmed and recovery availability. Include last observed output/update and recommended next check using existing wait cursors/backoff. Attach provenance to input-wait hints; silence alone is not proof of a hang.

**Acceptance:** A timeout of the caller wait does not mean process termination. Repeated polling follows the advertised interval. Heartbeats and elapsed time do not invent completion percentages. Explicit cancellation remains distinct from verified termination.

**Evidence to retain:** Synthetic silent/interactive/delayed-output jobs; disconnect and wait-expiry probes.

#### RC26-UX-07

**Extend the existing MCP Apps console with the same contracts**

Lot 3 · P2 · implement/verify · Initial state: `planned`.

Dependencies: RC26-UX-01, RC26-UX-06, RC26-HIS-02. Sources: F03–F07; E09.

Render request, execution and effect verification separately. Show diagnostic causes, selected route, freshness, last output, next check, recovery/expiry and report coverage. Consume shared doctor/progress logic and preserve a usable tool/text path for hosts without Apps.

**Acceptance:** Refresh and reopen perform reads only. Cached state is recognizable; disconnect does not imply success or failure. Representative recovery, missing-owner and failed-observation cases render correctly in the actual supported host. Placement remains host-controlled.

**Evidence to retain:** Synthetic app-bridge tests; real-host screenshots/receipts; text fallback verification.

### Reviews, task evidence and handoffs

#### RC26-GOV-01

**Reconcile review evidence against the exact repository head**

Lot 3 · P2 · verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F08.

Read the current PR/head and reviewer results before changing task state. Reconcile historical open review tasks with later reported outcomes, including any release evidence used as a baseline. Preserve the separate recovery incident task.

**Acceptance:** Each finding has an exact-head disposition and source. A green CI run or merged PR alone does not close review work. Missing live evidence is stated; completed reviews are reused when still applicable.

**Evidence to retain:** Private review URLs/SHAs/dispositions; readback of the correct task.

#### RC26-GOV-02

**Preserve complementary Codex and DSH review workflow**

Lot 3 · P2 · process/verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: F08.

For application changes, the development agent requests or reuses Codex Connector and DSH reviews after a stable validated candidate. Follow the repository review-cycle helper, required CI and exact-version dispositions. The operator is not required to coordinate reviewer mentions.

**Acceptance:** Both required review paths remain represented where applicable; neither is silently replaced. Retry requests are reused and closure is read back. Documentation-only work follows the applicable repository rules without inventing an application deployment gate.

**Evidence to retain:** Version-bound review records and required CI for each application PR.

#### RC26-GOV-03

**Keep tracker state and private handoffs synchronized**

Lot 0 · P1 · process · Initial state: `planned`.

Dependencies: None. Sources: F01–F08; M01, M10.

Use the stable IDs in this tracker throughout implementation. At each boundary record scope, status, dependencies, commit/PR, tests, runtime evidence or limitations, and next action. Keep public engineering status generic; retain host details, raw measurements, recovery identifiers and deployment receipts privately.

**Acceptance:** No row is closed from a narrative summary alone. Agent reports retain their provenance. A later session can resume the correct task and original execution without guessing or replay. Deferred items have a reason and reopening condition.

**Evidence to retain:** Updated tracker; private task checkpoint and readback.

### Protocol and client compatibility

#### RC26-MCP-01

**Build the actual client and protocol compatibility matrix**

Lot 3 · P2 · verify · Initial state: `planned`.

Dependencies: RC26-BASE-01. Sources: E05; F07.

Inventory supported clients, exposed versions/capabilities and the protocol actually observed. Cover modern 2026-07-28 and initialization-based legacy paths for discovery, tool catalog, call/result, progress, cancellation and recovery. Do not infer support from a product name or documentation alone.

**Acceptance:** Each claimed client/protocol combination has evidence or an explicit unverified status. Modern and legacy support already present in the product is preserved.

**Evidence to retain:** Synthetic version matrix; private real-client observations.

#### RC26-MCP-02

**Run relevant official protocol conformance cases**

Lot 3 · P2 · verify · Initial state: `planned`.

Dependencies: RC26-MCP-01. Sources: E05.

Pin the official conformance suite/revision and select cases relevant to the supported protocol and transport. Add regressions for any reproduced gap while retaining authentication/origin checks and malformed-envelope classification.

**Acceptance:** Advertised protocol behavior passes the relevant suite. A protocol pass is not substituted for an effect/recovery test. Failures are triaged by actual implementation gap rather than weakening assertions.

**Evidence to retain:** Conformance version/results; focused regression tests and exact candidate commit.

#### RC26-MCP-03

**Verify modern discovery and catalog/result parity**

Lot 3 · P2 · verify · Initial state: `planned`.

Dependencies: RC26-MCP-01. Sources: E05; F07.

Verify server/discover, modern result shapes and per-request capabilities, alongside legacy initialization. Check deterministic catalog ordering/cache metadata where supported, invalidation after changes, output schemas and parity of handlers/recovery metadata across paths.

**Acceptance:** A client sees a coherent typed catalog and valid results after reconnect or refresh. A malformed modern envelope cannot silently downgrade to legacy. No unsupported progressive-discovery feature is presumed universal.

**Evidence to retain:** Actual SDK transport tests; catalog/result comparisons; cache-invalidation cases.

#### RC26-MCP-04

**Verify cancellation, reconnection and durable effect continuity**

Lot 3 · P1 · verify · Initial state: `planned`.

Dependencies: RC26-MCP-01, RC26-REC-04. Sources: E05; F01, F07.

Test stream closure, request cancellation, lost response after dispatch, changed JSON-RPC IDs and retrieval from original durable identities on each transport. Separate cancelling a wait from job_cancel, and document modern versus legacy stream behavior.

**Acceptance:** A reconnect never starts another effect solely because the response was lost. A cancelled wait leaves the durable job running unless an explicit job cancellation was requested. Cancellation intent, observed termination and verified effect remain separate.

**Evidence to retain:** Fault-injected transport scenarios; process/effect counts; original-handle recovery traces.

#### RC26-MCP-05

**Qualify the supported real hosts and document the limits**

Lot 3 · P2 · operational verification · Initial state: `planned`.

Dependencies: RC26-MCP-02, RC26-MCP-03, RC26-MCP-04. Sources: E05, E09; M07, M09.

Run read-only discovery and synthetic effect/recovery canaries through each actual supported connector/host. Record version exposure limits, capability negotiation, native Apps behavior and any unsupported combination. Use host-neutral wording in public docs.

**Acceptance:** Synthetic SDK success and real-host acceptance are reported separately. Unavailable clients or devices remain unverified. The compatibility matrix contains no inferred support.

**Evidence to retain:** Private client canaries; sanitized supported/unsupported matrix.

### Wait budgets and UI responsiveness

#### RC26-TMO-01

**Align wait budgets across client, controller, agent and process**

Lot 3 · P2 · verify/optimize · Initial state: `planned`.

Dependencies: RC26-BASE-03, RC26-REC-04. Sources: E01; F01, F07.

Inventory actual wait/transport/execution deadlines and budget margins. Reuse current bounded job_wait behavior. Test delayed output, response loss and child-process behavior; change a budget only for a measured mismatch. Treat other products' security release notes as comparator context, not an RC vulnerability finding.

**Acceptance:** No layer labels its own wait expiry as proof the process ended. Long work can be resumed by its original job handle. A timed-out foreground effect retains truthful termination limits and recovery guidance.

**Evidence to retain:** Budget table; boundary tests; measured rationale for any change.

#### RC26-TMO-02

**Qualify heartbeat and bounded UI collection**

Lot 3 · P2 · verify/conditional remediation · Initial state: `planned`.

Dependencies: RC26-DEP-04, RC26-UX-01. Sources: E03; F07.

Use a synthetic unresponsive application to check whether UI collection blocks heartbeat or status. Bound per-application/UIA work and expose partial coverage if a gap is reproduced. Keep slow UI diagnosis separate from device transport availability.

**Acceptance:** The status path remains responsive during slow UI collection. Excluded or timed-out applications are identified as partial observations. No real user application is deliberately hung for the test.

**Evidence to retain:** Native synthetic slow-application scenario; latency/coverage traces; gap-specific change if needed.

### Conditional ecosystem experiments

#### RC26-EXP-01

**Probe real client support for the Tasks extension**

Lot 4 · P3 · experiment prerequisite · Initial state: `planned`.

Dependencies: RC26-MCP-01. Sources: E06.

Inspect extension negotiation in at least one intended real client and document supported operations, polling, result lifetime and cancellation behavior. Use an isolated minimal Tasks server/fixture to test the client before building the RC adapter. Define a lossless mapping from current job states.

**Acceptance:** Support is demonstrated by a capability exchange and usable handle against the isolated fixture, or the pilot is explicitly deferred. This gate does not depend on the RC adapter. Marketing/product identity and the core protocol version alone are not evidence of Tasks support.

**Evidence to retain:** Private negotiation receipt; generic state mapping and go/no-go decision.

#### RC26-EXP-02

**Pilot Tasks as an adapter over existing durable jobs**

Lot 4 · P3 · experiment · Initial state: `conditional`.

Dependencies: RC26-EXP-01, RC26-BASE-03. Sources: E06.

Only with proven client support, persist a task handle before responding and map it to the canonical existing job. Support status/terminal result, advertised polling interval, expiry and cooperative cancellation as negotiated. Decide whether the pilot emits input_required: if yes, implement tasks/update and same-job resumption; otherwise document the supported subset without claiming intermediate interaction. Reuse enhanced correlation/history if available; global analytics are not a prerequisite for this finite pilot.

**Acceptance:** Reconnect retrieves the same job. A negative capability test proves clients without the extension retain the existing flow and never receive resultType: task. Expiry or missing results cannot cause replay. Completion is not effect verification; cancellation does not overstate termination. If input is supported, it resumes the same job without a new execution. Adopt only for measured workflow benefit.

**Evidence to retain:** Pilot protocol/effect tests; real-client results; adopt/defer/not-adopted decision.

#### RC26-EXP-03

**Compare Android observation geometry on a finite test matrix**

Lot 4 · P3 · experiment · Initial state: `conditional`.

Dependencies: RC26-BASE-03. Sources: E08; F04, F07.

When a test device is available, compare the existing Companion with the relevant Mobile MCP behavior for portrait, landscape, resized captures, stale orientation and keyguard. Record source/delivered dimensions, display, timestamp and coordinate transform; use reversible targets in a synthetic app.

**Acceptance:** The applied coordinate hits the intended observed target. Rotation invalidates or explicitly transforms old references. Keyguard limits actions without falsely marking the connection down. Retain Companion unless a measured change justifies maintenance cost.

**Evidence to retain:** Private controlled captures and coordinate results; comparable scenario table; adoption decision.

#### RC26-EXP-04

**Compare Windows desktop diagnostics on the same machine**

Lot 4 · P3 · experiment · Initial state: `conditional`.

Dependencies: RC26-BASE-03, RC26-TMO-02. Sources: E03; F06, F07.

On an available native Windows test host, compare the current adapter and selected Windows-MCP behavior for normal observation/action and a synthetic unresponsive application. Fix versions, session and scenario; measure latency, completeness, output and diagnosis.

**Acceptance:** Both paths target the same result and report partial/unavailable conditions truthfully. Published speedups from another project are not RC estimates. An additional backend requires a measured advantage and maintenance rationale.

**Evidence to retain:** Native comparison; environment/version record; adopt/defer/not-adopted decision.

#### RC26-EXP-05

**Compare Playwright CLI plus skills with the existing browser route**

Lot 4 · P3 · experiment · Initial state: `conditional`.

Dependencies: RC26-BASE-03. Sources: E10; F07.

Choose one finite application-testing flow with a synthetic dataset, fixed browser and expected outcome. Compare current MCP/browser operation with CLI plus skills. Record session/process ownership and keep browser traces/screenshots retrievable instead of sending all artifacts into context.

**Acceptance:** Both routes achieve the same verified result. Adoption reduces a measured cost without losing diagnosis or recovery. A controlled interruption leaves an identifiable session and useful evidence. Use it as a complement where justified.

**Evidence to retain:** Matched scenario results, call/byte/time counts, retained artifacts and adoption decision.

### Measured performance work

#### RC26-PERF-01

**Profile observer and reconciliation cost before optimization**

Lot 4 · P3 · experiment prerequisite · Initial state: `planned`.

Dependencies: RC26-OBS-05, RC26-HIS-04. Sources: F05, F07; M05.

Measure linear scans, coverage queries, event handling, job-reference reconciliation, serialization, event-loop delay and memory over representative journal sizes. Separate workload execution time from observer overhead and test retention/capacity boundaries.

**Acceptance:** A hotspot is demonstrated with a reproducible profile or the current implementation is retained. A single RSS sample is not evidence of a leak or a hardware bottleneck.

**Evidence to retain:** Profile configuration, repeated measurements, workload size and hotspot/no-hotspot decision.

#### RC26-PERF-02

**Optimize only the measured limiting path**

Lot 4 · P3 · conditional optimization · Initial state: `conditional`.

Dependencies: RC26-PERF-01. Sources: F05, F07; M05.

If profiling finds material cost, evaluate the simplest bounded index/cache or incremental reconciliation. Keep persisted receipts authoritative, make derived state rebuildable, and preserve paging/order, coverage and recovery semantics.

**Acceptance:** The same workload shows a material improvement against an agreed baseline while correctness and boundedness remain intact. If no material hotspot exists, close with an explicit not-adopted decision rather than an unnecessary refactor.

**Evidence to retain:** Before/after profile; correctness regressions; restart/index-rebuild evidence.

#### RC26-PERF-03

**Set measured regression budgets**

Lot 4 · P3 · design/verify · Initial state: `planned`.

Dependencies: RC26-PERF-01, RC26-BASE-03. Sources: F07; M05, M09.

Choose a small set of repeatable performance checks for the paths actually changed. Set thresholds from observed variance and relevant resource limits; distinguish deterministic functional gates from environment-sensitive performance signals.

**Acceptance:** Budgets are justified by baseline measurements, not invented latency or token targets. Native-only checks are not reported as passed on hosted substitutes. Add tests only for a concrete risk or required gate.

**Evidence to retain:** Budget rationale; reproducible benchmark recipe; scoped CI or private native results.

### Documentation consistency

#### RC26-DOC-01

**Reconcile version claims and operational documentation**

Lot 3 · P2 · documentation/verify · Initial state: `planned`.

Dependencies: RC26-BASE-01, RC26-MCP-01, RC26-INV-02. Sources: F06, F08; planning follow-up.

Compare README, compatibility guidance, package manifests, generated assets and release instructions. Resolve stale SDK/version statements against the inspected source and actual protocol path. Keep source capabilities, installation instructions and live deployment evidence separate.

**Acceptance:** Documentation names only verified supported versions/contracts, links to the current matrix and explains archive identity, managed desktop selection and recovery limits. Updating a version string is not represented as upgrading a runtime.

**Evidence to retain:** Scoped documentation diff; source/package cross-check; link validation.

### Delivery and decision gates

#### RC26-DEL-01

**Close the recovery and desktop lot with behavior evidence**

Lot 1 · P1 · delivery gate · Initial state: `planned`.

Dependencies: RC26-REC-05, RC26-DEP-05, RC26-EFF-03. Sources: F01, F02, F04; M09, M10.

This is the final readback and closure gate after the component promotions and live acceptance in REC-05 and DEP-05; it is not the first promotion step. Verify the exact source/generated artifacts, required review/CI, preserved state/recovery copies and the already collected recovery/desktop behavior evidence. Recheck only a concrete gap or stale observation.

**Acceptance:** Recovery works without replay, active writers stay protected, failed reads remain reads and the intended desktop route survives relaunch. Code completion, live acceptance and unavailable-platform follow-up are recorded separately.

**Evidence to retain:** Public code/review/CI references; private release, runtime canaries and rollback evidence.

#### RC26-DEL-02

**Close the telemetry, history and inventory lot**

Lot 2 · P2 · delivery gate · Initial state: `planned`.

Dependencies: RC26-OBS-04, RC26-OBS-05, RC26-OBS-06, RC26-HIS-04, RC26-INV-02, RC26-INV-03, RC26-INV-04. Sources: F03, F05, F06; M09, M10.

Qualify collection on all intended entry points and verify a fixed-window accounting report, history rollover, retention independence and current inventory. Measure overhead and preserve the existing execution/recovery behavior.

**Acceptance:** Traffic is attributed or explicitly unattributed; reports state their population and coverage; version/startup drift is visible. A 60–90 day retention feature can be tested by synthetic time advancement, but a full real historical window is claimed only after it exists.

**Evidence to retain:** Same-window private reconciliation; synthetic retention tests; exact-release canaries.

#### RC26-DEL-03

**Close usability and compatibility with real workflows**

Lot 3 · P2 · delivery gate · Initial state: `planned`.

Dependencies: RC26-UX-02, RC26-UX-03, RC26-UX-04, RC26-UX-07, RC26-GOV-01, RC26-GOV-02, RC26-MCP-05, RC26-TMO-01, RC26-TMO-02, RC26-DOC-01. Sources: F07, F08; E01, E04, E05, E09; M09, M10.

Repeat the baseline workflows through supported real clients. Validate doctor, compact results, job progress, console fallback and cancellation/recovery. Reconcile exact-head review records and update the current compatibility documentation.

**Acceptance:** The changed workflow reduces measured calls/bytes/time or improves demonstrated diagnosis without reducing correctness or owner control. Required client/platform gaps remain explicit. Historical review tasks close only with their own evidence.

**Evidence to retain:** Before/after workflow results; protocol/client matrix; private review and runtime readback.

#### RC26-DEL-04

**Record a decision for every experiment and the remaining backlog**

Lot 4 · P3 · decision gate · Initial state: `planned`.

Dependencies: RC26-EXP-01, RC26-EXP-02, RC26-EXP-03, RC26-EXP-04, RC26-EXP-05, RC26-PERF-02, RC26-PERF-03. Sources: E01–E10; M10.

Record adopt, retain current implementation, defer with reopening condition, or not-adopted with evidence for each optional direction. A dependency on a conditional experiment is a decision gate, not an obligation to implement it. Update the public tracker and private handoff.

**Acceptance:** Every audit finding and external comparison has a traceable disposition. No novelty is adopted merely to mark a checkbox complete. Deferred device/client validation remains visible and cannot be counted as implemented or production-qualified.

**Evidence to retain:** Experiment decision table; coverage check; private final handoff.

## Complete traceability matrix

The stable F/E/M labels let the private evidence index and this public engineering backlog refer to the same requirement without publishing operational identifiers. Multiple labels can map to one implementation; do not duplicate work or count it as separate delivery.

### Findings

| Finding | Primary work items | Supporting work / delivery |
|---|---|---|
| F01 | REC-01–05 | UX-05, MCP-04, TMO-01, DEL-01 |
| F02 | DEP-01–05 | INV-02, UX-01, DEL-01 |
| F03 | OBS-01–06 | BASE-02, HIS-01–02, UX-06–07, DEL-02 |
| F04 | EFF-01–03 | OBS-03, HIS-03, UX-01, DEL-01 |
| F05 | HIS-01–04 | BASE-02, OBS-04, PERF-01–03, DEL-02 |
| F06 | INV-01–04 | DEP-01/03/05, DOC-01, DEL-02 |
| F07 | UX-01–07 | BASE-03, TMO-01–02, MCP-01–05, EXP-03–05, PERF-01–03, DEL-03 |
| F08 | GOV-01–03 | DOC-01, DEL-03–04 |

All short IDs in matrices expand to the `RC26-` prefix. The tracker contains the authoritative full-ID rows and links to their individual acceptance criteria.

### External developments and recommended disposition

These are source-backed comparison inputs reviewed for this plan. Reconfirm the relevant version before implementing. They are not measured RC performance claims.

| ID | Source and relevant change | Decision / gate | Work items |
|---|---|---|---|
| E01 | [Desktop Commander releases](https://github.com/wonderwhy-er/DesktopCommanderMCP/releases): 0.3.2 and 0.3.3 address call budgets/process handling and a Remote MCP authentication issue. | Compare wait/process contracts; do not add this product as a dependency. Its security fix is not evidence of an RC vulnerability. | REC-01–04, TMO-01, UX-05–06 |
| E02 | [Agent Desktop 1.3.0](https://github.com/vercel-labs/agent-desktop/releases/tag/v1.3.0) addresses session/reference/trace/MCP/wait transitions; [Linux requirements](https://agent-browser.dev/desktop/platforms/linux) describe the graphical user-session prerequisites. | Qualify the selected managed engine and actual adapter route. A PATH binary version does not close integration. | DEP-02–05, INV-02 |
| E03 | [Windows-MCP releases](https://github.com/CursorTouch/Windows-MCP/releases), including 0.8.9: availability reasons, heartbeat during UI collection, UIA timeouts and unresponsive applications. | Verify these behaviors in RC; compare backends only on an available native test host. | UX-01/06, TMO-02, EXP-04 |
| E04 | [Cua CLI](https://cua.ai/docs/cua-cli) provides a composed doctor diagnostic and typed failure categories. | Reuse the diagnostic pattern with existing RC probes. A new sandbox/VM platform is outside this plan unless a later measured need justifies it. | UX-01, INV-03 |
| E05 | [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), and [official conformance](https://github.com/modelcontextprotocol/conformance). | Verify the existing modern and legacy paths, discovery, result contracts, cache behavior and cancellation/recovery on actual clients. | MCP-01–05, DOC-01 |
| E06 | [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview) supplies durable task handles and task interaction. | Probe actual client negotiation first. Pilot an adapter over existing jobs only if supported; otherwise defer explicitly. | EXP-01–02 |
| E07 | [OpenTelemetry MCP conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md), marked Development, describe trace propagation and metrics. | Use a versioned internal correlation contract with optional convention mapping/export. A large new monitoring stack is not a prerequisite. | OBS-01–06, HIS-01–04 |
| E08 | [Mobile MCP releases](https://github.com/mobile-next/mobile-mcp/releases), including 1.0.17: Android orientation and tap-coordinate fixes. | Finite geometry benchmark on a test device; preserve Companion unless evidence justifies a change. | EXP-03 |
| E09 | [MCP Apps overview](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html) defines interactive UI in capable hosts. | Improve the existing console's progress, causes and coverage; keep tool/text fallback and verify real-host behavior. | UX-07, MCP-05 |
| E10 | [Playwright CLI for coding agents](https://playwright.dev/docs/getting-started-cli) describes a CLI/skills route complementing persistent MCP interaction. | Compare one fixed application-testing flow and adopt only where it reduces a measured cost without loss of correctness or recovery. | EXP-05 |

### Methodology, preservation and follow-through

| Label | Requirement that must not be omitted | Coverage |
|---|---|---|
| M01 | Dated evidence, provenance, exact code identity and implementation-vs-analysis distinction | BASE-01, GOV-03 |
| M02 | Fixed windows, timezone, cutoff, deduplication, denominator and percentile definition | BASE-02, OBS-04, HIS-02 |
| M03 | Request success is not task success; nonzero exits, protective conflicts and long polls need context | BASE-02, EFF-02, HIS-02, TMO-01 |
| M04 | Last-hop loopback and RPC request-ID hashes do not identify callers or prove retries | OBS-01–04 |
| M05 | Profile linear scans and memory over time before index/refactor or hardware conclusions | HIS-04, PERF-01–03 |
| M06 | Meaningful failure, concurrency, restart, stale-proof, native and recovery scenarios | BASE-03, REC-04, DEP-04–05, EFF-02–03, HIS-03, MCP-04 |
| M07 | Native/client unavailable remains unverified; compatibility is not equal SHA everywhere | BASE-01, INV-02–03, MCP-05, EXP-03–04 |
| M08 | Preserve local edits, canonical source/release separation, stable state and original receipts | BASE-01, REC-05, DEP-05, INV-04–05 |
| M09 | Exact-release behavior and rollback evidence; no compilation/CI-only production claims | DEP-05, MCP-05, PERF-03, DEL-01–03 |
| M10 | Per-item status/evidence/dependencies; private task synchronization; justified non-adoption | GOV-03, DEL-01–04 |

## Validation and completion rules

For implementation, reproduce the relevant failure when practical, exercise the changed behavior through the real MCP layer, and compare the same scenario after the change. Use synthetic data for public tests. Run the repository's required checks and relevant platform regressions. Expand testing only for a concrete remaining risk or a required gate.

Before application promotion, complete the repository's review and CI workflow on the exact candidate. Verify tracked source and generated artifacts, preserve a verified recovery point and account for in-flight work. After promotion, verify the actual running route and original behavior. A source commit, successful build, healthy HTTP endpoint or CLI version is insufficient by itself.

Documentation-only changes require scoped diff/format/link/coverage review and the repository publication checks; they do not need a runtime deployment. This planning change does not claim any application test or live remediation has passed.

Use these evidence levels consistently:

| Level | What it establishes | What it does not establish |
|---|---|---|
| Source / schema | Intended contract and code path | Running release or native behavior |
| Synthetic functional test | Reproducible behavior in the test environment | All real clients/devices or power-loss durability |
| Actual MCP/client probe | Contract delivered on that inspected route | Other clients or absent platforms |
| Runtime identity and canary | Inspected deployed release and checked scenario | Universal correctness or unmeasured workloads |
| Independent effect verification | The specified effect occurred as observed | Exactly-once execution under arbitrary state loss |

An item is verified only for its stated scope. Record the precise outstanding platform/client checks. Experiments finish with a decision and evidence; they need not result in implementation. Deferred work must state a concrete reason, dependency and condition for resumption.

## Maintaining the plan

Update the [tracker](2026-11-16-improvement-tracker.md) in the same change that advances an item. Preserve stable IDs; add a new row or explicit supersession rather than silently deleting an unresolved requirement. Link public commits, PRs and synthetic checks in Git. Keep operational paths, device details, raw metrics and execution/task identifiers in private records under the matching stable ID.

At each lot boundary, verify the F01–F08, E01–E10 and M01–M10 crosswalk again. Save the current result, evidence limits, unresolved work and next action to the correct private task. A new session should continue from that checkpoint, not restart an uncertain execution.
