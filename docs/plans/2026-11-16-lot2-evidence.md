# Lot 2 engineering evidence

Status: the initial and revised source candidates have completed exact-head reviews and CI. The final corrected candidate has passed its combined local gate; its exact-head reviews, CI, merge and deployment remain pending. The previous qualified runtime source is still `9682af5bd2e6e4ae658dfdbcd55532f9ba5cdd32`. This file contains synthetic engineering evidence only. Actual inventories, measurements, execution IDs and operational receipts remain private.

## Changes and finite scope

| Work item | Change | Remaining acceptance |
|---|---|---|
| OBS-01 | Mapped controller HTTP/stdio, direct clients, raw streaming, direct transfers, relays/proxies and Android boundaries. | Unknown original callers and uninstrumented proxy hops remain explicitly unassigned. |
| OBS-02/03 | Strict correlation, response receipts, all-ingress counters and HTTP lifecycle separation. | Deployed correlation/identity checks; agent-to-agent parent propagation is not added. |
| OBS-04 | Bounded library primitive for same-window sample reconciliation, duplicate/conflict handling and conservation residuals. | The public tool still returns separate snapshots. A bounded operator collection/reconciliation workflow and private deployed-window qualification remain open; tracker state is active. |
| OBS-06 | Existing ContextKeep association propagates as diagnostic UUIDs without lease tokens or new attachments. | Deployed task-linked read canary. |
| HIS-01/02/04 | Independent bounded daily aggregates, restart/corruption coverage and authenticated usage_report pages. | Console extension, operational pressure measurements and the complete history acceptance. Unsupported dimensions stay explicit. |
| HIS-03 | Bounded private assessment distinguishes existing terminal evidence, stale running metadata, lost references, missing metadata and uninspected identities. | This is a retained-history snapshot; it does not establish historical quiescence or automatically reconcile every reference. |
| INV-03 | Finite capability endpoint timeouts and caller cancellation, including queued work. | Private bounded fleet qualification and measured backoff decision. |
| INV-04 | Generic source/worktree/immutable-release guide and private preserved-workspace mapping. | Final publication and handoff synchronization. |
| UX-03/MCP-03 | Shared fs_read/batch_read mode validation and advertised field meanings. | Deployed connector read qualification; broader usability/discovery acceptance remains open. |

The [initial review disposition matrix](2026-11-16-lot2-review.md) tracks all sixteen observations, their corrections and remaining scope.

See [ingress observation contracts](../INGRESS-OBSERVABILITY.md) and [workspace/release evidence](../WORKSPACE-AND-RELEASES.md). The original historical REC-05 incident, its uncertain fence and saved recovery intent remain separate. No result here establishes historical quiescence or authorizes replay.

## Reproduced defects and regressions

- Six incompatible versioned/expectedVersion line/tail combinations returned HTTP500 before the correction. Shared schema checks now return agent HTTP400 before file access, and SDK single/batch calls reject them before dispatch. Valid byte paging, zero-byte metadata, sourceVersion, eof, UTF-8 and line continuation remain covered.
- The capability report lacked a finite endpoint budget and ignored caller cancellation. A real stalled HTTP fixture with generic deadlines disabled now returns bounded partial evidence. Cancellation prevents queued devices from starting.
- A local HTTP close with status200 was previously counted using only the status code. Actual MCP SSE interruption now records incomplete connection closure and increments the failure count. Normal finish followed by close counts once; client acceptance remains unknown.
- Disabled sample detail could return a repeated zero cursor. The report now returns a terminal null cursor.
- Conflicting duplicate event/dispatch bindings could depend on delivery order. They now remain unattributed, with explicit conflicts and unchanged request totals. Malformed dispatch metadata is rejected without aborting reconciliation.
- A FIFO aggregate path could block agent startup. The reader opens nonblocking where supported, then rejects nonregular files. Corrupt temporal state and descriptor-close failures are contained before loaded state is applied. Original evidence remains untouched and memory counting continues.
- A hook exception no longer leaves a misleading complete-coverage claim. The workload response remains available while the report identifies the missing observation.

## Review correction qualification

Confirmed review defects were reproduced before correction. Focused regressions now cover graceful signal shutdown and failed binds, concurrent and orphaned aggregate writers, explicit counter/history scopes, ordinary abort deduplication, missing writer claims, partial usage reports, bounded/deduplicated capability selection, timeout versus caller cancellation, SDK single-read cancellation, pathname-only route categories, truncated JSON transport, raw-file completion and unconsumed-body cleanup. Actual controller HTTP tests cover finish, premature response close and request abort.

The writer guard intentionally does not reclaim a claim after an abrupt crash. It persists across later restarts until ownership is inspected. History stays readable and current observations continue in memory while persistence reports unavailable and required repair. Valid retained state also reports an explicit unknown-continuity interval. The contract includes a bounded maintenance procedure; automated recovery remains part of HIS-01/HIS-04 acceptance.

The retained-reference assessment and bounded synthetic collection/reconciliation cost experiment are complete in private evidence. Neither establishes a fleet-wide active-job count, production overhead, a before/after speedup or a historical SLA. The repeated UTF-8 capability probe is recorded as a conditional PERF-02 measurement opportunity.

## Synthetic verification

| Suite or scenario | Evidence at this source checkpoint |
|---|---|
| fs_read mode/relay/usability checks | 59 targeted tests passed; actual agent and stateful/stateless JSON/SSE SDK paths exercised. |
| Actual spawned agent ingress | Fourteen fixture reads: nine HTTP400 and five HTTP200, matching runtime instance/identity; no path payload leakage. |
| Aggregate persistence core | 22 tests passed, including reproduced FIFO, invalid timestamp/calendar and close-error cases, rollover, restart and publication failure. |
| Ingress HTTP/SDK integration | 20 tests passed; sampling rollover, denied/direct requests, batch dispatch, conflict ordering, cancellation, usage pages and hook failure covered. |
| Raw streaming | 17 new cases plus ten existing raw-read regressions passed. |
| Capability probes and related inventory/runtime regressions | 46 targeted tests passed. |
| Controller HTTP delivery | Actual SSE interruption and finish/close deduplication passed. |
| Modern SDK input validation | One supplementary regression passed using the official modern client and protocol 2026-07-28: invalid single/batch inputs dispatch zero requests; valid versioned paging dispatches exactly once. Application source is unchanged from the combined gate. |
| Initial complete local run | Privacy/build/typecheck passed. Twelve tests failed: two expected catalog-count updates and ten timeout cases under unrestricted parallelism; an associated timed-out cleanup also reported an error. The original logs are preserved. |
| Failure qualification | All 115 tests in those ten files passed with four workers, unchanged timeouts and assertions. Exact catalog count is now 105 and usage_report presence is asserted. |
| Initial candidate combined local gate | Passed: privacy guard, console build, typecheck, 1,396 tests passed and 88 explicitly skipped across 187 files, staged/full-history privacy checks and diff checks. Two workers bounded resource contention; no timeouts or assertions were weakened. All 486 non-Markdown source files were unchanged during the gate. |
| Initial exact-head reviews and CI | Candidate `162ab38` passed all four CI checks: Linux 1,421 passed / 64 skipped; targeted Windows 223 passed / 41 skipped. Codex reported no findings; [DSH reported sixteen observations](https://github.com/anervalens-netizen/remote-control-mcp/pull/55#issuecomment-6929748128). The sixteen observations have explicit dispositions and confirmed defects are corrected. These initial results do not certify the revised candidate. |
| Review correction focused regressions | Agent lifecycle/persistence 31/31; transport 31/31 plus 42/42 existing regressions; usage/cancellation/capabilities 48 tests passed across overlapping scoped runs. Type checks and diff checks passed. The revised combined gate below covers these corrections. |
| First revised combined gate | Stopped at the publication scanner before build/tests: one static test fixture credential was flagged. The fixture now generates credentials at runtime; privacy checks and all nine lifecycle cases pass. The original failed gate is preserved and the guard is unchanged. |
| Revised combined gate | Passed: privacy scanner (508 files, zero issues), console build, typecheck, 1,454 tests passed and 65 explicitly skipped across 193 files, staged/full-history publication checks and diff checks. All 492 non-Markdown files were unchanged before and after the gate. Two workers bounded resource contention without changing test timeouts or assertions. |
| Revised candidate review and CI | Candidate `f9dd57e` passed all four CI checks: Linux 1,455 passed / 64 skipped; targeted Windows 223 passed / 41 skipped. Codex found a live-PTY shutdown case; its local correction is qualified below. [DSH reported fourteen additional observations](https://github.com/anervalens-netizen/remote-control-mcp/pull/55#issuecomment-6931010895), including an unbounded-close variant and writer error paths. Dispositions and corrections are recorded in the review matrix. These results apply to this source checkpoint, not the later corrections. |
| Live PTY shutdown correction | Both SIGTERM and SIGINT reproduced an agent that stayed alive after HTTP cleanup. Explicit process exit now follows completed `app.close()` cleanup and preserves failure exit status. Two real Linux PTY cases and nine lifecycle cases pass; the original marked PTY exits, the aggregate has a clean marker and the writer claim is released. Typecheck passes. No durable-job code or process-tree termination logic changed. |
| PTY-only combined local gate | Passed all seven stages: 1,456 tests passed / 65 skipped across 194 files, with all 493 non-Markdown files unchanged. This earlier gate does not qualify the subsequent shutdown/writer corrections. |
| Shutdown/writer follow-up regressions | Real shutdown/PTY/lifecycle cases 14/14; observer/lifecycle/writer faults 40/40; report/capability cases 20/20. Type checks and independent source reviews passed. Counts overlap and are not additive. |
| Relay fixture under restrictive permissions | The original fixture reproduced 15 passes and one failure with `umask 0077`: creation masked the intended destination mode. The fixture now explicitly sets its existing destination to `0640` on POSIX; source mode `0600` and strict preservation assertions remain. All 16 cases pass under both `0077` and `0022`. Application code is unchanged. |
| Final corrected combined local gate | Passed all seven stages: publication scanner (511 files, zero issues), console build, typecheck, 1,472 tests passed and 65 explicitly skipped across 196 files, staged/full-history publication checks and diff checks. All 495 non-Markdown files were unchanged before and after the gate. Two workers bounded resource contention without changing assertions or timeouts. |
| Final corrected candidate reviews and CI | Pending. |
| Deployed behavior and same-window report | Pending. |

Test counts are scoped runs and must not be added together: suites overlap. Skipped native/platform tests are not passes. The final source identity and qualification summary must be recorded before rollout.

## Preservation and rollout requirements

Keep both author and committer on noreply identities. Preserve the normal staged/full-history publication checks. Use the shared review-cycle helper, current head/base bindings and explicit dispositions for both review sources; verify the grouped private review task after closure.

Promote an immutable, manifest-verified release through a new guarded attempt with independently recoverable receipts. Preserve recovery journals and state roots. Verify selected process paths, agent/controller identity, fs_read validation, correlation receipts, bounded report coverage and original uncertain evidence after restart. Do not reuse old rollout plans or infer completion from an interrupted tool response.
