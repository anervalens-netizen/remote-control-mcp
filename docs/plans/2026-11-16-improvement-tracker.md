# Reliability and usability implementation tracker

Scope version: 2026-11-16. [Full plan, acceptance criteria and sources](2026-11-16-improvement-plan.md).

**Consolidated execution cadence (2026-11-18):** Use the
[batch delivery crosswalk](2026-11-18-consolidated-delivery.md) to implement
related items together. The 61 ID rows remain independent acceptance checks,
**not** instructions to create 61 pull requests or request reviews after
every small change. Request grouped Codex/DSH reviews and full CI only after
the stable application batch is ready. Keep historical incident recovery and
the DSH worker isolation boundary independently qualified.


This is the single implementation checklist for the improvement plan. It covers **61 work items** (the original 60 plus the implementation follow-up INV-05), all **F01–F08 findings**, all **E01–E10 ecosystem comparisons**, and **M01–M10 methodology/preservation requirements**. Original planning baseline: **55 planned, 5 conditional, 0 implemented or verified by that planning change**. INV-05 was subsequently added as planned. The state of an existing capability must be refreshed before implementing its proposed extension or verification.

The public tracker records engineering status and sanitized evidence only. Operational measurements, real device details, private task/execution IDs and deployment/rollback receipts stay in private project memory under the same stable work-item ID. Do not copy the operational audit into this repository.

## Current implementation checkpoint

PR #57 was merged as [`18e273e`](https://github.com/anervalens-netizen/remote-control-mcp/pull/57)
with the same source tree as the reviewed `046d5d1` candidate. Required Linux,
Windows and public-source CI passed and Codex reported no findings on the
exact final PR head. The independent DSH final-head review remains outstanding:
the owner authorized a temporary deferral, **not** an approval or a claim of
completed review. Follow-up is tracked in [issue #59](https://github.com/anervalens-netizen/remote-control-mcp/issues/59).

Selected Linux controller/agent endpoints were separately qualified after
activation through authenticated MCP SDK discovery and `usage_window`
open/collect/close/read; the bounded collected window reported complete
accounting. A mixed-version older agent retained `usage_report` compatibility
and correctly reported `usage_window` as unsupported. These scoped observations
do not qualify every fleet platform, ChatGPT-host catalog refresh or console
integration. See [bounded-window source contracts and synthetic fixtures](2026-11-17-window-evidence.md).
REC-05 and DEL-02 remain open.

2026-11-17: lot2 candidate `d0e5756` was integrated as `13d7563216b629f582bbb9e7815cf797fb5d6a4d`, with the same source tree and passing merge CI. The selected controller and three Linux agent identities are activated from that source. All three finite 9-agent/5-controller windows and all three subsequent persistence-progress probes qualified. The original task-linked job's diagnostic association was verified from preserved metadata captured before sample eviction, followed by separate terminal and bound ContextKeep verification readbacks. A subsequent live selected Linux task also matched the original execution receipt, runtime readback and bound ContextKeep verification. Both live collector reports remain inconclusive and are not relabeled as passes.

These selected-route results do not close the complete lot2 acceptance contract. See the [current merge and runtime evidence](2026-11-16-lot2-evidence.md#merge-and-selected-runtime-qualification).

The earlier lot1 checkpoint remains historical evidence for source `9682af5`: PR54 application reviews and all 21 dispositions completed for `71956e8`, and its merge had the identical tree and four passing checks. That rollout qualified actual MCP recovery/effect behavior, synthetic desktop actions, controlled owner relaunch and a separate owner promotion with desktop disabled. Those earlier observations are not relabeled as fresh desktop qualification of the lot2 release. The historical recovery intent, original journal and uncertain fence remain preserved; the effect remains unknown and quiescence is unverified. REC-05 remains unresolved and DEL-01 remains blocked by it.

[Earlier evidence index, metric definitions and finite scenarios](2026-11-16-implementation-evidence.md).

The tracker retains its original 61 work-item IDs. Two additional
live-discovered follow-ups remain tracked in GitHub without silently deleting
or relabeling existing items:
[issue #58 — coordination-capacity diagnostics](https://github.com/anervalens-netizen/remote-control-mcp/issues/58)
and [issue #59 — DSH provider-capacity and deferred-review continuity](https://github.com/anervalens-netizen/remote-control-mcp/issues/59).
The REC-07 follow-up is tracked in
[issue #62 — evidence-bound reconciliation after a failed Git pre-commit hook](https://github.com/anervalens-netizen/remote-control-mcp/issues/62).
[PR #63](https://github.com/anervalens-netizen/remote-control-mcp/pull/63) retains an invocation-bound failed commit observation:
the Git command exit code, bounded before/after metadata and its containment
limitation. The original generation remains uncertain and read-only inspection
can recover the observation. Matching Git status leaves the effect unverified. Process containment remains
unavailable for this synchronous boundary. A supported
reconciliation path remains open for REC-07. Both selected Linux agents now
run the pinned release containing PR #63. An isolated exact-release agent
qualified retained diagnosis, original index preservation and refusal to
reconcile the uncertain fixture using those observations alone.
The REC-06 follow-up was merged in [PR #60](https://github.com/anervalens-netizen/remote-control-mcp/pull/60)
as `4331c00` with current-head Codex and Linux/Windows/public-source CI green.
Selected Linux owner/root/controller activation and an additional Linux owner
route now run the same source release. Authenticated native MCP SDK
`coordination_capacity` and `usage_window` probes passed on both selected routes,
including zero missing event detail and arithmetic residual. The diagnostic
reports bounded slot categories and explicitly unverified binding evidence,
without changing any historical fence. Older-agent capability rejection was
also verified. A previously occupied slot became independently observable as
released, leaving **three unrelated uncertain slots still fenced**, with their
original journal bytes verified unchanged during the separate owner activation.
No manual unlock or replay was performed. Full fleet acceptance, ChatGPT host
discovery, historical uncertain-effect reconciliation and remaining capacity
clearance stay open under #58. The independent DSH review remains explicitly
deferred under owner instruction, **not** approved; issue #59 remains open.

Lot2 adds ingress correlation/counters/history, bounded usage reports, finite capability probes and the fs_read input-contract correction. All four candidate review checkpoints and the 52-finding public disposition are retained in the [development disposition matrix](2026-11-16-lot2-review.md). The public same-window collection/retention source follow-up is documented above; its review and deployed acceptance, automatic orphan recovery and complete history/inventory/console, stage/export and pressure acceptance retain their explicit remaining work.

The previous selected lot2 runtime checkpoint used `13d7563216b629f582bbb9e7815cf797fb5d6a4d`. The additional PR57 rollout qualified `18e273e93c98d24520f6b38e88c8a3c1026fb546` for a narrower controller/agent scope. The subsequent PR60 rollout qualified `4331c00f0aad81cd649270e9a4ca7238737bfe44` for a selected Linux controller/root/owner scope and a separate owner endpoint, with full tracked-source release verification and actual authenticated MCP diagnostic calls. Other endpoints intentionally retain older releases. Repository HEAD, checkout state and documentation-only commits never substitute for separately inspected running identity. Hosted Windows CI qualifies its runner's source/backend cases, not a physical Windows host. Physical Android and other unobserved endpoints remain outside this runtime scope.

### Consolidated controller release

[PR #70](https://github.com/anervalens-netizen/remote-control-mcp/pull/70)
merged as `e469c6229a3f232d7bbde308348af0598bfbb503`. The selected controller
reported the matching pinned runtime and passed authenticated read-only doctor,
version, latency and existing-job checks. [Batch A/B qualification](2026-11-18-consolidated-delivery.md#pr-70-merge-and-controller-qualification)
records the verification scope and remaining limits. DSH exact-head review
remains deferred due to quota. Current inventory: **61 items — 28 verified, 11 active, 2 blocked, 5 implemented, 9 planned, 5 conditional, 1 deferred**.
The older counts and release evidence above describe their respective checkpoints.

[PR #71](https://github.com/anervalens-netizen/remote-control-mcp/pull/71)
merged as `85124e0fc94eed0b926a8aab4b524b214c47ca0e` and was verified on the
selected controller. A versioned private inventory classified the retained
retired entry as manual. Live fleet, capability and console observations
recorded the skip without a request to that endpoint. A synthetic HTTP
endpoint verified explicit alias routing. The authenticated ChatGPT console
displayed the manual check policy and completed a fresh selected Linux doctor
request. The selected Linux agents retained the pinned `e469c62` runtime.

## How to execute and update

1. Read the linked acceptance contract, current source and corresponding private evidence/task. Confirm that the item is still applicable.
2. Complete or explicitly disposition the dependencies. Claim an owner before changing status to active.
3. Reproduce/measure the relevant behavior, make the smallest justified change, and verify the same scenario. Preserve concurrent work and original recovery identities.
4. Update this row with the exact public commit/PR and relevant synthetic checks. Record native/runtime proof and limits privately.
5. Use `verified` only for the stated scope. Use an explicit deferred or not-adopted decision for conditional work; never call it implemented solely because a pilot was considered.
6. Save the result and next action to the correct private task. Review each lot gate and the complete F/E/M crosswalk before closing the lot.

Dependencies are gating evidence or decisions, not instructions to duplicate an already verified capability. All conditional experiments can be deferred or rejected with a reason. Their decisions are required for the final decision gate; their implementation is not required for lots 1–3.

## State definitions

| State | Meaning | Required next record |
|---|---|---|
| planned | Work identified; implementation has not been claimed. | Current evidence, dependencies and assigned owner. |
| active | One owner is executing the scoped item. | Current change/checkpoint and next action. |
| blocked | Required evidence, access or dependency prevents progress. | Concrete blocker and condition to resume. |
| implemented | Source/configuration change and relevant local checks exist. | Remaining exact-head review, client/native or runtime acceptance. |
| verified | Acceptance is met for the explicitly recorded scope. | Commit/PR, checks and location of private proof where applicable. |
| conditional | Start only after the documented support/device/profile gate. | Go/no-go evidence. |
| deferred | Intentionally postponed after inspecting the prerequisite. | Reason, dependency and reopening condition. |
| not_adopted | A measured comparison supports retaining the current solution. | Evidence and decision rationale. |
| superseded | Another identified item fully covers the requirement. | Replacement ID and preserved coverage mapping. |

## Work items

Lots: 0 baseline; 1 recovery/desktop/effect semantics; 2 observation/history/inventory; 3 usability/review/compatibility; 4 conditional experiments/performance. P1 is high impact, P2 is consolidation, P3 is optional measured work. Blank owner/evidence cells deliberately make no completion claim.

| ID and acceptance criteria | Work item | Lot | Priority | State | Dependencies (RC26-) | Owner | Evidence / PR / decision |
|---|---|---:|---|---|---|---|---|
| [RC26-BASE-01](2026-11-16-improvement-plan.md#rc26-base-01) | Refresh the baseline and bind the evidence | 0 | P1 | verified | — | Implementation agent | Dated source/runtime/task baseline and F01–F08 evidence index in [implementation evidence](2026-11-16-implementation-evidence.md). Native values remain private; unavailable platforms are unverified. |
| [RC26-BASE-02](2026-11-16-improvement-plan.md#rc26-base-02) | Define comparable usage and outcome measurements | 0 | P1 | verified | BASE-01 | Implementation agent | Measurement contract, outcome separation and complete/partial synthetic examples in [implementation evidence](2026-11-16-implementation-evidence.md). This verifies definitions, not future aggregate reporting. |
| [RC26-BASE-03](2026-11-16-improvement-plan.md#rc26-base-03) | Create a small repeatable behavior and ergonomics benchmark | 0 | P2 | active | BASE-02 | Implementation agent | B01–B07 finite scenarios defined in [implementation evidence](2026-11-16-implementation-evidence.md); equivalent baseline/candidate measurements remain pending. Finite B01/UX-04 synthetic batch comparison shows four vs one SDK call with per-item identity/errors; complete B01–B07 comparison remains pending. |
| [RC26-REC-01](2026-11-16-improvement-plan.md#rc26-rec-01) | Reproduce partial synchronous repository failure | 1 | P1 | verified | BASE-01 | Implementation agent | Synthetic fetch-then-index-lock pull failure reproduced once and persisted across restart. Runtime proof retained privately; regression tests are in the candidate. |
| [RC26-REC-02](2026-11-16-improvement-plan.md#rc26-rec-02) | Specify evidence-bound synchronous reconciliation | 1 | P1 | verified | REC-01 | Implementation agent | [Recovery contract](../COORDINATION-RECOVERY.md); sidecar design, base/identity fences, no-replay and strict v1 rollback tests. Native and historical proof limits are explicit. |
| [RC26-REC-03](2026-11-16-improvement-plan.md#rc26-rec-03) | Implement supported reconciliation for synchronous operations | 1 | P1 | verified | REC-02 | Implementation agent | Supported recovery qualified for the deployed Linux route at `9682af5`: actual HTTP MCP observed the original pending and tool-error receipts, followed the original durable jobs and reconciled their tokens without redispatch. Legacy historical recovery remains the separate REC-05 item; unsupported backends retain their declared limits. |
| [RC26-REC-04](2026-11-16-improvement-plan.md#rc26-rec-04) | Qualify recovery under concurrency and interrupted delivery | 1 | P1 | verified | REC-03 | Implementation agent | Qualified scope combines the exact-tree source/native suite with deployed HTTP MCP probes: the delayed receipt was observed while running with an active fence, then reconciled after exit 1; the immediate failure retained its original outcome/publication facts. Each synthetic pull and local transport executed once; partial fetch effects persisted, HEAD/worktree stayed unchanged, and repeated reconciliation returned the original receipt. The 18 native Git/job cases, seven-case sharing suite and integrated Linux gate (1,349 passed, 64 skipped) remain source/component evidence; three privileged sharing cases passed separately. DSH4 filesystem hardening stays deferred; physical Windows/Android hosts are not qualified. |
| [RC26-REC-05](2026-11-16-improvement-plan.md#rc26-rec-05) | Resolve the existing incident through the qualified path | 1 | P1 | blocked | REC-04 | Implementation agent | The recovery-host runtime is qualified. A recovery intent was saved and verified on disk and through actual MCP, while the original journal hash and uncertain fence stayed unchanged. The historical effect remains unknown and quiescence unverified. Neither exact original containment nor a qualifying post-intent boot transition has been established. No reconciliation, fence release, replay or reboot was performed; the next supported step still requires qualified quiescence evidence. |
| [RC26-DEP-01](2026-11-16-improvement-plan.md#rc26-dep-01) | Report verifiable archive release identity | 1 | P1 | verified | BASE-01 | Implementation agent | Full-tree archive identity, generated artifacts and manifest pins were qualified for the selected Linux deployment. Actual MCP diagnostics matched controller/root/owner release `9682af5`, the pinned manifest and expected execution UIDs. A separate recovery-host owner promotion and actual MCP check verified the same source, full source/artifact scope, matching pin and preserved state root; protected services and historical records stayed unchanged. This verifies those deployment scopes, not every fleet endpoint; later documentation commits do not relabel the installed release. |
| [RC26-DEP-02](2026-11-16-improvement-plan.md#rc26-dep-02) | Complete the owner route and graphical-session integration | 1 | P1 | verified | BASE-01 | Implementation agent | The selected Linux owner route and root administration were verified through actual MCP with distinct UIDs and the expected release. The owner desktop route reached a controlled graphical fixture and produced independently observed value/click effects. The separate recovery-host owner route also passed actual MCP readiness/identity checks; desktop is disabled there and no interactive session is claimed. Existing prerequisite/session regression coverage remains separately identified; no physical Windows/Android session is implied. |
| [RC26-DEP-03](2026-11-16-improvement-plan.md#rc26-dep-03) | Bind the adapter to the managed desktop engine | 1 | P1 | verified | DEP-02 | Implementation agent | Actual MCP status reported the selected managed engine identity, versions and loaded-manifest provenance; its declared binary SHA-256 matched the expected managed binary. The same selected route performed the synthetic value/click workflow. The saved provenance claim was preserved without a new upstream check; a manifest JSON digest is not the engine binary digest. |
| [RC26-DEP-04](2026-11-16-improvement-plan.md#rc26-dep-04) | Verify desktop behavior through the actual MCP route | 1 | P1 | verified | DEP-01, DEP-03 | Implementation agent | Actual MCP set a synthetic value that matched an independent fixture read. A click remained delivered_unverified until the fixture count proved one effect; status and repeated execute recovered the same command with replayed=false and count still one. An unknown observation was refused as not_delivered/stale_observation_or_session_unavailable; a fresh independent read confirmed the value and count unchanged. Qualification covers the actual synthetic Linux desktop plus source tests for changed session/fingerprint. It does not claim an actual logout or a physical Windows session. Post-relaunch qualification is recorded separately under DEP-05. |
| [RC26-DEP-05](2026-11-16-improvement-plan.md#rc26-dep-05) | Verify startup persistence and a reversible rollout | 1 | P1 | verified | DEP-04 | Implementation agent | Controlled owner-service relaunch changed the process identity while preserving configuration, executable, state roots and engine digest; root/controller identities stayed unchanged. Actual MCP after restart confirmed the pinned source, recovered the original canary and command receipts without replay, and verified a fresh value/click by independent readback. The owned canary then stopped with identity-bound whole-tree termination evidence and its window was absent. No graphical logout occurred; session/fingerprint negatives remain source-test coverage. Physical Windows/Android hosts remain unqualified. |
| [RC26-EFF-01](2026-11-16-improvement-plan.md#rc26-eff-01) | Centralize tool effect classification | 1 | P1 | verified | BASE-01 | Implementation agent | Shared classification, static annotation/catalog consistency and audited mixed-tool predicates passed focused source regressions and the completed exact-head review/CI gates. Deployed read/write qualification is recorded under EFF-02. Historical mixed calls are not reclassified from tool names alone. |
| [RC26-EFF-02](2026-11-16-improvement-plan.md#rc26-eff-02) | Separate failed observation from uncertain effect | 1 | P1 | verified | EFF-01 | Implementation agent | Actual MCP plus operation inspection confirmed the failed-read observation marker and preserved original error category/status/code, while the failed synthetic write remained unknown. Original response recovery remained available. Source SDK/restart/retention coverage preserves strict journal v1 compatibility; the custom long-kind limitation remains explicitly deferred under HIS-04. |
| [RC26-EFF-03](2026-11-16-improvement-plan.md#rc26-eff-03) | Reconcile historical classification without fabricating proof | 1 | P2 | verified | EFF-02 | Implementation agent | Read-only historical assessment completed with identical before/after file inventory and digests. Decision: no automatic rewrite; even pure-read candidates require deployed-version review, and mixed historical calls stay protected. Private counts/receipts retained. |
| [RC26-OBS-01](2026-11-16-improvement-plan.md#rc26-obs-01) | Inventory every agent entry point | 2 | P1 | verified | BASE-01 | Implementation agent | Known MCP HTTP/stdio, direct AgentClient, raw streaming, direct-transfer, proxy/relay and Android entry points are mapped in [ingress observations](../INGRESS-OBSERVABILITY.md) and the synchronized private route/runtime checkpoint. Three selected Linux HTTP windows corroborate only their tested routes. Unknown hops stay unassigned; loopback is not an original caller, Android stays outside HTTP counters and direct-transfer parent correlation remains unavailable. |
| [RC26-OBS-02](2026-11-16-improvement-plan.md#rc26-obs-02) | Propagate trace and origin without changing effect identity | 2 | P1 | verified | OBS-01 | Implementation agent | Strict versioned UUID correlation and authenticated agent receipts propagate across controller JSON/raw requests. Source SDK/direct/cancellation and wrong-binding regressions preserve bodies, durable keys and optional association. Three selected deployed 9/5 windows qualified, and the original task-linked job retained its durable identity through separate historical-association and terminal verification. Shared bearer possession does not identify a person; direct-transfer parent correlation and unobserved platforms remain outside scope. |
| [RC26-OBS-03](2026-11-16-improvement-plan.md#rc26-obs-03) | Count all ingress independently of sampled traces | 2 | P1 | verified | OBS-02, EFF-02 | Implementation agent | Agent hooks count admitted requests independently of sampled traces, including denied/direct traffic; source regressions retain bounded labels, stable event IDs, explicit faults and separate response/close outcomes. Three selected deployed windows qualified at nine agent arrivals/five controller dispatches, zero residual, expected routes, passing privacy checks and stable instances. Original reports and scope are preserved in the private checkpoint. This finite comparison is not a historical production census or client/effect proof. |
| [RC26-OBS-04](2026-11-16-improvement-plan.md#rc26-obs-04) | Reconcile agent totals with attributed and unattributed traffic | 2 | P1 | verified | OBS-03 | Implementation agent | Same-instance reconciliation verified for selected authenticated Linux HP root/owner and Server owner windows. Selected root had attributed and unmatched arrivals with exact denominator, zero residual and no missing detail. A separate Codex connector window closed complete. [Multi-agent HTTP fixtures](2026-11-18-obs04-multipeer-evidence.md) also cover wrong peer, rejected ingress and direct client detail. Wider fleet and ChatGPT tool exposure are tracked in DEL-02 and MCP-05. Unmatched counts establish no origin beyond the observed classification. |
| [RC26-OBS-05](2026-11-16-improvement-plan.md#rc26-obs-05) | Measure latency stages and map optional OTel conventions | 2 | P2 | verified | OBS-03 | Batch A implementation | PR70 stage diagnostics and PR71 authenticated native readback report stage observations and missingness, including unobserved queue, remote serialization and client receipt. [Pinned OpenTelemetry mapping](../RC26-OPERATOR-DIAGNOSTICS.md#4-bounded-timing-obs-05) records the optional exporter decision. Cross-service export deferred until a concrete need. Component pressure timings are recorded with HIS-04 and establish no production overhead reduction. |
| [RC26-OBS-06](2026-11-16-improvement-plan.md#rc26-obs-06) | Correlate diagnostics with existing ContextKeep tasks and runs | 2 | P2 | verified | OBS-02 | Implementation agent | The original necessary job's association was verified directly from preserved operation/dispatch/receipt/agent-event metadata captured before later sample eviction. Exact original job/project/task/run bindings and source wrong-binding regressions passed; the same job's terminal result and bound ContextKeep verification were read back separately. This is scoped historical association proof. Both live collector reports remain inconclusive; no full-page validation, global/current uniqueness, client acceptance or lease authority is inferred. Shared-ring capture/retention remains an OBS-04 follow-up; no replacement job was started. |
| [RC26-HIS-01](2026-11-16-improvement-plan.md#rc26-his-01) | Persist 60–90 days of daily aggregates independently of recovery | 2 | P2 | implemented | BASE-02, EFF-02, OBS-03 | Implementation agent | Independent bounded UTC daily ingress aggregates retain 60–90 days with restart, rollover, duplicate, corrupt-state and late-event handling. Execution/effect/client-acceptance and daily-route dimensions remain unsupported. Bounded shutdown, partial-claim cleanup and unknown continuity have source coverage. Three selected Linux identities qualified in bounded live probes with lastSavedSequence +2, flushCount +1 and no failures or retries. Orphan claims still require inspection; safe automated recovery and full retained-history acceptance remain open. |
| [RC26-HIS-02](2026-11-16-improvement-plan.md#rc26-his-02) | Publish coverage-aware reports and denominators | 2 | P2 | active | HIS-01, OBS-04 | Implementation agent | Public usage_window denominators, missing details and coverage are qualified on selected live SDK and Codex connector windows. Historical gaps and current completeness remain separate. Remaining delivery: console presentation of current-window versus retained-UTC coverage, with complete, partial and legacy-gap fixtures. |
| [RC26-HIS-03](2026-11-16-improvement-plan.md#rc26-his-03) | Reconcile old job references with bounded read-only inspections | 2 | P2 | verified | EFF-03 | Implementation agent | The bounded retained-reference assessment is complete for its permitted cohort, with lost, missing and excluded evidence explicit. Its original evidence/hash and scope are retained in the synchronized private checkpoint. Missing terminal references are not counted as running jobs; no job restart, mass finalization or reservation deletion occurred. Reconciled finishedAt can be observation time; historical quiescence and independent effects remain unproved. |
| [RC26-HIS-04](2026-11-16-improvement-plan.md#rc26-his-04) | Bound aggregate and recovery pressure independently | 2 | P2 | verified | HIS-01, HIS-03 | Implementation agent | Isolated production-class fixture exercised 90,000 requests over 90 simulated UTC days, series/detail limits, explicit overflow, persistence after reconstruction and byte-identical preservation of an unrelated uncertain receipt. Re-execution of that receipt was refused. [Reproduction and configured versus code defaults](../INGRESS-OBSERVABILITY.md). Existing restart/corruption fault fixtures and a real isolated Fastify async close-hook stall test cover the full grace/drain and distinct failure signal. This qualifies bounded pressure behavior; continuous installed retention remains with HIS-01 and DEL-02. |
| [RC26-INV-01](2026-11-16-improvement-plan.md#rc26-inv-01) | Reconcile the canonical fleet inventory | 2 | P2 | active | BASE-01 | Implementation agent | The selected retired entry is manual in production. Canonical alias and historic references remain retained. Live fleet/console confirmed manual and no automatic dispatch; isolated tests verified explicit alias routing. Remaining: reconcile primary, backup and intermittent roles for the rest of private inventory against owner intent; unreachable endpoints do not establish power state. |
| [RC26-INV-02](2026-11-16-improvement-plan.md#rc26-inv-02) | Expose desired, installed, startup and running versions | 2 | P2 | active | DEP-01, INV-01 | Implementation agent | PR70 reports observed running SHA and explicitly sourced operator declarations. Private selected Linux audit compares loaded service launch target, installed manifest and PID command line independently. Automatic collection for each configured identity and managed desktop engine remains pending; unavailable endpoints stay unknown. |
| [RC26-INV-03](2026-11-16-improvement-plan.md#rc26-inv-03) | Use bounded probes and backoff for intermittent devices | 2 | P2 | implemented | INV-01 | Implementation agent | capability_report now uses finite per-endpoint probe budgets, propagates cancellation and stops queued probes. A stalled HTTP fixture with generic deadlines disabled and existing fleet/alias regressions pass. This does not claim a new backoff policy or measured fleet-wide reduction. |
| [RC26-INV-04](2026-11-16-improvement-plan.md#rc26-inv-04) | Separate canonical source workspaces from immutable releases | 2 | P2 | verified | BASE-01 | Implementation agent | The [workspace/release guide](../WORKSPACE-AND-RELEASES.md), published source/disposition and guarded selected releases are linked to a saved private source/release/startup/process map and ContextKeep checkpoint. This documentation update records that mapping and preserves older worktrees and immutable evidence; repository HEAD is not deployment identity. Review fixtures require isolated state, captured identities and finite child lifetimes. Automatic fleet drift presentation and enforced worker isolation remain separate INV-02/INV-05 work. |
| [RC26-INV-05](2026-11-16-improvement-plan.md#rc26-inv-05) | Isolate automated review probes from installed services | 3 | P1 | deferred | INV-04, GOV-02 | Implementation agent | [PR #61](https://github.com/anervalens-netizen/remote-control-mcp/pull/61) source launcher qualified through the actual non-root entrypoint on a selected review host. Profile guidance alone does not enforce routing. Reopen [issue #64](https://github.com/anervalens-netizen/remote-control-mcp/issues/64) when DSH review quota and an isolated owner-scoped native profile are available to prove non-bypassable routing. |
| [RC26-UX-01](2026-11-16-improvement-plan.md#rc26-ux-01) | Provide a bounded read-only doctor workflow | 3 | P2 | implemented | BASE-03, INV-02, EFF-02 | Implementation agent | PR #70 provides bounded doctor stages, including the Linux owner desktop route. Selected controller App/text parity and root/owner probes passed; Windows and Android host coverage remains open. |
| [RC26-UX-02](2026-11-16-improvement-plan.md#rc26-ux-02) | Guide tool and identity selection by intent | 3 | P2 | active | BASE-03 | Implementation agent | PR70 console guidance is live, with selected ChatGPT and Codex doctor acceptance. [Operator intent table](../RC26-OPERATOR-DIAGNOSTICS.md#3-job-status-guidance-with-existing-tools-ux-0506) records tool/identity selection. Remaining: comparative intent-selection workflow evidence beyond the selected doctor/read paths. |
| [RC26-UX-03](2026-11-16-improvement-plan.md#rc26-ux-03) | Keep default results compact with exact recovery | 3 | P2 | active | BASE-03 | Implementation agent | PR71 preserves compact typed checkpoint guidance without arbitrary agent text; fs_read mode and exact cursor/schema regressions pass in modern and legacy SDK paths. Remaining: equivalent before/after result sizes and exact recovery comparisons for the routine B01–B07 scenarios. |
| [RC26-UX-04](2026-11-16-improvement-plan.md#rc26-ux-04) | Batch independent reads using existing facilities | 3 | P2 | verified | BASE-03 | Implementation agent | A paired native Linux sample compared separate authenticated SDK reads with one bounded batch. Per-item identity, bytes and the missing-file error matched. The batch needed fewer MCP calls. Broader B01–B07 qualification remains open. |
| [RC26-UX-05](2026-11-16-improvement-plan.md#rc26-ux-05) | Select durable jobs and receipts according to the operation | 3 | P2 | active | REC-04, BASE-03 | Implementation agent | Published [operator workflow guidance](../RC26-OPERATOR-DIAGNOSTICS.md#3-job-status-guidance-with-existing-tools-ux-0506). Selected native long-job reconnect and isolated keyed recovery preserve the original effect. Remaining: representative short-effect delivery interruption across actual workflows and eligible-operation adoption measurement. |
| [RC26-UX-06](2026-11-16-improvement-plan.md#rc26-ux-06) | Expose actionable job progress without invented certainty | 3 | P2 | implemented | OBS-03, UX-05 | Implementation agent | PR #70 projects observed job metadata and actionable next checks without inferring effects or completion percent. A selected existing job was read successfully; broader waiting, interruption and client cases remain open. |
| [RC26-UX-07](2026-11-16-improvement-plan.md#rc26-ux-07) | Extend the existing MCP Apps console with the same contracts | 3 | P2 | implemented | UX-01, UX-06, HIS-02 | Implementation agent | PR #70 delivers console doctor/progress, the published App resource and text fallback. Selected controller parity and console identity passed; full host and interaction coverage remains open. |
| [RC26-GOV-01](2026-11-16-improvement-plan.md#rc26-gov-01) | Reconcile review evidence against the exact repository head | 3 | P2 | planned | BASE-01 | — | — |
| [RC26-GOV-02](2026-11-16-improvement-plan.md#rc26-gov-02) | Preserve complementary Codex and DSH review workflow | 3 | P2 | planned | BASE-01 | — | — |
| [RC26-GOV-03](2026-11-16-improvement-plan.md#rc26-gov-03) | Keep tracker state and private handoffs synchronized | 0 | P1 | verified | — | Implementation agent | The canonical IDs, public release/checkpoint and task-scoped proposed ContextKeep readback were synchronized. Prior run verification remains separately bound to the original execution. Deferred DSH and incomplete platform/operational evidence have explicit reopening conditions; historical uncertainty remains in REC-05 and DEL-01. |
| [RC26-MCP-01](2026-11-16-improvement-plan.md#rc26-mcp-01) | Build the actual client and protocol compatibility matrix | 3 | P2 | verified | BASE-01 | Implementation agent | Recorded and source-checked the [actual client/protocol matrix](../RELIABILITY.md#mcp-sdk-compatibility-matrix-r11). Live modern and initialized/reconnected legacy SDK coverage, selected ChatGPT and Codex host readbacks, isolated stdio/JSON/SSE checks and unknown host protocol fields are identified separately. Wider host and physical platform evidence is tracked by MCP-05. |
| [RC26-MCP-02](2026-11-16-improvement-plan.md#rc26-mcp-02) | Run relevant official protocol conformance cases | 3 | P2 | planned | MCP-01 | — | — |
| [RC26-MCP-03](2026-11-16-improvement-plan.md#rc26-mcp-03) | Verify modern discovery and catalog/result parity | 3 | P2 | verified | MCP-01 | Implementation agent | Modern discovery, malformed-envelope rejection and typed tool catalog parity pass in isolated HTTP tests. Authenticated modern and legacy reconnect read the same console asset and terminal job. The selected ChatGPT host recovered the app doctor through Refresh tools. Automatic invalidation and other host behavior remain unverified in MCP-05; no universal discovery capability is claimed. |
| [RC26-MCP-04](2026-11-16-improvement-plan.md#rc26-mcp-04) | Verify cancellation, reconnection and durable effect continuity | 3 | P1 | active | MCP-01, REC-04 | Implementation agent | Selected native wait expiry and SDK wait cancellation recovered the original still-running durable job; a separate explicit job cancellation produced terminal cancellation. [Isolated response-loss matrix](../MCP04-TRANSPORT-FAILURE-EVIDENCE.md) covers modern/legacy stateless and legacy initialized session replacement, including concurrent independent recovery reads and exactly one original start/effect. Remaining: actual installed lost-initial-response and wider stream-closure matrix. |
| [RC26-MCP-05](2026-11-16-improvement-plan.md#rc26-mcp-05) | Qualify the supported real hosts and document the limits | 3 | P2 | active | MCP-02, MCP-03, MCP-04 | Implementation agent | Selected Linux, modern/legacy SDK, ChatGPT and Codex host evidence is live. Both physical Android companions qualified metadata only. Windows endpoints unavailable; Android input/geometry, installed-host interruption and relevant official conformance (MCP-02) remain unqualified. |
| [RC26-TMO-01](2026-11-16-improvement-plan.md#rc26-tmo-01) | Align wait budgets across client, controller, agent and process | 3 | P2 | planned | BASE-03, REC-04 | — | — |
| [RC26-TMO-02](2026-11-16-improvement-plan.md#rc26-tmo-02) | Qualify heartbeat and bounded UI collection | 3 | P2 | active | DEP-04, UX-01 | Implementation agent | Two physical Android companions resumed fresh polling and returned bounded metadata-only observations. Remaining: isolated slow-UI fixture with concurrent heartbeat/status; Windows native desktop needs an available qualified interactive session. |
| [RC26-EXP-01](2026-11-16-improvement-plan.md#rc26-exp-01) | Probe real client support for the Tasks extension | 4 | P3 | planned | MCP-01 | — | — |
| [RC26-EXP-02](2026-11-16-improvement-plan.md#rc26-exp-02) | Pilot Tasks as an adapter over existing durable jobs | 4 | P3 | conditional | EXP-01, BASE-03 | — | — |
| [RC26-EXP-03](2026-11-16-improvement-plan.md#rc26-exp-03) | Compare Android observation geometry on a finite test matrix | 4 | P3 | conditional | BASE-03 | — | — |
| [RC26-EXP-04](2026-11-16-improvement-plan.md#rc26-exp-04) | Compare Windows desktop diagnostics on the same machine | 4 | P3 | conditional | BASE-03, TMO-02 | — | — |
| [RC26-EXP-05](2026-11-16-improvement-plan.md#rc26-exp-05) | Compare Playwright CLI plus skills with the existing browser route | 4 | P3 | conditional | BASE-03 | — | — |
| [RC26-PERF-01](2026-11-16-improvement-plan.md#rc26-perf-01) | Profile observer and reconciliation cost before optimization | 4 | P3 | planned | OBS-05, HIS-04 | — | — |
| [RC26-PERF-02](2026-11-16-improvement-plan.md#rc26-perf-02) | Optimize only the measured limiting path | 4 | P3 | conditional | PERF-01 | — |— Source inspection and an actual-client synthetic regression show one capability-info request before each UTF-8 file page. Measure end-to-end cost before considering a cache bound to endpoint/runtime instance; invalidate it on instance or capability uncertainty. No cache or production speedup is claimed. |
| [RC26-PERF-03](2026-11-16-improvement-plan.md#rc26-perf-03) | Set measured regression budgets | 4 | P3 | planned | PERF-01, BASE-03 | — | — |
| [RC26-DOC-01](2026-11-16-improvement-plan.md#rc26-doc-01) | Reconcile version claims and operational documentation | 3 | P2 | verified | BASE-01, MCP-01, INV-02 | Batch A implementation | Cross-checked the [SDK/host compatibility matrix](../RELIABILITY.md#mcp-sdk-compatibility-matrix-r11) against pinned package/transport versions and selected live results. Corrected the stale legacy SDK claim and linked archive identity, managed desktop and recovery contracts. Loaded and running target evidence remains explicitly independent from source documentation and automatic inventory work in INV-02. |
| [RC26-DEL-01](2026-11-16-improvement-plan.md#rc26-del-01) | Close the recovery and desktop lot with behavior evidence | 1 | P1 | blocked | REC-05, DEP-05, EFF-03 | Implementation agent | Supported new-operation recovery and failed-read semantics passed actual MCP qualification; actual desktop behavior was qualified before and after a controlled owner relaunch. Historical REC-05 quiescence remains unresolved, so this lot remains blocked. The merged PR, deployed behavior and completed desktop acceptance do not establish the effect of the historical operation or authorize retiring its writer. |
| [RC26-DEL-02](2026-11-16-improvement-plan.md#rc26-del-02) | Close the telemetry, history and inventory lot | 2 | P2 | active | OBS-04, OBS-05, OBS-06, HIS-04, INV-02, INV-03, INV-04 | Implementation agent | Selected Linux accounting and stage timing, private scoped release/rollback, original ContextKeep integration and isolated storage/recovery pressure are verified. Remaining gates: broader entry-point and long deployed history coverage, console coverage presentation, full native version inventory and mixed availability/version validation. DSH review is separately deferred; prior historical fences remain untouched. |
| [RC26-DEL-03](2026-11-16-improvement-plan.md#rc26-del-03) | Close usability and compatibility with real workflows | 3 | P2 | planned | UX-02, UX-03, UX-04, UX-07, GOV-01, GOV-02, MCP-05, TMO-01, TMO-02, DOC-01 | — | — |
| [RC26-DEL-04](2026-11-16-improvement-plan.md#rc26-del-04) | Record a decision for every experiment and the remaining backlog | 4 | P3 | planned | EXP-01, EXP-02, EXP-03, EXP-04, EXP-05, PERF-02, PERF-03 | — | — |

## PR #54 review dispositions

The first candidate `9bb0b56e410962238278992ab8e71002dc5f1f6d` received the [initial DSH review](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#issuecomment-6921805100). Follow-up `5c59a8d2174780d9ee00fcaa4f139c9db47b003f` received [Codex review](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#pullrequestreview-5923733716), which identified the shared-access and production-output-contract cases below. The [follow-up DSH review](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#issuecomment-6923184857) corroborated both Codex findings and added the pre-dispatch label and two diagnostic/terminology observations below. The [third DSH review](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#issuecomment-6923799775) on `7504ac4ad17bcf483152382748cc813c13106e35` confirmed those corrections and added the boundary, reserved-binding and test/environment notes below. The [fourth DSH review](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#issuecomment-6924341173) on `71956e868c96fca01506b46f3dbf06911d2b6383` added the lexical-path, parent-recreation and null-view wording findings. The [current published disposition](https://github.com/anervalens-netizen/remote-control-mcp/pull/54#issuecomment-6926185868) was read back across all 21 review entries: 12 fixed, 7 deferred and 2 dismissed. DSH4-N2 is fixed by documentation commit `b6d1fa2`; the other 20 dispositions are unchanged. The table binds every finding to existing work items. Decisions below are development-agent dispositions, not statements of owner risk acceptance. Both required application review paths completed on `71956e868c96fca01506b46f3dbf06911d2b6383`; Codex reported no findings and the DSH findings have the 21 recorded dispositions. [Merge `9682af5`](https://github.com/anervalens-netizen/remote-control-mcp/commit/9682af5bd2e6e4ae658dfdbcd55532f9ba5cdd32) preserves the reviewed tree and has four passing merge checks. [Documentation commit `b6d1fa2`](https://github.com/anervalens-netizen/remote-control-mcp/commit/b6d1fa234f2cd328eb7720dc915c260edb4739b6) records that clarification and has three passing documentation checks: `check`, `windows-native` and `public-source`. The installed application source remains `9682af5`. All other deferred items retain their scope and reopening condition.

| Review item | RC26 coverage | Disposition | Evidence or reopening condition |
|---|---|---|---|
| PR54-01: lost receipt after archive publication | REC-03, REC-04 | Fixed and reviewed at `71956e8` | Preserve the admitted job/token/execution binding even when released-journal publication or subsequent metadata reads fail. Preserve a successful Git outcome independently of an HTTP409/500. Native failure injection covers before/after journal publication and slot-read failure, with and without fallback metadata reads; actual SDK cases retain both conflict and recovery metadata. |
| PR54-02: repeated disposition with a later base | REC-03, REC-04 | Fixed and reviewed at `71956e8` | Published receipts tolerate a later caller base. An unpublished archive still requires the original immutable evidence, current-base CAS and slot ownership before release. |
| PR54-03: release claims and verification verdicts | DEP-01 | Fixed and reviewed at `71956e8` | Preserve independent file-integrity/pin facts, add an aggregate verdict, label source declarations and require a matching pin before using a manifest-derived runtime SHA. |
| PR54-04: oversized custom failure category | EFF-02, HIS-04 | Conservative v1 fallback retained; generalization deferred | Built-in transport categories fit the marker. Custom 43–64 character kinds on mixed reads cannot preserve both full category and durable read proof in the existing field; those records remain protected. Reopen with a rollback-compatible schema/retention design, without truncating evidence. |
| PR54-05: reconciliation-capacity admission | REC-03, HIS-04 | Retained by design | A new execution needs capacity for its eventual immutable resolution. Refusing before job dispatch prevents creating an operation with no archive capacity. A regression asserts zero job starts when that store is full. |
| PR54-06: inconsistent recovery inspection | REC-03, REC-04 | Fixed and reviewed at `71956e8` | Build the inspection and recovery metadata from one journal-record snapshot; do not mix generations through a second independent read. |
| PR54-CX01 / DSHv2-02: shared recovery-directory access | REC-03, REC-04 | Fixed and native-tested; review complete at `71956e8` | Honor configured group sharing for newly created recovery directories and request/result files, including restrictive umasks. Preserve existing ownership, permissions and inherited setgid. Keep private defaults; qualify inspection and a subsequent write with distinct Unix identities. |
| PR54-CX02 / DSHv2-01: desktop identity rejected by production output contract | DEP-03, DEP-04, MCP-03 | Fixed and SDK-tested; review complete at `71956e8` | Declare a strict engineIdentity output schema using the manifest field types and explicit saved-provenance limits. Full production registration plus actual SDK discovery/calls verify successful and failed status payloads; malformed diagnostics remain rejected. |
| PR54-DSH2-03: pre-dispatch failure labelled as requiring recovery | REC-03, UX-05 | Fixed and tested; review complete at `71956e8` | Use trusted pre-dispatch evidence to report an operation that never started. Keep the released fence without inventing a job, operation result or publication result. A failure before binding has no execution binding; a binding published before a later pre-dispatch failure remains audit evidence. Retain post-dispatch recovery receipts. |
| PR54-DSH2-N1: SHA source versus manifest binding | DEP-01, DOC-01 | Retained by design; terminology clarified | shaSource records the origin of the value. shaBinding records its association with a matching pinned manifest, even when an explicit environment/configured SHA supplied the same value. This does not assert upstream provenance. |
| PR54-DSH2-N2: pending archive metadata is not discoverable in inspection | REC-04, UX-05, MCP-04 | Bounded diagnostic view deferred | inspect_recovery exposes the journal view while release publication is pending; the archived base may be unavailable to a client that lost its receipt. A changed live base keeps release blocked. Knowing the old base does not bypass current-base CAS. Reopen with lost-receipt/pending-archive diagnostics and regression coverage that preserves current = expected = archived base before publication. |
| PR54-DSH3-01: shared permissions escape the coordination root | REC-03, REC-04 | Fixed and native-tested; review complete at `71956e8` | Limit shared creation to the configured lexical root and its descendants. Missing external ancestors retain private access bits, while existing directories and inherited setgid/group remain unchanged. Cover nested worker directories and both restrictive umasks. Physical containment through symlinked parents remains the separate DSH4-01 follow-up. |
| PR54-DSH3-02: a pre-dispatch failure can retain an execution binding | REC-03, REC-04, HIS-04 | Clarified and regression-tested; reviewed at `71956e8` | A reserved execution identity is distinct from admitted work. Preserve the immutable binding after a proved failure before dispatch; report not_started/released with no job ID and no invented result. Verify the post-binding request-write failure and a subsequent generation. The binding remains within the documented 4096-entry retention limit; reclamation stays in HIS-04. |
| PR54-DSH3-N1: full-registration SDK test budget | DEP-04, MCP-03 | Explicit budget qualified; reviewed at `71956e8` | Give the production-registration SDK cases an explicit 15-second budget, matching their HTTP/SDK lifecycle and the bounded integrated gate. Keep runtime timeouts unchanged. |
| PR54-DSH3-N2: worker receipt mode comes from its environment | INV-02, HIS-04 | Diagnostic extension deferred | Every shipped durable launch propagates the configured mode, as confirmed by the reviewer. A separately scrubbed worker environment falls back to private 0600. Retain the existing launch contract; reopen with desired-versus-effective worker configuration diagnostics and a deliberately altered-environment regression before supporting that external launch path. |
| PR54-DSH4-01: sharing-root containment is lexical | REC-04, HIS-04, MCP-04 | Hardening deferred | A trusted participant with write access inside the shared root can redirect a nested path through a symlink, so a shared-mode directory may be created outside the physical root. This pre-existing limit does not reopen the ordinary missing-ancestor fix. Reopen with symlink-aware traversal/containment and synthetic parent-retarget coverage that preserves existing ownership, setgid and private defaults. |
| PR54-DSH4-N1: atomic writer recreates a missing receipt parent | HIS-04, REC-04, MCP-04 | Hardening deferred | Normal flows pre-create configured parents. External deletion before the atomic write can trigger generic recursive recreation with the umask default instead of the configured directory mode. Reopen with a synthetic deletion/publication fault and explicit parent-creation policy, while preserving original evidence and no-replay fencing. |
| PR54-DSH4-N2: null-binding wording implies unavailable proof | REC-03, REC-04 | Fixed by documentation commit `b6d1fa2` | A null binding means only that no binding is available in the returned record view. It proves neither absence of artifact publication nor absence of admission and never authorizes replay. `not_started` requires invocation-bound pre-dispatch proof. Commit `b6d1fa2` corrects the contract wording and is recorded in the current published disposition; the application source and runtime behavior are unchanged. |
| PR54-PRE01a: lost correlation in publication fallback | UX-03, OBS-02, MCP-03 | Scoped metadata fix tested and reviewed at `71956e8` | Preserve trace, coverage and original-result recovery in validation/delivery failures. This partial correction does not complete the broader ergonomics or telemetry items. |
| PR54-PRE01b: observation finish precedes publication | OBS-02, OBS-03 | Existing semantic limitation deferred | Journal outcome/counters are finalized before final publication. They do not prove successful client delivery. Change finish/disconnect/persistence/counter behavior together and verify exactly one accounting transition; do not add a second contradictory finish. |
| PR54-PRE02: weaker automatic legacy settlement | REC-05, MCP-04 | Existing path retained pending qualified legacy coverage | Execution-bound writers bypass that path. The historical incident still requires the supported evidence-bound flow; legacy terminal metadata alone must not be used as new quiescence proof. Review the remaining legacy auto-settler against its actual backends before changing compatibility behavior. |

The reviewer also reported local default-budget timeouts, with the relevant isolated files passing. The follow-up broad run omitted the console build and reported an unrelated filesystem timestamp-granularity assertion; its scoped 132 cases passed. The frozen-source integrated gate builds the console before testing and retains its own complete result. The third review's local gate reported a parallel console timeout that passed in isolation and a pre-existing umask-dependent assertion outside this change; its scoped files passed. The candidate's bounded Linux gate and hosted CI are separate evidence; unavailable native platforms remain unqualified. The canonical review marker and checked Git refs determine the base SHA, not a transcription typo in a command appendix.

The original DSHv4 report misstated the `7504ac4` comparison. Its record correction, published on 2026-11-16 at 18:00:06 UTC, confirms that the retained-binding regression passed on both `7504ac4` and `71956e8`; only the two directory-boundary regressions failed against `7504ac4`. Findings, severities and verdict are unchanged. The post-binding case pins unchanged behavior and documentation, not a new runtime fix. See the [recovery regression](../../tests/coordination-recovery.test.ts) and [directory regressions](../../tests/coordination-sharing.test.ts). Review/test evidence remains separate from runtime promotion and incident acceptance.

## Next acceptance batches

1. RC26-REC-07 retains read-only commit diagnostics and keeps uncertain writers
   fenced. Require independent effect and quiescence proof before adding a
   reconciliation disposition.
2. Qualify traffic attribution and latency together with bounded history
   (OBS-04/05 and HIS-01/02/04). Compare independent ingress totals with attributed
   and unattributed calls under the same volume and retention conditions. Record
   missing stages and incomplete windows explicitly.
3. Qualify compatibility on the available clients (MCP-01–05 and TMO-01/02).
   Keep synthetic transport tests and runtime client evidence distinct, and
   retain explicit availability limits.

## Lot gates

- [ ] **Lot 0:** BASE-01–03 have a current baseline and comparable scenarios; GOV-03 establishes the ongoing evidence/checkpoint practice.
- [ ] **Lot 1 / DEL-01:** supported recovery without replay, protected active writers, verified managed desktop integration after relaunch, and correct read/effect classification.
- [ ] **Lot 2 / DEL-02:** ingress accounting, independent history with coverage, bounded recovery reconciliation, and current inventory/startup identities.
- [ ] **Lot 3 / DEL-03:** measured workflow benefit, actual-client protocol/recovery checks, clear console/doctor behavior, and exact-head review/task reconciliation.
- [ ] **Lot 4 / DEL-04:** every experiment and potential optimization has an explicit evidence-backed adoption, deferral or non-adoption decision.

Lot gates summarize the work-item rows; they do not replace their acceptance criteria. Do not check a gate merely because a PR merged. Native and unavailable-client limitations remain explicit.

## Completeness check

- [ ] F01 recovery → REC-01–05, UX-05, MCP-04, TMO-01.
- [ ] F02 release/desktop → DEP-01–05, INV-02.
- [ ] F03 observation → OBS-01–06, HIS-01–02.
- [ ] F04 effect model → EFF-01–03.
- [ ] F05 historical evidence → HIS-01–04, PERF-01–03.
- [ ] F06 inventory/startup/source → INV-01–04, DEP-05, DOC-01.
- [ ] F07 ergonomics → UX-01–07, BASE-03, TMO-01–02, MCP-01–05.
- [ ] F08 review/task evidence → GOV-01–03, DOC-01.
- [ ] E01 Desktop Commander comparison → TMO-01, UX-05–06, REC-01–04.
- [ ] E02 Agent Desktop integration → DEP-02–05, INV-02.
- [ ] E03 Windows diagnostics/comparison → UX-01/06, TMO-02, EXP-04.
- [ ] E04 doctor pattern → UX-01, INV-03.
- [ ] E05 modern/legacy MCP → MCP-01–05.
- [ ] E06 Tasks support/pilot → EXP-01–02.
- [ ] E07 trace/metric conventions → OBS-01–06, HIS-01–04.
- [ ] E08 Android geometry comparison → EXP-03.
- [ ] E09 existing Apps console → UX-07, MCP-05.
- [ ] E10 browser CLI comparison → EXP-05.
- [ ] M01 evidence and provenance → BASE-01, GOV-03.
- [ ] M02 comparable windows and denominators → BASE-02, OBS-04, HIS-02.
- [ ] M03 truthful outcome and latency interpretation → BASE-02, EFF-02, HIS-02, TMO-01.
- [ ] M04 origin and identity limits → OBS-01–04.
- [ ] M05 profiling before optimization → HIS-04, PERF-01–03.
- [ ] M06 meaningful failure and native scenarios → BASE-03, REC-04, DEP-04–05, EFF-02–03, HIS-03, MCP-04.
- [ ] M07 unavailable platforms and compatible versions → BASE-01, INV-02–03, MCP-05, EXP-03–04.
- [ ] M08 source/state/local-work preservation → BASE-01, REC-05, DEP-05, INV-04.
- [ ] M09 exact-release behavior and rollback evidence → DEP-05, MCP-05, PERF-03, DEL-01–03.
- [ ] M10 dispositions and resumable handoff → GOV-03, DEL-01–04.

These boxes mean that implementation or a justified final disposition is complete. The mapping itself is already present; boxes remain unchecked until the corresponding work is closed.

## Per-item evidence note template

Use a compact note when a row changes state. Public notes must contain only generic code behavior and synthetic results.

```text
Work item: RC26-...
Disposition and scope:
Owner:
Source commit / PR:
Verified behavior and checks:
Private operational evidence: retained in the matching task, when applicable
Still unverified / blocker:
Decision rationale or superseding item:
Next action / condition to resume:
```

Do not add private identifiers or deployment inventories to this template in Git. A delivered observation, terminal process receipt, accepted review and independently verified effect remain different evidence types.
