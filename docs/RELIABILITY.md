# Reliability and release qualification

This guide describes the source contracts. Live inventory, completion receipts, source mappings, rollback bundles and outstanding device checks are private operator records. GitHub issue #11 tracks the A01–A12 remediation; a passing unit test is not a deployment receipt.

## Integrity invariants

A command receipt, coherent file contents, the selected execution identity and a correlated delivery acknowledgement are separate facts. Never infer one from another. Timeout, a disconnected caller or a missing receipt does not authorize effect replay.

Relay transfers bind all byte reads to one regular-file generation and validate it before/after each read and before requesting destination publication. File size and preserved modification time alone are insufficient. The source must advertise generation-bound reads; an old source is rejected before destination mutation even when metadata-legacy compatibility is explicitly enabled. Direct transport remains a separate hash/final-confirmation protocol. Neither transport claims a multi-file snapshot or transactional directory synchronization. Filesystems with unusual change metadata need separate qualification.

Windows PowerShell/.NET file and ACL operations receive extended-length paths as literal environment values, not script interpolation. New destinations retain no-replace publication; existing destinations retain their security descriptors and prior data on preparation failure. Windows can normalize the discretionary ACL AUTO_INHERITED bookkeeping flag; permissions, ordered ACE bytes, owner/group and other relevant control flags are not intentionally changed. Native tests must cover long new/existing paths and literal Unicode/shell-significant names. UNC path normalization tests do not establish connectivity or behavior of every SMB server.

Every batch route is resolved before dispatch. An explicit unavailable identity fails preflight. Automatic heterogeneous batches use each device's own route and publish per-item identities. Optional top-level routing is present only for a uniform batch; result compaction must not invent a route for a mixed batch.

## ContextKeep bridge

The opt-in bridge is an executor-result adapter, not a task verifier. Use an absolute private journal directory, HTTPS or loopback HTTP, independent credentials and a ContextKeep reservation whose canonical input hash matches the command, working directory and sorted environment.

Canonical input hashes sort environment keys by locale-independent UTF-16 code-unit order and serialize that order directly, including numeric-looking names such as `10` and `2`; rebuilding a JavaScript object would reorder those names. Producers must use the same explicit rule; historical journal hashes are never rewritten in place to make a conflicting start appear retryable.

A durable exclusive reservation precedes the only executor start. Invalid/corrupt/partial records remain evidence, and a missing job receipt stays uncertain. Do not delete or rewrite a reservation to make a command retryable. A new intended execution uses a new key. Delivered records remain permanent deduplication tombstones; preserve them with backups even when output logs are rotated.

Acknowledgements must be valid correlated JSON-RPC tool results with the expected run/job scope. An HTTP 200, empty object or unrelated response ID is not delivery. JSON and incremental SSE are supported, including a server keeping the stream open after the matching event. Byte and time budgets, cancellation and redirect rejection bound one attempt; transport uncertainty never causes a new executor start.

Version-2 journals persist attachment acknowledgement, observed terminal facts and delivery separately. Version-1 journals remain readable, but missing historical proof is not invented. Reconciliation can confirm a terminal remote run only with exact correlation and a proven hash-checked attachment. When proof is insufficient, keep `proof_missing` pending and investigate read-only evidence; do not blindly mark the row delivered or overwrite a verified remote result.

Authenticated health diagnostics report pending count/oldest age, corrupt count and safe error categories. A corrupt entry does not stop healthy entries. Processing has bounded concurrency, exponential retry backoff and bounded shutdown. Idle pumps and diagnostics use an in-memory index of unresolved records, not the permanent delivered history. A full bootstrap scan and reconciliation 60 seconds after the previous scan finishes discover external additions, repairs and removals. Duplicate starts and scheduled attempts still read the durable record before acting; no cached acknowledgement authorizes replay. Both HTTP and stdio shutdown abort and drain correlated start requests as well as receipt workers. A cancelled request does not prove that an already-received remote command did not execute: its uncertain reservation remains, and a late response cannot update the closed bridge. Version-2 delivered entries require durable attachment proof; the historical version-1 tombstone exception does not legitimize an unacknowledged version-2 entry. Aggregate HTTP failures are not a measured command-failure rate.

ContextKeep owns atomic ordering between observations and independent verification. The bridge avoids known terminal/verified writes, but a client-side read alone cannot fence a simultaneous server-side write. Changes to that contract must be coordinated in the ContextKeep project, not silently invented by this controller.

## Release procedure

1. Keep implementation in an isolated worktree; preserve concurrent work, private state and previous release/service definitions. Validate the exact candidate with typecheck, relevant regressions and full Linux/native Windows suites. Build/lint/JVM tests do not replace Android device checks.
2. Check current/index content and the complete reachable publication history. Use noreply author and committer metadata. A metadata-only correction must preserve every source tree/message, retain a private recovery bundle and publish with an expected remote ref, not an unchecked history replacement. Never weaken the publication guard to make a candidate pass.
3. Build an immutable release directory containing source and locked dependencies. Run `scripts/verify-release.ts` with a full object ID matching the repository hash format, and keep its successful JSON output privately. A symbolic release root is rejected; ancestor aliases resolve to the physical directory named in the receipt. Record actual services, identities, test reports and rollback target separately. Do not commit an operational manifest or private source mapping to this repository.
4. Upgrade source agents before the controller when a new protocol capability is required. Use a separate live control context and account for running jobs before a restart. Preserve all credentials, absolute state paths, job keys, bridge and move-recovery journals. An unavailable host is not implicitly upgraded.
5. Confirm authenticated runtime SHA, process/executable path and usable capabilities after activation. Exercise synthetic transfer, batch and result-delivery canaries without touching personal data. A mismatch or failed canary requires investigation or restoring the previous release; do not relabel the intended version as the observed one.

## Platform qualification and retention

Report transport, identity, interactive desktop, Android Accessibility, screenshot and optional shell readiness separately. A device marked online does not imply screenshots or interactive controls work. Android screen-capture consent and OS lifecycle behavior must be tested on physical devices without bypassing local permission requirements. An unavailable Work host, omitted interactive suite or uninstalled APK remains explicitly pending.

Keep public CI on hosted workers. Do not register a persistent personal-network runner with a public repository; an editable workflow condition is not isolation. Private owner-native qualification remains available through the control plane and does not restrict owner execution privileges.

Clean up only identified obsolete staging/install services and bounded temporary artifacts after checking usage and preserving needed release evidence. Do not delete deduplication/recovery journals as generic log cleanup. Review Android lint warnings individually; a warning count is neither a confirmed defect count nor a reason for indiscriminate stack upgrades.

## Windows directory transfer qualification

The cross-volume fallback uses literal DOS/UNC arguments for Robocopy, which handles long paths itself but rejects extended namespace prefixes. File/ACL APIs still receive extended-length paths. Tree compression is applied through native file/directory handles rather than `compact.exe`; directory timestamps use directory APIs, and joining native paths does not depend on PowerShell drive providers. Native regressions exercise compressed and uncompressed trees against opposite staging defaults at short and extended path lengths. The regression injects the initial cross-volume error on synthetic files; it does not format or mount a test volume.

Terminal status requests receive the attempt/shutdown abort signal rather than merely abandoning their returned promise. Task-run reconciliation scans at most ten pages per attempt and carries an in-memory cursor across bounded attempts, so older runs beyond offset 500 remain discoverable. Process restart starts the lookup at zero without mutating historical journal formats; completed, removed or corrupt entries do not retain lookup state.

Windows transfer staging normalizes the temporary-directory prefix as well as file/ACL paths. Native regressions cover both new and existing destinations inside parent directories longer than 260 characters; a long filename in a short parent is not equivalent coverage.

Historical reconciliation is an explicit operator disposition, not an attachment ACK. The historical_resolved journal state retains the original reservation key/hash/job/run, stores a SHA-256 of the unresolved receipt plus the retrospective evidence record ID, is excluded from delivery retries, and still blocks executor replay for the same idempotency key. Normal journal writes and historical disposition share an exclusive per-receipt lock; a stale lock fails closed for inspection. The operator command requires absolute journal/recovery directories, applies the normal bounded no-follow read before hashing, and writes a durable byte-for-byte recovery copy before replacement. It may only be created from a tracking receipt with no attachment ACK and exact expected identifiers.

## Bounded results and delivery recovery (R01/R02/R04)

The final tool result is validated after compaction against both semantic Zod
checks and the exact advertised JSON Schema. Unknown properties are not accepted
merely because Zod would strip them. All tool schemas explicitly advertise result
metadata and an alternative `{resultOmitted:true,resultRecovery:...}` envelope.
A validation failure returns a typed `result_validation_failed` receipt with a
read-only recovery reference; serialization/delivery preparation failures use
`result_delivery_failed`. Neither permits replay. Non-JSON callback results have
an explicitly labelled inspection representation, not a fabricated exact JSON
receipt. Normal retained results preserve the original JSON tool result, including
its original text and structured representations.

`structuredContent` is limited to 64 KiB and the entire JSON tool result
(`content` plus `structuredContent`, before JSON-RPC/HTTP framing) to 256 KiB.
Small legacy text arrays/objects remain compatible. A compacted response puts the
same bounded page/envelope in text and structured content; full legacy JSON is
no longer secretly carried as an unbounded second copy. Clients must inspect
`structuredContentTruncated`, `contentTruncated`, `resultOmitted` and `resultRecovery`. Unknown payload
shapes are omitted explicitly instead of recursively clipping IDs, base64 data,
recovery paths, counts or cursor semantics. Images/resources exceeding the total
budget are accessible in the retained original result, through authenticated
recovery pages. An absent immediate image is not evidence that capture failed.

`fs_read` pages preserve canonical base64 and count only bytes actually returned.
A shortened page advances `nextOffset` by those bytes and clears `eof`; line-mode
continuation also updates `linesRead`, `nextLine` and `partialLine`. Continue with
the returned byte offset, or recover the original receipt to avoid rereading a
changing source. Versioned reads retain `sourceVersion`. UTF-8 byte pages and
previews end on codepoint boundaries; a requested page smaller than one codepoint
can return up to three extra bytes to make progress. An explicit offset inside a
codepoint is rejected; arbitrary byte offsets require base64. Invalid UTF-8 input
is not promised to round-trip through a UTF-8 string; use base64 for arbitrary
binary content. Strict writer base64 validation still precedes any mutation.

History pages shorten at row boundaries. An oversized row retains ID, state,
start time and a bounded command preview with `commandTruncated`/`detailsOmitted`.
`job_status` reads its details; the page recovery reference retains the full
original rows, including any fields absent from the preview. `nextCursor` refers
to the last row actually delivered. Text and structured clients see the same
navigation. Ordinary history corruption `partial` keeps its existing meaning.

For exec, `requestSucceeded` means an agent execution receipt was received.
`executionOutcome` distinguishes `exit_zero`, `exit_nonzero`, `signal`, `timeout`,
`cancelled`, `uncertain` and `not_started`. Verified cancellation requires
`terminationVerified`; cancellation requested without that proof is uncertain.
A request exception after dispatch is uncertain even for HTTP errors: it does
not prove the effect was absent. Exit zero with stderr is still exit zero.
`effectVerification:"unverified"` and `clientAcceptance:"unknown"` are separate
facts. Exit zero never independently certifies the intended effect.

Batch `ok`, `errors` and `partial` retain their request-level meanings. New
`summary` counts every input before preview selection, including omitted items;
`executionPartial` is true unless all commands report exit zero. `totalItems` and
`previewItems` describe a shortened preview. Request failures retain selected
agent/HTTP category, code, route and typed recovery fields through the same
bounded error serializer as individual calls. Cancellation prevents queued
batch dispatch, drains active calls and retains all slots as settled, uncertain
or not started. Resolving an identity still preflights every route before effects.
Diagnostics expose bounded execution-outcome counts, request errors,
`finalValidationFailures` and `resultPreparationFailures`, but reading a failed job remains a successful read. Diagnostics cannot
observe SDK/UI acceptance and do not claim effect verification.

### Read-only result recovery and its limits

Every ordinary tool invocation reserves a controller-memory result slot before
its handler runs and retains the result before final validation/compaction.
`result_recover({id,offset,length})` returns base64 pages of the original JSON,
with a maximum 12 KiB of decoded bytes per call. Concatenate decoded pages, then
parse JSON. This tool only reads; it never reruns the original operation. It uses
the same owner-authenticated MCP connection and creates no public file or URL.
HTTP sessions on the same controller share the registry/recovery store.

For an ID known **before** dispatch, call `result_recovery_prepare`, then supply
its ID in the normal MCP `tools/call` metadata:

```json
{
  "name": "exec",
  "arguments": {"device": "fixture", "command": "printf synthetic"},
  "_meta": {"resultRecoveryId": "<id returned by result_recovery_prepare>"}
}
```

After client rejection or disconnect, read that ID through `result_recover`.
Without a pre-reserved ID, call `result_recover({})` for an index of up to 64
retained IDs, states and tool/request correlation. It contains no arguments or
output. Request IDs whose JSON encoding exceeds 200 bytes are represented by `requestIdHash`
(SHA-256 of JSON-encoded request ID), never a silently truncated ID. Session IDs
are similarly represented by `sessionIdHash`. Do not guess between concurrent
calls; inspect correlation or read the candidate receipts. Reservations are single use. Reusing one, using an expired/released ID or an ID
from another controller fails closed before dispatch. This is not a durable
idempotency key or retry API. An unknown ID never authorizes a fresh execution.
`result_recovery_release` frees a completed or unused slot and cannot release an
active invocation. The index permits discovery even when the whole response is rejected; a
pre-reserved ID provides unambiguous correlation before dispatch.

Retention is up to 15 minutes after completion and at most 64 slots. Oldest
completed results may be evicted to admit a new call; active/unused reservations
are pinned until completion/expiry. If all slots are pinned, new admission fails
before dispatch. Read/release tools do not consume result slots. Paging is
bounded, but retained receipt memory scales with the original output size; this
is not a storage quota or a substitute for durable large-output jobs. Controller
restart/crash, expiry and eviction can make memory recovery unavailable. Absence
always means inspect existing durable evidence, never replay. Use `job_start`
with a stable agent idempotency key and `job_output` for restart-safe execution
and complete durable output.

This wave does not implement a durable batch manifest, operation fingerprint,
per-item restart reconciliation, crash/power-loss result delivery, ContextKeep
receipt reconciliation (R05), journal/index/watcher optimization (R06–R08), or
full client/platform qualification (R09–R12). Those require separate acceptance;
controller-memory recovery is not evidence that they are complete.

Controller compaction is compatible with existing agent result fields. The
source-side UTF-8 fix requires the updated agent; a new controller cannot
reconstruct codepoints already replaced by an older agent. Agent/controller
rollout and live acceptance remain separate from source tests.
