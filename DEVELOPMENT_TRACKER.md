# Reliability change guide

This file describes reusable engineering requirements, not deployment state or an operator work report. Private project memory, validation receipts, active release manifests and rollback records belong in private operator storage.

## Acceptance requirements

- RPC and raw-file calls reject redirects without replaying effects; raw error consumption and response lifetime are bounded.
- Publication verification checks every historical path and mode, commit metadata and supported text encodings. Git-only fixtures remain portable across host filesystems.
- Public CI uses hosted workers only; persistent personal-network runners must not be registered here.
- Historical journal resolution retains an immutable tombstone under the writer lock. Recovery copies must be regular no-follow files; synchronize their directory ancestry before publishing a durable resolution. Test stale writers, reused links and parent-sync failures.
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


## Usage hardening

Reusable requirements for high-level execution and connector compatibility:
- Fleet health keeps transport reachability, runtime readiness and metrics availability as separate facts.
- Durable high-level project/deployment operations may accept an optional stable key, but keyed execution must be refused when the target agent does not explicitly advertise the matching protocol capability.
- A keyed retry resolves the original derived execution before consulting mutable project/repository state and still validates the underlying durable-job fingerprint; a key collision must never return unrelated work.
- Read-only key inspection never starts or replays work.
- Durable history remains cursor-safe after structured-output compaction, including compatibility access through `job_list`.
- Typed agent causes may be preserved in bounded error metadata, without inferring retry safety from an HTTP status alone.

Implementation, review, CI and deployment state are tracked outside this public source guide.

## Modern HTTP compatibility

- Serve the modern protocol with the official SDK while retaining legacy sessions.
- Preserve tool contracts, cancellation, progress and retained-result metadata across both paths.
- Classify modern validation failures with the SDK; never bypass authentication or downgrade malformed envelopes.
- Verify real connector traffic separately from synthetic protocol tests.

## Android secure Downloads push (issue #32)

`android_file_push` accepts a stable command UUID, an online paired Android
reverse destination, a configured source agent/path, optional source context
(default `system`), and an optional filename. Source agents must advertise
`relaySourceVersion >= 1`. Metadata, every byte chunk, and a final metadata read
use generation-bound `fsRead`; a changing or incomplete source fails before
Android dispatch. Files are capped at 512 MiB, with at most four concurrent
controller staging operations and a ten-minute staging/delivery deadline.

Controller staging uses private directories/files under the configured Android
state directory. Downloads use the existing device credential at
`GET /android/v1/files/<transferId>`; the route rejects unauthenticated,
wrong-device, expired, and undispatched requests. The companion retains the VPN
route check and rejects redirects. It writes a pending `MediaStore.Downloads`
entry, verifies length and SHA-256, then publishes. Failures attempt deletion;
abandoned pending rows also carry an expiry. No storage permission, root, ADB,
Shizuku, or Accessibility capability is required for this operation.

Durable reservations bind each device/command UUID to its source and sanitized
filename before reading. Retries reuse status or the existing operation; a
changed source request conflicts. Retain reservations as no-replay tombstones.
Inspect `android_command_status` after uncertainty, including staging failures;
a restart removes staged bytes but never redelivers. Completed transfer receipts
retain the verified transfer ID, SHA-256, byte count and publication flag for
status inspection until normal command-journal compaction. Compacted commands
report history unavailable without replay. A late result must match the original delivery and expected
transfer metadata. This is not a claim of exactly-once behavior under state loss.

Validation commands:

```sh
pnpm typecheck
pnpm exec vitest run tests/android-file-push.test.ts tests/android-companion-static.test.ts tests/android-lifecycle-static.test.ts tests/android10-companion-static.test.ts
pnpm test
cd apps/android-companion
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Pending Downloads are cleaned by an application-owned persisted scheduled job and on service startup. Cleanup selects only this application's unpublished rows older than one hour. Android may delay scheduled jobs (including Doze or force-stop); this is not an exact one-hour deletion guarantee. MediaStore manages its own expiry columns. Companion capability `receiveFile` must be present before a new transfer reserves an ID or reads source bytes.
