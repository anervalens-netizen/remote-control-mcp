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

## Still unverified

- Deliberately losing the first job_start response on the actual installed host and recovering its durable identity without reading private service credentials.
- A legacy initialized SDK session replacement is now covered synthetically (lost first result, session terminated, old session HTTP 404, new session retrieves the same keyed job). The complete SSE stream-closure/interruption and multi-client interleaving matrix remains unverified.
- Cross-version and cross-host process/effect counting, restart durability, and concurrency under real client reconnects.
- Actual ChatGPT-host catalog refresh and client compatibility for all newly implemented tools.

Therefore **MCP-04 remains active**, not verified. These test-only changes add no workload retry or production behavior and do not authorize clearing historical uncertain coordinator operations.
