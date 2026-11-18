# RC26-OBS-04 — two-agent same-window reconciliation evidence

The [multi-agent regression](../../tests/usage-window-multi-agent.test.ts) uses the real MCP HTTP controller handler, two independent Fastify ingress observers with different runtime instance IDs and identity contexts, and a real initialized MCP SDK client. All bearer tokens, host names and processes are synthetic.

## Cases

| Fixture | Verification |
|---|---|
| Two overlapping windows, alpha/root and beta/owner | The controller returns different window IDs and instance IDs; each denominator and event stream is tied to its own agent and identity. |
| Controller-to-agent traffic | Explicit controller-originated requests on each peer appear as attributed dispatches; individual per-device dispatch counters are inspected independently. |
| Direct traffic | Authenticated direct requests and a rejected unauthenticated request count as ingress but remain unattributed to controller dispatch. No user identity is inferred from a bearer. |
| Arithmetic reconciliation | In both fully observed windows, agent ingress equals attributed plus unattributed plus explicitly measured collection residual (zero for these fixtures). |
| Cross-device/identity access | Reading the other target's window or using the wrong identity is refused before an agent request is sent. |
| Closed window reads | Retained reports can be read without generating new agent ingress or changing the originally recorded denominator. |

The new tests assert `complete: true` only for the two synthetic windows with retained details and unchanged agent instances. They do **not** assert a global fleet completeness score; a controller's successful HTTP calls are not equivalent to verified effects or client acceptance.

## Remaining acceptance

- No automatic fleet-wide aggregator, background polling, or cross-instance persistent window. Current API deliberately measures one canonical device and identity per window.
- No live paired window was collected across installed HP and Server owners in this test; the selected earlier live Linux single-route qualification remains a separate checkpoint.
- The currently exposed ChatGPT plugin catalog must be checked for `usage_window` availability; native SDK tool acceptance does not prove host-provided tool discovery or compatibility.
- Real traffic pressure, counter-ring evictions and agent restarts require source- and instance-bound evidence. Existing individual-window tests cover these as synthetic cases; this extension only qualifies independent peers.
- The source controller, agent and report evidence are diagnostic. Bearer possession and caller-declared correlation do not attest a person's identity or prove execution effects.

Therefore **OBS-04 remains active**, not verified, until multi-host and supported-client acceptance is recorded. The fixtures do not change production behavior or release configuration.
