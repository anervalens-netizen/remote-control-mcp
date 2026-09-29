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
