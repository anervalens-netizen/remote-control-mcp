# Implementation evidence and measurement contract

Date: 2026-11-16. Scope: [improvement plan](2026-11-16-improvement-plan.md), BASE-01–03 and the first implementation lot.

This file defines reproducible evidence. The [implementation tracker](2026-11-16-improvement-tracker.md) owns current completion states. A scenario definition is not a passing result. Native receipts, real inventories, measurements, rollback copies and task identities remain in private operator records under the same RC26 IDs.

## Evidence baseline

The inspected public baseline is `b4e1ac7334f42246f219a0a29bc082dcc505b1c5`. Its application source is inherited from `c3864ea22e4a60f4a258d1b070e99818c49c2542`; the intervening change adds the plan and tracker. Both public CI workflows passed for the baseline. Work proceeds in an isolated worktree, with existing changes and persistent journals preserved.

| Finding | Primary source / evidence type | Current disposition | Verification limit |
|---|---|---|---|
| F01: synchronous repository recovery | [coordination routes](../../apps/agent/src/coordination-routes.ts), [coordinator](../../apps/agent/src/coordination.ts), [repository operations](../../apps/agent/src/repo.ts); synthetic partial fetch/pull failure | REC-01–04 implement durable execution binding and supported reconciliation. REC-05 applies the qualified path to the existing incident. | The reproduction establishes the failure mode. It does not prove that an old operation without a receipt stopped. |
| F02: archive identity and desktop route | [agent runtime](../../apps/agent/src/runtime.ts), [release verifier](../../scripts/verify-release.ts), [semantic environment](../../apps/agent/src/semantic-desktop-env.ts), private authenticated runtime/session inspections | DEP-01–05 cover release integrity, owner routing, managed engine and relaunch. | A full tracked-source comparison, an environment SHA, a process path and desktop behavior prove different facts. |
| F03: traffic attribution and measurement | [agent HTTP entry point](../../apps/agent/src/index.ts), [controller observer](../../apps/mcp-server/src/operation-observer.ts), private fixed-window agent/controller counts | OBS-01–06 remain a separate lot. Baseline counts identify an attribution gap. | Unattributed traffic is not classified as retries, abuse or another known origin without correlation evidence. |
| F04: read failures reported as uncertain effects | [tool defaults](../../apps/mcp-server/src/tool-contract-defaults.ts), [operation observer](../../apps/mcp-server/src/operation-observer.ts); synthetic identical failure supplied to a read and an effectful tool | EFF-01–03 centralize the contract and distinguish failed observation without reclassifying unknown historical effects. | Argument-sensitive tools need the actual invocation discriminator. Tool names alone do not prove historical read-only behavior. |
| F05: selectively retained history | [operation observer](../../apps/mcp-server/src/operation-observer.ts), private retention/coverage inspection | HIS-01–04 plan independent aggregates and bounded read-only reconciliation. BASE-02 fixes the reporting contract now. | Retained unresolved records are not a complete historical population. An apparent daily trend can be retention bias. |
| F06: inventory, startup and source drift | [inventory example](../../config/devices.example.json), [runtime](../../apps/agent/src/runtime.ts), private source/service/startup inspection | DEP and INV work preserve existing identities/state; immutable releases and canonical development workspaces are distinct. | An unavailable device or a configured startup target is not an observed running version. |
| F07: workflow and result ergonomics | [result/recovery contracts](../RELIABILITY.md), finite scenarios below and private call/output measurements | BASE-03 defines equivalent experiments before UX/TMO/PERF changes. | Command time includes workload execution. Response bytes and schema characters are not billed tokens. |
| F08: review/task closure | [repository instructions](../../AGENTS.md), public exact-head review/CI, private task readback | GOV-03 applies checkpoint discipline throughout the lot. GOV-01–02 retain complementary review and exact-head reconciliation. | An old approval, a requested review, a posted disposition or a locally passing test is not current-head approval or accepted task closure. |

The baseline refresh includes current code, selected live runtime, graphical-session prerequisites, relevant task state and release targets. Historical reports remain labeled as historical; unavailable platforms remain unverified. Reuse existing durable jobs, process containment, release verification and managed engine qualification instead of creating parallel mechanisms.

## Reviewed application and scoped runtime qualification

PR54's application reviews completed against `71956e868c96fca01506b46f3dbf06911d2b6383`; Codex reported no findings and the [published disposition](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#issuecomment-6926185868) covers all 21 findings. The [merge commit](https://github.com/anervalens-netizen/remote-control-mcp/commit/9682af5bd2e6e4ae658dfdbcd55532f9ba5cdd32) has the same tree and four passing merge checks. The deployed source identity is `9682af5bd2e6e4ae658dfdbcd55532f9ba5cdd32`; a later documentation commit does not change installed bytes or that runtime identity.

| Qualified scope | Observed result | Limit |
|---|---|---|
| Selected Linux controller/root/owner routes | Actual HTTP MCP returned the expected merge release, matching manifest pins and distinct expected UIDs. The deployed harness completed with its requested assertions passing. | This is the selected deployment scope, not an assertion about every fleet endpoint. |
| Recovery-host owner promotion | The successful promotion ran once and completed without rollback; an independent guard verified the outcome and disarmed. Full source/artifact checks and actual MCP confirmed the expected owner UID, ready state, new process identity, source `9682af5`, matching manifest pin and unchanged state root. Root, relay and other protected service identities, and the preserved historical records, stayed unchanged. | Desktop is disabled on this host and no interactive session is claimed. Promotion does not prepare or reconcile the historical incident, release its fence or replay its operation. |
| Historical recovery intent | The intent was saved and verified on disk and through actual MCP. The original journal hash and uncertain fence were unchanged. | The effect remains unknown and quiescence unverified. No reconciliation, fence release, replay or reboot occurred. The saved intent alone cannot retire the historical writer. |
| Managed engine identity | Status was successful; the loaded manifest's declared engine binary hash matched the supplied expected binary hash. | `engineIdentity.sha256` is the binary digest, not the digest of the manifest JSON. Saved provenance was reported without a new upstream check. |
| Failed read versus failed write | Actual MCP and observation inspection preserved the original read error while classifying the failed read as an observation failure. The failed synthetic write remained unknown. | Strict journal v1 and historical retention limits still apply; no historical records were rewritten. |
| Delayed repository operation | The original pending receipt was observed while the job was running and its fence active. The same job terminated with exit 1; reconciliation released its original token/key/fingerprint, and repeat reconciliation returned the same disposition. | The initial pending response does not observe operation/publication outcomes. Terminal process evidence remains separate from effect verification. |
| Immediate repository operation | The original tool-error receipt preserved `operationSucceeded=false`, `executionOutcome=exit_nonzero` and `resultPublication=available`. | Failed Git work can have partial effects; an HTTP error alone does not determine the process outcome or replay safety. |
| No replay and partial effects | Both synthetic operations had one initial dispatch and one local transport invocation. Fetch effects persisted while HEAD/worktree remained unchanged. | Both owned Git fixtures were subsequently removed and their absence verified. Original evidence artifacts and all job/coordination/observer records were preserved. |
| Desktop before controlled relaunch | Actual MCP changed a synthetic value, independently confirmed by the fixture. A click was reported `delivered_unverified`; an independent count then established one click. Status and repeat execute recovered the original command with `replayed=false`, leaving the count at one. | These are pre-restart observations. They do not qualify continuity after a service restart or a change of graphical session. |
| Controlled owner relaunch | The owner process identity changed; configuration, executable, state roots and engine digest were preserved, while root/controller identities stayed unchanged. Actual MCP confirmed the pinned source and recovered the original canary/command receipts without replay. Fresh value/click effects matched independent fixture readback. The owned canary then stopped with identity-bound whole-tree termination evidence, and its window was absent. | This is observed service-relaunch behavior. No graphical logout occurred; session/fingerprint negatives remain source-test coverage. It does not qualify physical Windows/Android hosts or a machine reboot. |
| Unknown observation rejection | The deliberate unknown observation was refused with `not_delivered` and `stale_observation_or_session_unavailable`. A fresh independent fixture read confirmed the original value and count of one unchanged. | Source tests cover changed session/fingerprint cases. This runtime case does not claim an actual logout or a physical-host session transition. |

An earlier recovery-host permission failure stopped before any service-process change; the prior configuration baseline was verified and its failed-attempt evidence was retained. The subsequent successful promotion is a separate attempt and did not require rollback.

A guarded activation failure also exercised configuration-only rollback. The previous service configuration and running entrypoints were verified after rollback, with state journals preserved and no operation replay. This qualifies the observed rollback path; it does not establish full-state restore or power-loss recovery.

The existing source/native suites cover the reviewed implementation's fault, concurrency, restart and journal-compatibility cases. Those results are reused for the identical merge tree; they are not represented as fresh runtime fault injection. Hosted Windows CI qualifies only its test runner. Physical Windows/Android hosts and unobserved graphical-session transitions remain unqualified. The controlled owner relaunch and post-relaunch actual MCP desktop checks are qualified for the selected Linux route. The historical incident still lacks the required quiescence evidence. The finite implementation and incident checkpoints and resumable private handoffs have been read back with that single unresolved operational blocker preserved. Final publication references are recorded in the post-publication private readback; this checkpoint does not close the incident or the dependent lot.

## Open client observations

UX-03 / MCP-03: the existing `maxBytes` parameter selects line mode even without `startLine`/`lineCount`. On deployed source `9682af5`, `versioned=true` with `maxBytes` and no `offset`/`length` returned HTTP 500; combining `maxBytes` with `offset`/`length` returned HTTP 400. Versioned byte paging with `offset=0`, `length=6000` and no `maxBytes` returned the complete 3,498-byte body with `eof=true`. The relevant source paths are unchanged from the pre-PR base; this input-contract/documentation gap predates the delivery. No client default injection or runtime/UI fix is claimed. The follow-up is to clarify mode-specific fields, reject incompatible combinations consistently and verify catalog/handler parity through production SDK registration and the real connector, while preserving versioned byte paging and its `sourceVersion`/`nextOffset`/`eof` contract.

UX-03 / OBS-03: client reconnect banners were reported during the session. Subsequent actual MCP probes showed the same ready process identities and source. The cause is unassigned and no fix is claimed.

## Comparable measurement contract (BASE-02)

Every exported measurement must carry:

| Field | Required meaning |
|---|---|
| Window | Exact UTC `startInclusive`, `endExclusive` and independent `collectedAt`; include the display timezone if different. |
| Population | Controller calls, agent ingress requests, dispatched executions, or terminal jobs. Never mix these denominators. |
| Identity | Controller instance plus trace ID for calls; stable job/operation identity for executions; origin and agent instance for ingress when available. Missing origin stays unattributed. |
| Deduplication | State the key. Repeated reads of one job are multiple requests but one execution. Do not deduplicate distinct intended runs by command text. |
| Coverage | Complete, partial or unknown; retained interval, gaps, sampling, omitted pages and collection cutoff. Zero observed is not proof of zero activity. |
| Outcome | Request completion, process outcome, caller acceptance and independently verified effect are separate fields. |
| Duration | Identify the measured span: whole request, queue, agent RPC, command, long-poll wait or output/delivery. State whether timeout/censoring is present. |
| Distribution | Sample size, min/median/p95/max as appropriate, and nearest-rank percentile method. Unknown or censored durations are counted separately. |
| Comparison | Same fixture, workload, route, identity, cache policy, runtime/tool versions, output budget and collection rules for baseline and candidate. |
| Cost | Calls, returned UTF-8 bytes and elapsed time. Record token usage only when the actual client exposes it, with model/client identity. |

For sorted returned durations `x[1..n]`, percentile `p` is `x[ceil(p*n)]` for `0 < p <= 1`. Empty samples produce no percentile. Do not substitute a completed duration for an in-flight or timed-out operation.

### Outcomes

| Observation | Request classification | Execution/effect interpretation |
|---|---|---|
| Read returns a tool error | Failed observation | No effect uncertainty is inferred from the failure of the audited read. |
| Effectful tool disconnects after possible dispatch | Delivery or request failure | Effect remains uncertain until exact execution evidence resolves it. Never replay solely because the response is missing. |
| Exec returns a nonzero exit code | Successful request if the response contract succeeded | Process failed; whether that was expected depends on the command. Partial effects may exist. |
| Job wait reaches its normal bounded deadline | Successful resumable read | The job may still run. This is not a command timeout or cancellation. |
| Coordination rejects a stale token or active writer | Protected/preflight rejection | The rejection is not automatically a product reliability defect. |
| Agent reports process exit zero | Execution evidence | Caller acceptance and the intended external effect can still be unverified. |
| Historical mixed tool has no saved arguments | Unknown classification | Keep the protected record; do not guess that it was a read. |

### Synthetic coverage examples

1. A complete sample has ten returned durations of 1–10 ms. Nearest-rank median is 5 ms and p95 is 10 ms. Two commands return nonzero codes while all ten requests return valid receipts: request failures are 0/10; nonzero process outcomes are 2/10. This is not a 20% transport failure rate.
2. Only the last three observations survive retention: 8, 9 and 10 ms. Their median is 9 ms and p95 is 10 ms, with `n=3` and partial coverage. They cannot establish that population latency increased from 5 to 9 ms.
3. One keyed job is started once and read four times. Request count is five and execution count is one. A normal wait expiry increments neither execution failure nor a second start.
4. An agent has more ingress requests than the controller can correlate in the same window. Report attributed and unattributed counts with coverage. A ratio cannot identify the missing callers without trace/origin evidence.

No synthetic example above is a live usage statistic.

## Finite behavior and ergonomics scenarios (BASE-03)

Use temporary synthetic files/apps and a private result directory. Preserve one immutable baseline and one candidate release. Use equivalent conditions for paired measurements. Run one correctness qualification before measuring; report all failures and the exact number of timed runs instead of discarding inconvenient samples. Do not use personal browser tabs or real application data.

| Scenario | Fixed input and prerequisites | Required visible result and recovery checks | Measurements |
|---|---|---|---|
| B01 Read-only inspection | A known synthetic UTF-8 text fixture; fixed byte/page limit; same endpoint and identity. Read a valid path and a missing path. | Exact content/count/cursor; missing-path diagnostic; failed read does not become an uncertain effect. | Calls, returned bytes, request elapsed time, correctness and diagnostic category. |
| B02 Short effect with lost delivery | A fresh output path and a caller-known execution receipt/key; command appends one fixed marker; deliberately drop only the response in an isolated harness. | Recovery finds the original execution. Marker exists exactly once. Repeated recovery does not dispatch a new command. | Initial plus recovery calls/bytes, time to recover, marker count; acceptance remains unknown if the real client does not expose it. |
| B03 Variable-duration job | A keyed synthetic job emits three fixed progress lines with controlled delays; same wait/output limits. | Wait expiry is resumable; final output reconstructs exactly from byte cursors; client disconnect does not cancel/restart the job. | Starts versus reads, returned bytes, wall time, wait count and output completeness. |
| B04 Repository recovery | Temporary bare origin and clone; fixed commits; introduce a synthetic index lock after fetch can advance remote refs. | One pull execution; failure remains failure; exact token/generation/base fences; active writer blocked; terminal evidence permits reconciliation without replay; missing proof remains protected. | Git invocations, request/recovery calls, output bytes, elapsed time, HEAD/ref/marker correctness and rejection categories. |
| B05 Desktop observation/action | Ephemeral titled fixture with an accessible text field and button; qualified owner session and managed engine; known fixture version. | Observe, set a fixed synthetic value, read it independently, click once, recover same command without another click. Stale/session-mismatched references reject. Repeat after controlled agent relaunch. | Calls, returned bytes, elapsed time, value/click count and prerequisite/error clarity. No personal screenshots. |
| B06 Intermittent-device diagnosis | A synthetic unavailable endpoint and bounded request budget; then the same test agent restored. | Return a specific unavailable/prerequisite result; bounded probing; no unrelated fan-out or effects. Distinguish endpoint, identity and graphical-session absence. | Calls, bytes, failure latency, retry/backoff behavior and diagnostic category. |
| B07 Browser task | Fresh controlled browser context and local synthetic HTML form; fixed selectors/content. | Observe the expected element, perform one reversible form action, read back the changed value and close only the owned context. | Calls, bytes, elapsed time, correctness and stale-context diagnostics. |

Native rows require the actual adapter/client route. A direct backend test is useful component evidence, but does not close the actual MCP-route acceptance. A mocked missing-session test does not certify every desktop environment. Session changes that would interrupt unrelated work should be tested with synthetic session fingerprints or a dedicated test session; record the limitation rather than logging out a live user.

### Result record

Each run must retain: scenario/version, baseline or candidate full commit, actual running identity, relevant dependency versions, platform/client, fixture seed, start/end/cutoff, request and execution counts, returned UTF-8 bytes, elapsed milliseconds, expected/observed result, diagnostics, recovery identity, coverage and limitations. Private evidence may retain the exact remote paths and IDs; public results must stay synthetic.

B01–B07 are a finite test contract. The tracker stays active until equivalent measurements are recorded. Source tests and individual native qualification can close their explicitly scoped REC/EFF/DEP items without claiming the complete ergonomics benchmark has run.

## Review follow-up boundaries

The [DSHv4 report](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#issuecomment-6924341173) reviewed `71956e868c96fca01506b46f3dbf06911d2b6383`. Its [published disposition](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#issuecomment-6926185868) records the following residuals under existing work items. A deferred hardening scenario is not a passing result or owner risk acceptance.

| Review item | Current limit and scope | Evidence required to close |
|---|---|---|
| PR54-DSH4-01 · REC-04/HIS-04/MCP-04 | Sharing-root containment is lexical. A trusted participant can redirect a nested path through a writable symlinked parent; the physical target can receive shared directory access outside the configured root. Ordinary missing-ancestor mode correction remains distinct. | A temporary symlink/retarget fixture, an explicit physical-containment policy and qualified traversal behavior. Preserve private defaults, existing ownership/group/setgid, bounded publication and no-replay identities. |
| PR54-DSH4-N1 · HIS-04/REC-04/MCP-04 | An externally removed, pre-created receipt parent can be recreated by the generic atomic writer with the umask default. Normal pre-creation and file-mode checks do not cover that window. | Inject parent deletion between configured creation and receipt publication. Verify the chosen directory policy, recoverable original evidence and conservative failure behavior through the actual result contract. |
| PR54-DSH4-N2 · REC-03/REC-04 | A null binding only describes availability in the returned record view. It cannot prove that no artifact was published or that admission did not occur, and cannot authorize replay. | The conservative contract clarification is fixed in documentation commit `b6d1fa2` and recorded in the current published disposition. `not_started` still requires invocation-bound pre-dispatch proof; no new execution claim follows from a missing field. |

The original DSHv4 report misstated the `7504ac4` comparison. Its record correction, published on 2026-11-16 at 18:00:06 UTC, confirms that the retained-binding regression passed on both `7504ac4` and `71956e8`; only the two directory-boundary regressions failed against `7504ac4`. Findings, severities and verdict are unchanged. The retained-binding case pins existing behavior, not a new runtime fix. The [recovery](../../tests/coordination-recovery.test.ts) and [sharing](../../tests/coordination-sharing.test.ts) cases retain their separate scopes. This clarification adds no new runtime measurement, promotion result or native-platform qualification.

## Lot 1 promotion and rollback evidence

1. Preserve the previous verified release, effective service overrides, configuration and journals before changing startup.
2. Run local regressions, publication checks, required exact-head reviews and CI for the application candidate. Record disposition of every finding against that head.
3. Generate a release identity only after comparing the complete tracked source to the immutable commit. Include generated executable/UI artifacts in an explicit local hash scope. Dependency/runtime/configuration provenance remains separate.
4. Upgrade dependent agent capabilities before the controller where required; validate the selected identity. Preserve root administration and owner session separation.
5. Check authenticated runtime diagnostics, actual process/executable path, managed engine status and behavior through MCP. Repeat after controlled relaunch.
6. Keep rollback receipts and known-good startup targets. A restored old configuration must retain the same persistent state. First-time managed-engine installation has no previous manifest: its pre-install baseline is absence, not a fictional previous release.
7. Reconcile the legacy incident only with qualified evidence. A lease timeout, absent PID, agent restart or matching repository snapshot is insufficient proof that an unbound process tree stopped.
8. Close DEL-01 only after its dependencies have evidence or an explicit unresolved blocker. A merged PR alone does not close the lot.
