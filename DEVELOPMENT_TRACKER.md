# Reliability change guide

This file describes reusable engineering requirements, not deployment state or an operator work report. Private project memory, validation receipts, active release manifests and rollback records belong in private operator storage.

## Acceptance requirements

- RPC calls reject redirects without replaying effects.
- Publication verification checks every historical path and mode, commit metadata and supported text encodings. Git-only fixtures remain portable across host filesystems.
- Public CI uses hosted workers only; persistent personal-network runners must not be registered here.
- Move receipts distinguish same-file no-ops, completed effects and independently verified durability. MCP schemas must accept the exact emitted result.
- Health exposes minimal unauthenticated liveness and authenticated diagnostics.
- Optional job keys preserve typed conflict/uncertainty details and never authorize replay of an uncertain effect.
- SDK adapters and advertised input/output schemas are covered through actual MCP client calls, not only direct function invocation.

Run the commands documented in README.md and the relevant platform tests. Hardware-dependent checks must not be represented as passed when they are unavailable. Keep fixtures synthetic and published review discussions limited to generic code behavior.
