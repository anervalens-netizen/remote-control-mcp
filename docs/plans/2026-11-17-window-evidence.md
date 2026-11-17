# OBS-04 → HIS-02 bounded-window source evidence

This is public contract and synthetic fixture coverage, not a deployment record
or acceptance of an installed console/runtime. OBS-04 and HIS-02 remain active.
The [ingress contract](../INGRESS-OBSERVABILITY.md#public-same-window-workflow)
defines the API, counting boundaries, trust boundary and capacity limits.

| Source | Contract / synthetic evidence |
|---|---|
| `apps/mcp-server/src/usage-tools.ts` | Additive public SDK `usage_window`; canonical device plus explicit identity; five-second diagnostic reads; open/collect/close/read; unavailable/old agent classification; default `usage_report` remains snapshots. |
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
- Each collection reads at most 32 current event samples. A burst may outrun
  polling; 128-arrival agent-ring loss and 256-entry window limits stay explicit.
  Late agent event collection after close is unsupported. Retained late
  dispatch receipts/finishes may improve attribution without moving boundaries.
- No source attestation, authenticated caller origin, authorization, execution
  success, client acceptance or effect verification from shared bearer or
  correlation. A zero arithmetic residual does not certify full collection.
- Historical persistence gaps do not automatically invalidate current hooks;
  undetectable observation loss between reads cannot be reconstructed.

Next engineering gate: review the committed candidate and run required CI via
the normal Codex Connector + DSH cycle when publication is separately authorized.
Then qualify one explicitly configured deployed route privately before changing
acceptance status. Console implementation remains a separate next scope.
