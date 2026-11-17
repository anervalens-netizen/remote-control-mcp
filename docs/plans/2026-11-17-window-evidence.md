# OBS-04 → HIS-02 bounded-window source evidence

This is public contract and synthetic fixture coverage, not a deployment record
or acceptance of an installed console/runtime. OBS-04 and HIS-02 remain active.
The [ingress contract](../INGRESS-OBSERVABILITY.md#public-same-window-workflow)
defines the API, counting boundaries, trust boundary and capacity limits.

| Source | Contract / synthetic evidence |
|---|---|
| `apps/mcp-server/src/usage-tools.ts` | Additive public SDK `usage_window`; canonical device plus explicit identity; shared five-second read budget, bounded close-page draining and retry on a deferred close; old agent and identity mismatch classification; default `usage_report` retains its old query schema. |
| `apps/mcp-server/src/usage-windows.ts` | Same-instance sequence denominator, original bounded envelopes, immutable conflicts, invalid/duplicate events, missing detail and advertised agent-ring loss, exact arithmetic residual, late dispatch receipts, restart/expiry discontinuity, UTC boundaries and separate historical coverage. |
| `apps/mcp-server/src/agent-dispatch-observer.ts` | Capture at start/response/finish before global ring eviction; fixed route families; diagnostic subscriber faults cannot fail workloads and invalidate collection coverage. |
| `apps/agent/src/ingress-observer.ts`, `ingress-http.ts`, protocol correlation schema | Additive `windowCollectionVersion: 1` and optional `sampleAfterSequence` filter; bounded 32-event HTTP pages; existing unfiltered defaults and aggregate/recovery persistence unchanged. |
| `tests/usage-window.test.ts` | Actual SDK catalog/results and isolated HTTP hooks; pre-existing sample history; exact opening/closing boundary; original envelope preservation through unrelated-target churn; direct/unassigned traffic; incremental collection; burst loss; slot/detail overflow and TTL; wrong device/identity; old agent and malformed data; agent/controller restart; conflicting/duplicate/invalid metadata in both orders; late/cancelled receipts and cancelled close; subscriber failure isolation. |
| Existing ingress/usage/SDK suites | Snapshot compatibility, authentication/privacy, outcomes, persistence/restart and bounded output schemas. Catalog cardinality assertions deliberately include the additional tool and explicitly assert its presence. |

All fixtures use generic synthetic device labels, UUIDs and isolated memory or
temporary state. Operational tests own their exact fixture processes. Real
service-manager integration suites are excluded from the bounded local
qualification scope; they require separate authorization. Type checking,
privacy checks and console build remain required alongside these suites.

## Explicit remaining limits

- No console implementation or acceptance; HIS-02/UX-07 remain open.
- No deployed/native-platform, connector-host or private recent-window
  qualification in this source lot. No runtime, production data, REC-05 fence,
  original recovery record or installed service is changed.
- No window durability/export, background polling, multi-agent aggregation or
  automatic resumption. Controller restart/expiry loses retained windows.
- Each individual collection reads at most 32 current event samples. Close drains
  up to ten pages within five seconds, deferring the boundary if a retrievable tail
  remains. A burst may still outrun polling; 128-arrival agent-ring loss and
  256-entry window limits stay explicit.
  Late agent event collection after close is unsupported. Retained late
  dispatch receipts/finishes may improve attribution without moving boundaries.
- No source attestation, authenticated caller origin, authorization, execution
  success, client acceptance or effect verification from shared bearer or
  correlation. A zero arithmetic residual does not certify full collection.
- Historical persistence gaps do not automatically invalidate current hooks;
  undetectable observation loss between reads cannot be reconstructed.

## PR57 follow-up verification

The first DSH review of head `8cbcb9d` identified four follow-ups. The
corrections isolate the legacy usage_report input from the new agent-only
sequence cursor, classify valid wrong-identity snapshots independently, drain
up to ten pages in one five-second close budget with safe deferred retries, and
move route assertions out of a detached HTTP request callback. Regression
tests explicitly exercise a strict old-agent query, wrong identity, 100-event
tail, deferred/retried close and the user-service route.

Isolated HP source verification after these edits: TypeScript passed; focused
four-file suite 63/63; broad suite 187 test files passed, 8 skipped and 1,487
tests passed, 65 skipped; two privileged systemd suites excluded. Public-data
guard and history regression checks passed (514 files; zero issues); console
build passed. These are local source tests, not installed runtime qualification.

Next engineering gate: commit and publish exact-head candidate, obtain current
Codex Connector + DSH reviews and required CI, publish version-bound review
dispositions and verify review-task closure. Then qualify an explicitly
configured deployed route privately before changing acceptance status.
Console implementation remains a separate next scope.
