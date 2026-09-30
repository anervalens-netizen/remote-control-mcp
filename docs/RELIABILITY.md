# Reliability and release qualification

This guide describes the source contracts. Live inventory, completion receipts, source mappings, rollback bundles and outstanding device checks are private operator records. GitHub issue #11 tracks the A01–A12 remediation; a passing unit test is not a deployment receipt.

## Integrity invariants

A command receipt, coherent file contents, the selected execution identity and a correlated delivery acknowledgement are separate facts. Never infer one from another. Timeout, a disconnected caller or a missing receipt does not authorize effect replay.

Relay transfers bind all byte reads to one regular-file generation and validate it before/after each read and before requesting destination publication. File size and preserved modification time alone are insufficient. The source must advertise generation-bound reads; an old source is rejected before destination mutation even when metadata-legacy compatibility is explicitly enabled. Direct transport remains a separate hash/final-confirmation protocol. Neither transport claims a multi-file snapshot or transactional directory synchronization. Filesystems with unusual change metadata need separate qualification.

Windows PowerShell/.NET file and ACL operations receive extended-length paths as literal environment values, not script interpolation. New destinations retain no-replace publication; existing destinations retain their security descriptors and prior data on preparation failure. Windows can normalize the discretionary ACL AUTO_INHERITED bookkeeping flag; permissions, ordered ACE bytes, owner/group and other relevant control flags are not intentionally changed. Native tests must cover long new/existing paths and literal Unicode/shell-significant names. UNC path normalization tests do not establish connectivity or behavior of every SMB server.

Every batch route is resolved before dispatch. An explicit unavailable identity fails preflight. Automatic heterogeneous batches use each device's own route and publish per-item identities. Optional top-level routing is present only for a uniform batch; result compaction must not invent a route for a mixed batch.

## ContextKeep bridge

The opt-in bridge is an executor-result adapter, not a task verifier. Use an absolute private journal directory, HTTPS or loopback HTTP, independent credentials and a ContextKeep reservation whose canonical input hash matches the command, working directory and sorted environment.

A durable exclusive reservation precedes the only executor start. Invalid/corrupt/partial records remain evidence, and a missing job receipt stays uncertain. Do not delete or rewrite a reservation to make a command retryable. A new intended execution uses a new key. Delivered records remain permanent deduplication tombstones; preserve them with backups even when output logs are rotated.

Acknowledgements must be valid correlated JSON-RPC tool results with the expected run/job scope. An HTTP 200, empty object or unrelated response ID is not delivery. JSON and incremental SSE are supported, including a server keeping the stream open after the matching event. Byte and time budgets, cancellation and redirect rejection bound one attempt; transport uncertainty never causes a new executor start.

Version-2 journals persist attachment acknowledgement, observed terminal facts and delivery separately. Version-1 journals remain readable, but missing historical proof is not invented. Reconciliation can confirm a terminal remote run only with exact correlation and a proven hash-checked attachment. When proof is insufficient, keep `proof_missing` pending and investigate read-only evidence; do not blindly mark the row delivered or overwrite a verified remote result.

Authenticated health diagnostics report pending count/oldest age, corrupt count and safe error categories. A corrupt entry does not stop healthy entries. Processing has bounded concurrency, exponential retry backoff and bounded shutdown. Aggregate HTTP failures are not a measured command-failure rate.

ContextKeep owns atomic ordering between observations and independent verification. The bridge avoids known terminal/verified writes, but a client-side read alone cannot fence a simultaneous server-side write. Changes to that contract must be coordinated in the ContextKeep project, not silently invented by this controller.

## Release procedure

1. Keep implementation in an isolated worktree; preserve concurrent work, private state and previous release/service definitions. Validate the exact candidate with typecheck, relevant regressions and full Linux/native Windows suites. Build/lint/JVM tests do not replace Android device checks.
2. Check current/index content and the complete reachable publication history. Use noreply author and committer metadata. A metadata-only correction must preserve every source tree/message, retain a private recovery bundle and publish with an expected remote ref, not an unchecked history replacement. Never weaken the publication guard to make a candidate pass.
3. Build an immutable release directory containing source and locked dependencies. Run `scripts/verify-release.ts` and keep its successful JSON output privately. Record actual services, identities, test reports and rollback target separately. Do not commit an operational manifest or private source mapping to this repository.
4. Upgrade source agents before the controller when a new protocol capability is required. Use a separate live control context and account for running jobs before a restart. Preserve all credentials, absolute state paths, job keys, bridge and move-recovery journals. An unavailable host is not implicitly upgraded.
5. Confirm authenticated runtime SHA, process/executable path and usable capabilities after activation. Exercise synthetic transfer, batch and result-delivery canaries without touching personal data. A mismatch or failed canary requires investigation or restoring the previous release; do not relabel the intended version as the observed one.

## Platform qualification and retention

Report transport, identity, interactive desktop, Android Accessibility, screenshot and optional shell readiness separately. A device marked online does not imply screenshots or interactive controls work. Android screen-capture consent and OS lifecycle behavior must be tested on physical devices without bypassing local permission requirements. An unavailable Work host, omitted interactive suite or uninstalled APK remains explicitly pending.

Keep public CI on hosted workers. Do not register a persistent personal-network runner with a public repository; an editable workflow condition is not isolation. Private owner-native qualification remains available through the control plane and does not restrict owner execution privileges.

Clean up only identified obsolete staging/install services and bounded temporary artifacts after checking usage and preserving needed release evidence. Do not delete deduplication/recovery journals as generic log cleanup. Review Android lint warnings individually; a warning count is neither a confirmed defect count nor a reason for indiscriminate stack upgrades.
