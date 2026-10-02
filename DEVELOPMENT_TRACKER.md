# Reliability change guide

This file describes reusable engineering requirements, not deployment state or an operator work report. Private project memory, validation receipts, active release manifests and rollback records belong in private operator storage.

## Acceptance requirements

- RPC and raw-file calls reject redirects without replaying effects; raw error consumption and response lifetime are bounded.
- Publication verification checks every historical path and mode, commit metadata and supported text encodings. Git-only fixtures remain portable across host filesystems.
- Public CI uses hosted workers only; persistent personal-network runners must not be registered here.
- Move receipts distinguish same-file no-ops, completed effects and independently verified durability. Secret activation failures preserve typed recovery receipts and never return payload bytes. MCP schemas must accept the exact emitted result.
- Directory synchronization checks same-host canonical path overlap before mutation and preserves completed/failed/unattempted results after all started workers settle.
- Health exposes minimal unauthenticated liveness and authenticated diagnostics.
- Optional job keys preserve typed conflict/uncertainty details and never authorize replay of an uncertain effect.
- Process cancellation/timeout must distinguish stopping every observed identity-bound process from proving that no detached descendant escaped before observation. Without kernel containment, do not publish whole-tree verification or a verified `cancelled` job state when that distinction cannot be proved.
- SDK adapters and advertised input/output schemas are covered through actual MCP client calls, not only direct function invocation.

Run the commands documented in README.md and the relevant platform tests. Hardware-dependent checks must not be represented as passed when they are unavailable. Keep fixtures synthetic and published review discussions limited to generic code behavior.

## Optional workflow event bridge

- [x] Correlate a job with an existing project/task/run and durable start key.
- [x] Persist the correlation before starting; preserve uncertain starts.
- [x] Retry retained results without making ContextKeep availability an execution prerequisite.
- [x] Cover duplicate starts, lost receipts and restart using synthetic tests.
- [ ] Qualify live host delivery separately from local transport tests.

## Audit remediation A01–A12

Single public tracker: issue #11. Source changes and regressions address correlated acknowledgement validation, corrupt-journal isolation, bounded JSON/SSE delivery, staged reconciliation, Windows extended-path file/ACL behavior, coherent relay source generations and per-device automatic batch identities. `docs/RELIABILITY.md` documents their guarantees and limits.

The release attestation script verifies tracked release bytes; actual runtime identity and live canaries remain separate acceptance evidence. Public workflows and their regression tests require hosted workers. Device inventories, history-repair maps, private runner registration state and deployment receipts are intentionally not recorded here.

An unavailable device, an uninstalled Android candidate, missing historical attachment proof, skipped interactive checks and untested power-loss recovery are not completed acceptance items. Keep issue #11 open until the required evidence is recorded or the owner explicitly changes scope. Do not infer closure from this source guide.


## Usage hardening — issue #18

Owner-authorized implementation started 2026-10-02 from the adversarial usage review. Scope is additive/backward-compatible: truthful fleet readiness, connector-compatible durable history through `job_list` while retaining `job_history`, optional idempotency keys for durable `project_run`/`deploy_run`, read-only key lookup without replay, and bounded typed agent causes.

Acceptance status:
- [x] Isolated implementation worktree created from exact `origin/main` baseline `f3a35e9`.
- [x] Targeted regressions pass, including real project/deploy duplicate-start prevention and conflict handling.
- [x] Linux privacy/history guards, typecheck and full suite pass: 796 passed / 53 platform skips.
- [ ] Native Windows exact-source qualification.
- [ ] Official Codex Connector review and exact-head CI.
- [ ] Merge, exact-main CI and staged production rollout.
- [ ] Live canaries for readiness, history fallback, idempotency/key lookup, typed errors and no-replay.

ChatGPT app tool snapshots are an integration surface separate from the runtime. Server changes remain backward-compatible; a stale published action snapshot is not represented as a failed runtime deployment. Android physical qualification remains under issue #11 and is not reopened by issue #18.
