# RCMCP Usage Hardening — 2026-10-02

## Engineering scope
R0. Reconfirm origin/main, installed runtime and ChatGPT connector surface.
R1. Correct fleet_status readiness: use runtime.ready (with compatibility fallback), keep connectivity, readiness and metrics availability distinct.
R2. Connector parity without depending on a tool refresh: extend exposed job_list with optional history pagination/filtering while retaining job_history as a compatible alias.
R3. Add optional idempotencyKey to project_run and deploy_run durable job paths and propagate it to the existing JobStartDeduplicator. Calls without a key preserve current deliberate-rerun behavior.
R4. Add read-only idempotency-key lookup that reports reservation/job evidence and never starts/replays work.
R5. Preserve typed agent error causes (e.g. ENOENT) through MCP error output where safely derivable; do not infer generic retry safety.
R6. Add regression/adversarial tests: readiness true/false, job-list history pagination, same-key project/deploy dedup + conflict + uncertain, lookup no-replay, typed ENOENT.
R7. Qualify with typecheck, Linux and native Windows coverage, repository CI and code review.
R8. Require staged rollout discipline: agents before controller, exact-source verification, recovery retained, and explicit canaries for readiness, history fallback, no-replay, project/deploy idempotency and typed errors. Unavailable hardware remains unverified rather than inferred healthy.

## Invariants
- Preserve owner/root/SYSTEM and raw execution capability.
- Never replay an uncertain effect automatically.
- Existing job metadata/receipts remain authoritative.
- Keep job_history for clients that already expose it.
- No reset/clean/checkout-over of unrelated worktrees.
- DEVELOPMENT_TRACKER.md, GitHub issue and ContextKeep are updated before closeout.
