# Reliability and usability implementation tracker

Scope version: 2026-11-16. [Full plan, acceptance criteria and sources](2026-11-16-improvement-plan.md).

This is the single implementation checklist for the improvement plan. It covers **60 work items**, all **F01–F08 findings**, all **E01–E10 ecosystem comparisons**, and **M01–M10 methodology/preservation requirements**. Initial state: **55 planned, 5 conditional, 0 implemented or verified by this planning change**. The state of an existing capability must be refreshed before implementing its proposed extension or verification.

The public tracker records engineering status and sanitized evidence only. Operational measurements, real device details, private task/execution IDs and deployment/rollback receipts stay in private project memory under the same stable work-item ID. Do not copy the operational audit into this repository.

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
| [RC26-BASE-01](2026-11-16-improvement-plan.md#rc26-base-01) | Refresh the baseline and bind the evidence | 0 | P1 | planned | — | — | — |
| [RC26-BASE-02](2026-11-16-improvement-plan.md#rc26-base-02) | Define comparable usage and outcome measurements | 0 | P1 | planned | BASE-01 | — | — |
| [RC26-BASE-03](2026-11-16-improvement-plan.md#rc26-base-03) | Create a small repeatable behavior and ergonomics benchmark | 0 | P2 | planned | BASE-02 | — | — |
| [RC26-REC-01](2026-11-16-improvement-plan.md#rc26-rec-01) | Reproduce partial synchronous repository failure | 1 | P1 | planned | BASE-01 | — | — |
| [RC26-REC-02](2026-11-16-improvement-plan.md#rc26-rec-02) | Specify evidence-bound synchronous reconciliation | 1 | P1 | planned | REC-01 | — | — |
| [RC26-REC-03](2026-11-16-improvement-plan.md#rc26-rec-03) | Implement supported reconciliation for synchronous operations | 1 | P1 | planned | REC-02 | — | — |
| [RC26-REC-04](2026-11-16-improvement-plan.md#rc26-rec-04) | Qualify recovery under concurrency and interrupted delivery | 1 | P1 | planned | REC-03 | — | — |
| [RC26-REC-05](2026-11-16-improvement-plan.md#rc26-rec-05) | Resolve the existing incident through the qualified path | 1 | P1 | planned | REC-04 | — | — |
| [RC26-DEP-01](2026-11-16-improvement-plan.md#rc26-dep-01) | Report verifiable archive release identity | 1 | P1 | planned | BASE-01 | — | — |
| [RC26-DEP-02](2026-11-16-improvement-plan.md#rc26-dep-02) | Complete the owner route and graphical-session integration | 1 | P1 | planned | BASE-01 | — | — |
| [RC26-DEP-03](2026-11-16-improvement-plan.md#rc26-dep-03) | Bind the adapter to the managed desktop engine | 1 | P1 | planned | DEP-02 | — | — |
| [RC26-DEP-04](2026-11-16-improvement-plan.md#rc26-dep-04) | Verify desktop behavior through the actual MCP route | 1 | P1 | planned | DEP-01, DEP-03 | — | — |
| [RC26-DEP-05](2026-11-16-improvement-plan.md#rc26-dep-05) | Verify startup persistence and a reversible rollout | 1 | P1 | planned | DEP-04 | — | — |
| [RC26-EFF-01](2026-11-16-improvement-plan.md#rc26-eff-01) | Centralize tool effect classification | 1 | P1 | planned | BASE-01 | — | — |
| [RC26-EFF-02](2026-11-16-improvement-plan.md#rc26-eff-02) | Separate failed observation from uncertain effect | 1 | P1 | planned | EFF-01 | — | — |
| [RC26-EFF-03](2026-11-16-improvement-plan.md#rc26-eff-03) | Reconcile historical classification without fabricating proof | 1 | P2 | planned | EFF-02 | — | — |
| [RC26-OBS-01](2026-11-16-improvement-plan.md#rc26-obs-01) | Inventory every agent entry point | 2 | P1 | planned | BASE-01 | — | — |
| [RC26-OBS-02](2026-11-16-improvement-plan.md#rc26-obs-02) | Propagate trace and origin without changing effect identity | 2 | P1 | planned | OBS-01 | — | — |
| [RC26-OBS-03](2026-11-16-improvement-plan.md#rc26-obs-03) | Count all ingress independently of sampled traces | 2 | P1 | planned | OBS-02, EFF-02 | — | — |
| [RC26-OBS-04](2026-11-16-improvement-plan.md#rc26-obs-04) | Reconcile agent totals with attributed and unattributed traffic | 2 | P1 | planned | OBS-03 | — | — |
| [RC26-OBS-05](2026-11-16-improvement-plan.md#rc26-obs-05) | Measure latency stages and map optional OTel conventions | 2 | P2 | planned | OBS-03 | — | — |
| [RC26-OBS-06](2026-11-16-improvement-plan.md#rc26-obs-06) | Correlate diagnostics with existing ContextKeep tasks and runs | 2 | P2 | planned | OBS-02 | — | — |
| [RC26-HIS-01](2026-11-16-improvement-plan.md#rc26-his-01) | Persist 60–90 days of daily aggregates independently of recovery | 2 | P2 | planned | BASE-02, EFF-02, OBS-03 | — | — |
| [RC26-HIS-02](2026-11-16-improvement-plan.md#rc26-his-02) | Publish coverage-aware reports and denominators | 2 | P2 | planned | HIS-01, OBS-04 | — | — |
| [RC26-HIS-03](2026-11-16-improvement-plan.md#rc26-his-03) | Reconcile old job references with bounded read-only inspections | 2 | P2 | planned | EFF-03 | — | — |
| [RC26-HIS-04](2026-11-16-improvement-plan.md#rc26-his-04) | Bound aggregate and recovery pressure independently | 2 | P2 | planned | HIS-01, HIS-03 | — | — |
| [RC26-INV-01](2026-11-16-improvement-plan.md#rc26-inv-01) | Reconcile the canonical fleet inventory | 2 | P2 | planned | BASE-01 | — | — |
| [RC26-INV-02](2026-11-16-improvement-plan.md#rc26-inv-02) | Expose desired, installed, startup and running versions | 2 | P2 | planned | DEP-01, INV-01 | — | — |
| [RC26-INV-03](2026-11-16-improvement-plan.md#rc26-inv-03) | Use bounded probes and backoff for intermittent devices | 2 | P2 | planned | INV-01 | — | — |
| [RC26-INV-04](2026-11-16-improvement-plan.md#rc26-inv-04) | Separate canonical source workspaces from immutable releases | 2 | P2 | planned | BASE-01 | — | — |
| [RC26-UX-01](2026-11-16-improvement-plan.md#rc26-ux-01) | Provide a bounded read-only doctor workflow | 3 | P2 | planned | BASE-03, INV-02, EFF-02 | — | — |
| [RC26-UX-02](2026-11-16-improvement-plan.md#rc26-ux-02) | Guide tool and identity selection by intent | 3 | P2 | planned | BASE-03 | — | — |
| [RC26-UX-03](2026-11-16-improvement-plan.md#rc26-ux-03) | Keep default results compact with exact recovery | 3 | P2 | planned | BASE-03 | — | — |
| [RC26-UX-04](2026-11-16-improvement-plan.md#rc26-ux-04) | Batch independent reads using existing facilities | 3 | P2 | planned | BASE-03 | — | — |
| [RC26-UX-05](2026-11-16-improvement-plan.md#rc26-ux-05) | Select durable jobs and receipts according to the operation | 3 | P2 | planned | REC-04, BASE-03 | — | — |
| [RC26-UX-06](2026-11-16-improvement-plan.md#rc26-ux-06) | Expose actionable job progress without invented certainty | 3 | P2 | planned | OBS-03, UX-05 | — | — |
| [RC26-UX-07](2026-11-16-improvement-plan.md#rc26-ux-07) | Extend the existing MCP Apps console with the same contracts | 3 | P2 | planned | UX-01, UX-06, HIS-02 | — | — |
| [RC26-GOV-01](2026-11-16-improvement-plan.md#rc26-gov-01) | Reconcile review evidence against the exact repository head | 3 | P2 | planned | BASE-01 | — | — |
| [RC26-GOV-02](2026-11-16-improvement-plan.md#rc26-gov-02) | Preserve complementary Codex and DSH review workflow | 3 | P2 | planned | BASE-01 | — | — |
| [RC26-GOV-03](2026-11-16-improvement-plan.md#rc26-gov-03) | Keep tracker state and private handoffs synchronized | 0 | P1 | planned | — | — | — |
| [RC26-MCP-01](2026-11-16-improvement-plan.md#rc26-mcp-01) | Build the actual client and protocol compatibility matrix | 3 | P2 | planned | BASE-01 | — | — |
| [RC26-MCP-02](2026-11-16-improvement-plan.md#rc26-mcp-02) | Run relevant official protocol conformance cases | 3 | P2 | planned | MCP-01 | — | — |
| [RC26-MCP-03](2026-11-16-improvement-plan.md#rc26-mcp-03) | Verify modern discovery and catalog/result parity | 3 | P2 | planned | MCP-01 | — | — |
| [RC26-MCP-04](2026-11-16-improvement-plan.md#rc26-mcp-04) | Verify cancellation, reconnection and durable effect continuity | 3 | P1 | planned | MCP-01, REC-04 | — | — |
| [RC26-MCP-05](2026-11-16-improvement-plan.md#rc26-mcp-05) | Qualify the supported real hosts and document the limits | 3 | P2 | planned | MCP-02, MCP-03, MCP-04 | — | — |
| [RC26-TMO-01](2026-11-16-improvement-plan.md#rc26-tmo-01) | Align wait budgets across client, controller, agent and process | 3 | P2 | planned | BASE-03, REC-04 | — | — |
| [RC26-TMO-02](2026-11-16-improvement-plan.md#rc26-tmo-02) | Qualify heartbeat and bounded UI collection | 3 | P2 | planned | DEP-04, UX-01 | — | — |
| [RC26-EXP-01](2026-11-16-improvement-plan.md#rc26-exp-01) | Probe real client support for the Tasks extension | 4 | P3 | planned | MCP-01 | — | — |
| [RC26-EXP-02](2026-11-16-improvement-plan.md#rc26-exp-02) | Pilot Tasks as an adapter over existing durable jobs | 4 | P3 | conditional | EXP-01, BASE-03 | — | — |
| [RC26-EXP-03](2026-11-16-improvement-plan.md#rc26-exp-03) | Compare Android observation geometry on a finite test matrix | 4 | P3 | conditional | BASE-03 | — | — |
| [RC26-EXP-04](2026-11-16-improvement-plan.md#rc26-exp-04) | Compare Windows desktop diagnostics on the same machine | 4 | P3 | conditional | BASE-03, TMO-02 | — | — |
| [RC26-EXP-05](2026-11-16-improvement-plan.md#rc26-exp-05) | Compare Playwright CLI plus skills with the existing browser route | 4 | P3 | conditional | BASE-03 | — | — |
| [RC26-PERF-01](2026-11-16-improvement-plan.md#rc26-perf-01) | Profile observer and reconciliation cost before optimization | 4 | P3 | planned | OBS-05, HIS-04 | — | — |
| [RC26-PERF-02](2026-11-16-improvement-plan.md#rc26-perf-02) | Optimize only the measured limiting path | 4 | P3 | conditional | PERF-01 | — | — |
| [RC26-PERF-03](2026-11-16-improvement-plan.md#rc26-perf-03) | Set measured regression budgets | 4 | P3 | planned | PERF-01, BASE-03 | — | — |
| [RC26-DOC-01](2026-11-16-improvement-plan.md#rc26-doc-01) | Reconcile version claims and operational documentation | 3 | P2 | planned | BASE-01, MCP-01, INV-02 | — | — |
| [RC26-DEL-01](2026-11-16-improvement-plan.md#rc26-del-01) | Close the recovery and desktop lot with behavior evidence | 1 | P1 | planned | REC-05, DEP-05, EFF-03 | — | — |
| [RC26-DEL-02](2026-11-16-improvement-plan.md#rc26-del-02) | Close the telemetry, history and inventory lot | 2 | P2 | planned | OBS-04, OBS-05, OBS-06, HIS-04, INV-02, INV-03, INV-04 | — | — |
| [RC26-DEL-03](2026-11-16-improvement-plan.md#rc26-del-03) | Close usability and compatibility with real workflows | 3 | P2 | planned | UX-02, UX-03, UX-04, UX-07, GOV-01, GOV-02, MCP-05, TMO-01, TMO-02, DOC-01 | — | — |
| [RC26-DEL-04](2026-11-16-improvement-plan.md#rc26-del-04) | Record a decision for every experiment and the remaining backlog | 4 | P3 | planned | EXP-01, EXP-02, EXP-03, EXP-04, EXP-05, PERF-02, PERF-03 | — | — |

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
