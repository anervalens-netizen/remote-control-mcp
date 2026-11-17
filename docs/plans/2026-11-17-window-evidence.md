# OBS-04 → HIS-02 bounded-window source evidence

This page records public API contracts and synthetic fixture coverage rather
than private deployment receipts. After the PR57 source merge, selected native
SDK window collection was separately qualified; OBS-04 and HIS-02 remain active
because fleet-wide and console acceptance is incomplete.
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
- Synthetic source tests alone do not qualify deployed runtime or ChatGPT-host
  catalog exposure. Selected native Linux SDK collection and mixed-version
  compatibility were qualified separately following the source merge; other
  client/platform coverage remains unverified. REC-05 remains preserved.
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

## Review-driven synthetic regression coverage

The `usage_window` contract is covered by synthetic fixtures for legacy
`usage_report` agent compatibility, explicitly mismatched agent identity,
a 100-event collection tail, deferred/retried close and safe HTTP service
route handling. An agent with malformed correlation metadata can supply valid
immutable event locators: collection advances past those locators while
excluding their data from trusted reconciliation. The 32-invalid-header case
ensures a full page of rejected correlations cannot indefinitely block later
event collection. Invalid, conflicting and missing details remain visible.

Full source, reviewer, CI, host and release receipts remain in private task
evidence, not in this public engineering contract. The final PR source has
green CI and a clean Codex result; DSH's final-head review was explicitly
deferred by the owner and is **not** treated as approval. Native qualification
covers a selected Linux route only. Other runtime, host-discovery and console
claims require separate evidence.
