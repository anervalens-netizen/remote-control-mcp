# RC26 consolidated delivery

**The canonical 61-item tracker is an acceptance checklist, not a 61-PR delivery plan.** Maintain all IDs and preserve acceptance evidence.

## Release batches

| Batch | Items | Delivery |
|---|---:|---|
| A — Runtime and diagnostics | 23 | One integration PR: fleet/version diagnostics, read-only doctor, telemetry/history completeness, effect recovery and MCP/timeout qualification. One Codex + DSH review cycle at stable head, then CI and scoped native acceptance. |
| B — Experience and governance | 6 | Console and workflow changes share the integration PR with Batch A. Retain separate acceptance evidence for UI, guidance, benchmarks, review and documentation. |
| C — DSH isolation | 1 | One separate upstream-compatible security change in DSH with enforced process isolation and native proof. Do not overwrite existing dirty DSH checkout. |
| D — Experiments and performance | 9 | One finite comparison and adoption/defer report. Implement conditional experiments only when measured benefit/client capability is proven. |
| Historical incident evidence | 2 | REC-05 and DEL-01 remain evidence-gated; do not force-release, replay or reboot the existing uncertain slots. |

20 verified items stay verified. The 41 outstanding items map exactly once below.

## Validation cadence

1. Develop related code and tests in one clean branch per batch; no review per individual tracker row.
2. Run focused tests while coding, then one final full type/privacy/behavior suite and one exact-head Codex + DSH review cycle per stable application batch (as required by AGENTS.md). Handle findings in one combined correction pass; final-head review only after the batch is stable. Reviewer quota deferral is never approval.
3. Require Linux/Windows/public-source CI on the stable head, one identity-checked merge, one scoped deployment and read-only runtime verification/rollback evidence. A clean Git commit alone never proves production behavior.
4. Sync all original tracker IDs and ContextKeep at batch checkpoints, not after every intermediate command.
5. Separate non-bypassable DSH worker isolation and historical uncertain-effect reconciliation from routine application release work.

## Exact open-item crosswalk

| ID | Batch | Priority | State at batch creation | Scope |
|---|---|---|---|---|
| RC26-BASE-03 | A — Runtime and diagnostics | P2 | active | Create a small repeatable behavior and ergonomics benchmark |
| RC26-REC-05 | Incident evidence | P1 | blocked | Resolve the existing incident through the qualified path |
| RC26-OBS-04 | A — Runtime and diagnostics | P1 | active | Reconcile agent totals with attributed and unattributed traffic |
| RC26-OBS-05 | A — Runtime and diagnostics | P2 | planned | Measure latency stages and map optional OTel conventions |
| RC26-HIS-01 | A — Runtime and diagnostics | P2 | implemented | Persist 60–90 days of daily aggregates independently of recovery |
| RC26-HIS-02 | A — Runtime and diagnostics | P2 | active | Publish coverage-aware reports and denominators |
| RC26-HIS-04 | A — Runtime and diagnostics | P2 | active | Bound aggregate and recovery pressure independently |
| RC26-INV-01 | A — Runtime and diagnostics | P2 | active | Reconcile the canonical fleet inventory |
| RC26-INV-02 | A — Runtime and diagnostics | P2 | active | Expose desired, installed, startup and running versions |
| RC26-INV-03 | A — Runtime and diagnostics | P2 | implemented | Use bounded probes and backoff for intermittent devices |
| RC26-INV-05 | C — DSH isolation | P1 | active | Isolate automated review probes from installed services |
| RC26-UX-01 | A — Runtime and diagnostics | P2 | planned | Provide a bounded read-only doctor workflow |
| RC26-UX-02 | B — Experience and governance | P2 | planned | Guide tool and identity selection by intent |
| RC26-UX-03 | A — Runtime and diagnostics | P2 | active | Keep default results compact with exact recovery |
| RC26-UX-04 | A — Runtime and diagnostics | P2 | planned | Batch independent reads using existing facilities |
| RC26-UX-05 | A — Runtime and diagnostics | P2 | planned | Select durable jobs and receipts according to the operation |
| RC26-UX-06 | A — Runtime and diagnostics | P2 | planned | Expose actionable job progress without invented certainty |
| RC26-UX-07 | B — Experience and governance | P2 | planned | Extend the existing MCP Apps console with the same contracts |
| RC26-GOV-01 | B — Experience and governance | P2 | planned | Reconcile review evidence against the exact repository head |
| RC26-GOV-02 | B — Experience and governance | P2 | planned | Preserve complementary Codex and DSH review workflow |
| RC26-GOV-03 | B — Experience and governance | P1 | active | Keep tracker state and private handoffs synchronized |
| RC26-MCP-01 | A — Runtime and diagnostics | P2 | planned | Build the actual client and protocol compatibility matrix |
| RC26-MCP-02 | A — Runtime and diagnostics | P2 | planned | Run relevant official protocol conformance cases |
| RC26-MCP-03 | A — Runtime and diagnostics | P2 | planned | Verify modern discovery and catalog/result parity |
| RC26-MCP-04 | A — Runtime and diagnostics | P1 | active | Verify cancellation, reconnection and durable effect continuity |
| RC26-MCP-05 | A — Runtime and diagnostics | P2 | planned | Qualify the supported real hosts and document the limits |
| RC26-TMO-01 | A — Runtime and diagnostics | P2 | planned | Align wait budgets across client, controller, agent and process |
| RC26-TMO-02 | A — Runtime and diagnostics | P2 | planned | Qualify heartbeat and bounded UI collection |
| RC26-EXP-01 | D — Experiments and performance | P3 | planned | Probe real client support for the Tasks extension |
| RC26-EXP-02 | D — Experiments and performance | P3 | conditional | Pilot Tasks as an adapter over existing durable jobs |
| RC26-EXP-03 | D — Experiments and performance | P3 | conditional | Compare Android observation geometry on a finite test matrix |
| RC26-EXP-04 | D — Experiments and performance | P3 | conditional | Compare Windows desktop diagnostics on the same machine |
| RC26-EXP-05 | D — Experiments and performance | P3 | conditional | Compare Playwright CLI plus skills with the existing browser route |
| RC26-PERF-01 | D — Experiments and performance | P3 | planned | Profile observer and reconciliation cost before optimization |
| RC26-PERF-02 | D — Experiments and performance | P3 | conditional | Optimize only the measured limiting path |
| RC26-PERF-03 | D — Experiments and performance | P3 | planned | Set measured regression budgets |
| RC26-DOC-01 | A — Runtime and diagnostics | P2 | planned | Reconcile version claims and operational documentation |
| RC26-DEL-01 | Incident evidence | P1 | blocked | Close the recovery and desktop lot with behavior evidence |
| RC26-DEL-02 | A — Runtime and diagnostics | P2 | active | Close the telemetry, history and inventory lot |
| RC26-DEL-03 | B — Experience and governance | P2 | planned | Close usability and compatibility with real workflows |
| RC26-DEL-04 | D — Experiments and performance | P3 | planned | Record a decision for every experiment and the remaining backlog |

## Historical development checkpoint

Working branch: `feat/rc26-consolidated-delivery-20261118`, based on main `2b747cdc256c8a14467ac91d2957fb8017304d9b`. At this checkpoint the worktree was unreviewed and had yet to merge or deploy.


## Batch A first integrated source checkpoint (2026-11-18)

Source-only checkpoint: `9b5bd9b50dcfffbdc05d12f5d3fec1b473bf99e8`.
The consolidated branch includes read-only doctor, provenance-separated
runtime/declared version layers in the existing capability_report, actionable
job progress via existing status/wait tools, bounded stage aggregation in the
existing ToolDiagnostics, and measured per-item read batching using batch_read.
No new generic polling daemon, retry-on-unknown behavior or installed-host
service permissions were added.

Local integrated qualification: TypeScript/console build passed, public-data,
public-history and privacy guards passed, and Linux nonprivileged regression
suite **1,517 tests passed / 65 skipped** (two privileged native systemd test
files intentionally excluded). B01/B06/UX synthetic coverage is additive;
B01-B07 full comparable native benchmark remains open.

Six planned IDs moved to active in the canonical tracker after code/test work
began: OBS-05, UX-01, UX-04, UX-05, UX-06 and DOC-01. The 61 IDs remain
unchanged; none was marked verified solely from this local test result.

The evidence in this checkpoint covered local source and tests. See the later
merge and controller qualification below. Remaining acceptance includes native
version/install/startup evidence, paired live traffic windows, full protocol
conformance, longer-term history/pressure, full B01-B07 measurements and
Console Batch B. Historical uncertain coordination slots stay fenced.

## PR #70 merge and controller qualification

[PR #70](https://github.com/anervalens-netizen/remote-control-mcp/pull/70)
merged as `e469c6229a3f232d7bbde308348af0598bfbb503`. The pinned controller
runtime was read back at this source revision. Authenticated read-only checks
verified App and text doctor parity, configured root and owner observations,
version provenance, retained latency stage measurements, the console asset
hash and inspection of an existing durable job on selected Linux routes.
Both selected Linux agent identities were later promoted to the same pinned
application release. Each was activated separately after native idle checks.
Coordinator journal and sidecar checksums stayed unchanged. Other agent
revisions and independent startup attestations retain separate acceptance. Detailed receipts remain private.

## Later native compatibility checks

Authenticated live modern HTTP (2026-07-28), initialized legacy HTTP and a
fresh legacy reconnect exposed the same configured catalogue and console asset.
All three read the same existing terminal job with effect verification still
unknown. Two physical Android companions completed bounded metadata-only
observations through reverse polling. The response contained dimensions,
rotation and a snapshot identity. Both configured Windows routes returned no
response within their read-only probe budget. Hosted Windows CI qualifies
compatibility in its runner environment. Physical Windows and interactive
Android remain open.

Later selected Linux root and owner windows were complete and reconciled with
zero residual and no missing detail. The root window contained both attributed
and unmatched arrivals.
A bound ContextKeep integration run also read the existing executor receipt,
matched the observed runtime and verified the exact run revision. Bulk
history and fleet-wide accounting remain open.

A paired native Linux check matched the bytes, per-item execution identity
and missing-file error for separate reads and one bounded batch. The batch
required fewer client calls in that scenario. Manual availability keeps
inventory entries visible while skipping automatic probes. Synthetic
checks qualified explicit selection through the existing alias.

The independent DSH review was deferred due to reviewer quota and remains
outstanding. Broader paired traffic windows, history under pressure, ChatGPT-host
rendering and wider protocol conformance retain their own acceptance gates.
PR #63 adds diagnostic evidence for rejected Git checkpoints while preserving
their uncertain writer fence. A native fixture with isolated state verified
the original index and retained diagnosis. The controller follow-up reports
a concise failure notice and points to the original recovery inspection.
The historical incidents remain evidence-gated.
