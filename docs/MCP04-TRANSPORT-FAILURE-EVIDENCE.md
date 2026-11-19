# RC26-MCP-04 — lost-result transport tests

The [MCP-04 test](../tests/mcp04-lost-response-protocol.test.ts) starts the real MCP HTTP controller handler against a synthetic Fastify agent and a test-only bearer. **No installed host job is started.** The synthetic agent records each committed job-start effect.

| Transport | Fault | Recovery | Synthetic starts |
|---|---|---|---:|
| Initialized SDK Streamable HTTP | Custom fetch drops the already-completed job_start HTTP response before returning it to the client | New SDK client queries the original idempotency key, then the recovered job ID | 1 |
| Legacy initialized stateful SDK session | Lost completed job_start reply, then explicit DELETE of the original MCP session | Fresh initialized session gets a new session ID, old one returns HTTP 404, original durable key still resolves | 1 |
| Modern stateless JSON (2026-07-28) | Completed initial response discarded | Separate JSON-RPC call ID queries original key | 1 |
| Legacy stateless SSE | Completed initial response discarded | Separate JSON-RPC call ID queries original key | 1 |

The test covers transport framing, actual controller routing, the keyed status contract and synthetic effect conservation. It never retries the original effect to recover a lost response. A response dropped after server completion is **not evidence of client acceptance**.

Selected earlier native HP tests independently confirmed that cancelling job_wait does not cancel its durable job, that a new authenticated SDK client can read its original ID and observe normal completion, and that an explicit job_cancel terminates its selected test job. Those are distinct from losing the first job_start result.

## Selected installed-host acceptance

A controlled native Linux canary intentionally withheld the completed HTTP
start response from an authenticated legacy SDK client. A new legacy session
and a modern SDK client independently resolved the same original durable key
in parallel. The recovered job exited normally, its output read was complete,
and a separate read of the synthetic marker found one write. The client sent
one start. The earlier wait cancellation and explicit job cancellation checks
remain distinct from this producer-side delivery-loss test.

This completes selected Linux and supported synthetic HTTP transport acceptance
for MCP-04. Other installed hosts, physical Windows and platform-wide reconnect
coverage remain with MCP-05. The evidence supports inspection of the original
execution and gives no basis to replay or release a historical uncertain effect.
The [official multiple-stream check](RELIABILITY.md#official-http-conformance-sample)
passed on both supported HTTP protocol revisions in the isolated controller.

## CI dependency provenance

One Windows hosted CI attempt failed before tests because Chocolatey timed out
reading the community V2 package feed for ripgrep. A second rerun failed at
the same external installation step. The Windows CI workflow now installs the
official ripgrep 15.2.0 Windows x64 GitHub release archive with a pinned
SHA-256 (71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5),
checks the archive before extraction, and exposes only the verified rg.exe
directory to subsequent steps. The archive hash and ZIP path were verified
independently against upstream GitHub release metadata and a downloaded copy.
This is CI dependency hardening, not a change to installed agent behavior.
