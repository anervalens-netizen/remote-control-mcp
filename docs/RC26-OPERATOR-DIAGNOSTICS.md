# RC26 consolidated operator diagnostics — source contract

This page describes the source for consolidated Batches A and B. Deployment, ChatGPT catalog refresh, and native startup-target verification require separate evidence.

## 1. Read-only device doctor (UX-01, TMO-02)

`diagnostic_doctor` selects a canonical device, probes configured root/owner/interactive identities in parallel, and optionally reads graphical-session status. A Linux owner endpoint with the advertised desktop
capability can supply graphical-session status even without a separate interactive
URL. Its capability and session requests share the owner probe budget. If a
requested configured graphical route lacks readiness evidence, the summary
stays partial even when shell agents are ready. It does not capture a screenshot, send native input, execute a command, restart a service, or infer the power state of an unreachable machine. Each stage publishes its source, observation time, elapsed duration, status and a stable cause code. Controller readiness and optional graphical prerequisites remain separate.

The graphical session and agent information probes start together, so a stalled UI collection does not serially consume a second probe interval. Native engine identity is not manufactured from a generic accessible desktop; when a semantic-desktop capability is advertised, that is labeled a reported capability rather than a verified engine binary.

## 2. Runtime-version matrix in existing capability report (INV-01/02)

`capability_report` retains its legacy `items[]` and `endpoints` contract, adding `versions.root`, `versions.owner` and `versions.interactive` for configured endpoints. The runtime SHA comes from the actual agent `/v1/info` response. A matching SHA, `pinned_manifest` binding and `pinned_integrity` set `locallyPinnedAtStartup=true`; upstream verification remains **false**, and post-start integrity is not inferred.

The optional private `RCMCP_VERSION_EVIDENCE_FILE` contains operator-supplied release declarations. It is **not** automatically populated and is never treated as evidence of a live service-unit or install-directory inspection. An absent file leaves desired/installed/startup unknown; invalid or symlinked files fail closed. The path and raw parse errors are never returned. A mismatch means a difference between recorded declarations and observed running SHA, not independently verified service drift.

### Synthetic example (no private hosts or credentials)

```json
{
  "version": 1,
  "devices": {
    "example-primary": {
      "role": "primary",
      "root": {
        "recordedAt": "2026-11-18T00:00:00.000Z",
        "desiredSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "installedSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "startupTargetSha": "cccccccccccccccccccccccccccccccccccccccc"
      }
    }
  }
}
```

Supported roles are `primary`, `backup`, `intermittent`, `retired`, and
`test`. Roles are separate from automatic probe policy, physical power state,
and readiness. Use the native checks below when deciding whether a declared
version is still current.

### Capture Linux startup and installed evidence

Run [the bounded systemd inspection](../scripts/inspect-linux-startup.py)
locally on an explicitly selected Linux host. Pass the loaded unit names and use
the `user:` prefix for a unit managed by the current user's service manager.

```bash
umask 077
python3 scripts/inspect-linux-startup.py example-agent.service user:example-owner-agent.service > startup-observation.json
```

The command records the loaded direct Node entry point and separately reads the
current main process entry point. It also verifies the selected entry bytes
against their checksum in the local manifest. A loaded and a running entry point
can differ even while the agent reports ready. Compare this snapshot with the
authenticated running identity and the approved release separately. The command
reads no unit environment or credentials, runs no service actions, and supports
direct Node and simple `/usr/bin/env` entry points. A wrapper, missing manifest
or unreadable process yields unknown evidence for the affected layer. The entry
checksum covers one file. For source and full listed-file verification, use the
[release workflow](WORKSPACE-AND-RELEASES.md#verify-and-activate-a-release).

On Windows, compare task and logon launchers with process evidence. A scheduled
task can be loaded while its wrapper's effective entry point remains unknown.
Use the Android status tool for the authenticated running companion's reported
application version. Desired build, installed APK identity and future startup
remain separate and require their own evidence. Keep native output and fleet
mappings private. This command runs on demand without adding remote probes or
service polling.

## 3. Job status guidance with existing tools (UX-05/06)

`job_status`, `job_wait` and `job_output_since` retain their durable identities and existing output schemas. An additive `progressGuidance` contains the observed state, whether a terminal record exists, a truthful cancellation/termination status, a recommended next read, and the original job's retry interval when still active. `inputWaitEvidence` stays unverified unless a future agent supplies explicit typed evidence. `completionPercent` is deliberately `null`: silence and elapsed time do not prove a hang or progress fraction. Exit code 0 is not independently verified application effect.

| Operator intent | First call and follow-up |
| --- | --- |
| Read a file or inspect the endpoint | Use `fs_read` or `diagnostic_doctor`. Use owner for an owner-readable file and root only when the target requires that identity. Keep the original identity on continuation reads. |
| Inspect a graphical session | Use `diagnostic_doctor` with graphical collection enabled. Choose the configured interactive route, or the owner route when it advertises desktop capability. |
| Run a short effect whose response must survive disconnect | Reserve through `exec_prepare` and retain the execution ID before the call. After lost delivery, use `exec_recover` on that identity. The receipt can recover evidence of the initial execution. |
| Run variable-duration work | Use a keyed `job_start`, retain its identity, then use `job_wait`, `job_status` and `job_output_since`. A wait can end while the original job continues. |
| Inspect a fenced repository operation | Use `inspect_recovery` with the original reference. A failed checkpoint receipt describes the diagnostic and the held fence. |

Controller-memory result recovery pages retained data. Agent-disk foreground
receipts retain execution evidence. A durable background job owns execution
independently of the request. Recover uncertain operations through their
original handles and keep the same device and identity.

## 4. Bounded timing (OBS-05)

The existing `ToolDiagnostics.snapshot()` exposes `stageMeasurements` over
the retained controller trace ring. Each stage reports observed and missing
trace counts, calls and measured p50/p95. Missing stages have null percentiles.
Queue time remains null. Agent request includes remote handling and may overlap
execution wait. Result preparation and final validation are local stages.
Remote serialization and client receipt remain unobserved.

For an optional future mapping, use the
[OpenTelemetry MCP development convention at revision 76e0c19](https://github.com/open-telemetry/semantic-conventions-genai/blob/76e0c19e7fe11dc693fe258642363a438af4d3aa/docs/gen-ai/mcp.md).
A server operation for a tool call would carry `mcp.method.name=tools/call`
and `gen_ai.tool.name`. Attach `mcp.protocol.version` only when the transport
actually observed it. The internal stages are separate timings. In particular,
the controller handler timer cannot substitute for end-to-end MCP server
operation duration. Optional trace export is deferred until an operator needs
cross-service tracing beyond the existing diagnostics. The current path has
no exporter dependency.

## 5. Read batching (UX-04, BASE-03)

The existing `batch_read` tool remains the supported facility. A synthetic SDK contract test checks that four per-item root/owner reads and a missing-file error are preserved with bounded concurrency 2. In that **specific fixture**, the client sends four sequential MCP calls versus one `batch_read` call; this is not a claim of a measured production latency reduction. Dependent operations, writes and incident recovery stay sequential.

## 6. Existing MCP Apps console (UX-02/07)

Select a Fleet device, then use **Check endpoints** to run the same bounded
read-only doctor. Each row gives the route or prerequisite, cause, source and
time. Failed refreshes label earlier observations as cached. Use the selected
identity for new reads, and retain the original device, identity and ID for job
inspection.

The job details show the exit record, termination evidence, last output,
observed byte counts and the next read. Request-handler state, execution,
verified effect and client acceptance appear as separate facts. Output pages
still require an explicit read. Clients without Apps use `diagnostic_doctor`
and the existing job status, wait, output and lineage tools.

In the selected ChatGPT host, **Refresh tools** restored access to the app
doctor after the controller upgrade. Reopen the console from the refreshed
catalogue if an existing panel cannot reach the doctor.

Open **Usage coverage** for the selected device and execution identity.
**Read daily history** shows the retained UTC cohorts, configured retention and
gaps from `usage_report`. Read older cohorts with **Read older days** while the
agent returns a continuation offset. The producer's identity must match the
selected route. **Read usage window** displays the original bounded window for
a supplied `usage_window` ID, including the denominator, unmatched observations,
residual, missing details and last recorded collector status. The panel reads
only on request.
To open, collect or close a measurement, use `usage_window` itself.

## Remaining acceptance

Selected native Linux pairs and the selected authenticated ChatGPT console
have qualified. The [client matrix](RELIABILITY.md#mcp-sdk-compatibility-matrix-r11)
records the remaining transport and host gaps. The
[paired B01–B07 fixture evidence](plans/2026-11-16-implementation-evidence.md#paired-qualification)
and the [isolated ingress pressure check](INGRESS-OBSERVABILITY.md) cover
the scoped behavior. Automatic installed/startup evidence and extended
deployed history remain open. Review, CI, merge and deployment each
require their own evidence.
