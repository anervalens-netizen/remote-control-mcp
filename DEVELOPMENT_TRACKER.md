# Reliability remediation tracker

Baseline: sanitized public source `92e61fb`. This document contains generic engineering work only; runtime identities, endpoints, secrets, operational evidence and deployment records remain private.

## Plan and acceptance

- [x] B01: reject RPC redirects; prove 301/302/303/307/308 do not forward requests, with no ordinary error replay.
- [x] B02 + A01 + A04: inspect every historical path and mode independently of content caching; check commit messages and supported UTF-16 text; detect literal application bearer material; inspect staged/history symlinks; run full-history validation in hosted CI and keep pre-push verification.
- [x] A02: remove persistent self-hosted routing from public workflows. Native interactive qualification remains a separate owner-controlled operation; do not register personal runners to this public repository.
- [x] B03 + A03: report same-file moves as no-ops without deleting either link; report Windows crash durability as unverified rather than asserting unsupported guarantees. Preserve existing recovery semantics.
- [x] A05: retain minimal public liveness; require configured authentication for detailed health. Preserve authenticated compatibility and update diagnostic callers/tests.
- [x] A06: add optional durable caller-key job deduplication with conflict and uncertain-outcome handling. Never replay an uncertain effect automatically.
- [x] A07 + A08: isolate and test SDK compatibility adapter; pin current dependency/action resolutions; document installation, recovery, public/private boundary and result contracts without operational data.
- [x] Verification: regression tests, typecheck, privacy worktree/index/history, full Linux and hosted Windows CI, Android CI if applicable, exact-head verification and a second implementation review.
- [x] Release: preserve rollback material, deploy only verified runtime changes, check actual runtime and MCP health, synchronize private operational records and project memory. Report unavailable physical/native coverage separately.

Do not weaken existing assertions, reintroduce retired review services, add owner command restrictions, publish operational data, or label skipped hardware checks as passed.

## Validation before publication

Local Linux: 577 passed, 37 skipped, zero failures; TypeScript passed. Privacy/index validation and nine history/encoding regression cases passed. A 102-session retained-memory/reuse check passed. The changed CI policy has dedicated assertions; skipped physical/interactive checks are not passes. CI passed on source `057a409`: Linux 578 passed / 36 skipped; hosted Windows 513 passed / 101 skipped; Android build, lint and unit checks passed. Runtime release acceptance passed on the available Linux controller/agent roles with preserved state and privileges, authenticated diagnostics, and an end-to-end keyed-job replay check. Exact operational receipts and rollback copies remain private.

## Remaining hardware qualification

Offline physical Windows/Android targets were not deployed or interactively qualified. Hosted Windows and simulated durability tests are not power-loss or full-restore certification. These unavailable hardware checks do not block the completed Linux/code remediation, and remain explicitly unverified. The controller still exposes all 94 tools; no owner command restrictions were added.
