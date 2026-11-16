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

## Lot 1 promotion and rollback evidence

1. Preserve the previous verified release, effective service overrides, configuration and journals before changing startup.
2. Run local regressions, publication checks, required exact-head reviews and CI for the application candidate. Record disposition of every finding against that head.
3. Generate a release identity only after comparing the complete tracked source to the immutable commit. Include generated executable/UI artifacts in an explicit local hash scope. Dependency/runtime/configuration provenance remains separate.
4. Upgrade dependent agent capabilities before the controller where required; validate the selected identity. Preserve root administration and owner session separation.
5. Check authenticated runtime diagnostics, actual process/executable path, managed engine status and behavior through MCP. Repeat after controlled relaunch.
6. Keep rollback receipts and known-good startup targets. A restored old configuration must retain the same persistent state. First-time managed-engine installation has no previous manifest: its pre-install baseline is absence, not a fictional previous release.
7. Reconcile the legacy incident only with qualified evidence. A lease timeout, absent PID, agent restart or matching repository snapshot is insufficient proof that an unbound process tree stopped.
8. Close DEL-01 only after its dependencies have evidence or an explicit unresolved blocker. A merged PR alone does not close the lot.
