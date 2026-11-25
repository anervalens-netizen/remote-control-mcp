# Skills, durable Tasks and file exchange

The HTTP controller serves the modern `2026-07-28` protocol beside existing
legacy MCP sessions. Native extensions are negotiated per request. Existing
job, filesystem, transfer and recovery tools retain their contracts.

| Capability | Server implementation | Compatibility behavior |
| --- | --- | --- |
| Skills | Official SDK Skills extension; `skills/list`, `skills/get`, directory and resource reads; immutable SHA-256 manifests | The same skill document is a literal resource on legacy clients |
| Tasks beta | `job_start` can return a flat `resultType: "task"`; `tasks/get`, `tasks/update`, `tasks/cancel` | Clients that do not declare Tasks receive the existing job receipt |
| Files draft | `file_upload`, `upload_required`, authenticated binary upload and download | Small inline files work without the extension; ChatGPT/Codex use `file_receive` |
| OpenAI attachment input | `file_receive` declares `_meta["openai/fileParams"]` and the full attachment schema | The host supplies `download_url` and `file_id`; optional `file_name` and `mime_type` are declared |

Sources: [Skills](https://modelcontextprotocol.io/extensions/skills/overview),
[Tasks](https://modelcontextprotocol.io/extensions/tasks/overview),
[Files draft](https://github.com/modelcontextprotocol/experimental-ext-file-uploads/blob/8a859b8f268926fe4beb84d78565e7cc6f9fa617/specification/draft/file-uploads.md),
[OpenAI file APIs](https://developers.openai.com/plugins/reference#file-apis).
Files is experimental. Product availability and protocol maturity are separate;
server support does not establish that a particular host imports skills,
drives Tasks or renders a file picker.

## Durable Tasks

Send `io.modelcontextprotocol/tasks: {}` under
`params._meta["io.modelcontextprotocol/clientCapabilities"].extensions`.
For `job_start`, the controller persists its handle key before dispatch and
then returns an authenticated handle bound to the canonical device, execution
identity, configured endpoint, principal and durable job ID. The existing
executor owns the process and recovery history. There is no second worker or
execution queue. Controller restarts preserve the handle key.

`tasks/get` returns the executor's current state. A successful or failed shell
command uses `status: "completed"` and the original tool-level `isError`
distinction. A `lost` receipt remains an explicit uncertain tool outcome. A
shell exit marker alone is not promoted to a terminal receipt. Output is
bounded and includes the cursor and job reference for `job_output_since`.
`tasks/cancel` acknowledges a request; termination is established by a later
executor observation. These shell jobs do not request input, so `tasks/update`
rejects unsolicited input. No additional user confirmation is introduced.

Every Tasks method requires the extension in that request and `Mcp-Name` equal
to `taskId`. Missing capability returns `-32021`; an unknown or altered handle
returns `-32602`. Legacy `tasks/result`/`tasks/list` and task-status subscription
notifications are not advertised. Existing ContextKeep execution events remain
independent and unchanged.

SDK 2.4 handles modern framing, authentication preconditions, envelope and
input/output validation. Its custom-method API registers the three Tasks
methods. Its tool-result codec does not yet contain the beta `task` and draft
`upload_required` variants. A narrow encoding adapter converts only those
internally generated results after the SDK validates the tool call. Other
tools retain the normal progress/cancellation behavior. Negotiated Tasks use
JSON responses and do not emit unsupported task progress notifications.

## Files

`file_upload` accepts a top-level `file` object with `id`, `mimeType`, `size`,
optional `name`, optional SHA-256 `digest` (`algorithm: "sha-256"`, base64url
value) and optional base64 `data`. Its JSON Schema carries `x-mcp-file`.
Limits are **150 MiB per file** and **1 MiB total inline data**. A zero-byte
file requires no transfer. Inline size and every supplied digest are verified.

For out-of-band uploads, the client declares Files `upload: {}`. The server
returns one authenticated PUT target under the MCP address, plus an opaque
`requestState` valid for one hour. The client uploads all bytes, then repeats
the exact tool and arguments with that state. The state binds all arguments,
the authenticated principal, target and expiry. Altered, expired and consumed
states fail; a retry never issues a second upload target. The server confirms
length and digest on a sealed copy before atomically consuming the state and
publishing the immutable artifact. Concurrent retries can finalize only once.

Native uploads use the same output validation, observation and retained-result
wrapper as other tools. For inline uploads, `resultRecoveryId` is consumed once
before writing. For out-of-band uploads, that explicit reservation is held for
the exact-arguments finalization call; the preparatory `upload_required` uses a
separate automatic staging receipt. Its reference appears in
`_meta["io.remote-control-mcp/resultRecovery"]`. If that response is lost, list
`result_recover` receipts and use the request correlation to read the retained
`requestState` and transfer target. Recover the original finalized artifact by
the explicit ID if the final response is lost. Do not replay either step to
discover its outcome. Recovery receipts remain controller-memory data with the
existing bounded retention; upload state itself persists across restarts.
An explicit final reservation must be finalized within its fifteen-minute
retention and the same controller process. Persistent upload bytes do not make
an expired or pre-restart recovery ID valid, and never authorize a replay.

`file_receive` is the practical OpenAI attachment path. The controller fetches
the host-supplied URL over HTTPS, pins a checked public DNS answer, refuses
redirects and private/special network targets, sends no cookies or MCP bearer,
limits bytes and time, and checks an optional expected SHA-256. Both paths
return the same artifact identity, digest and controller path. They do not
import data, install software, execute file contents or overwrite a user file.

`file_download` returns the existing artifact receipt. Only a client declaring
Files `download: {}` receives a target in
`_meta["io.modelcontextprotocol/files"].downloads`. Upload and download routes
apply the same bearer and Origin checks as MCP. Downloads return inert binary
content with `nosniff` and no shared caching.

Configure `RCMCP_MCP_EXTENSIONS_DIR` as a private, persistent absolute directory
outside the release. The default is `.remote-control-mcp/mcp-extensions` in the
controller account's home. The current persistence contract uses a private
POSIX directory, exclusive creation, no-follow reads, file and directory
synchronization. Keep this directory and its handle key stable across releases;
do not point test servers at it. File artifacts expire after seven days;
upload staging expires after one hour. Cleanup is opportunistic every minute,
with a grace period for transfers. Corrupt metadata is retained for inspection.
The store serializes admission and limits metadata counts. The one-GiB byte
budget reserves both the retained staging file and its future finalized copy;
completed artifacts and crash-orphaned bytes are also charged. HTTPS pulls
reserve their maximum size before fetching. At most four binary transfers run
concurrently; racing finalization copies can temporarily add up to 600 MiB and
losing copies are removed before the operation returns.

The binary transfer does not put its contents in the model context. Pass the
returned path to an explicitly authorized processing or transfer operation.
Reading a file never turns text inside it into an instruction to the server.

Each receipt includes a `nextStep` for the existing `file_transfer` tool, with
the exact `sourcePath` and the remaining destination/routing fields. Select
the configured agent on the controller host and the identity that owns that
path. For example, on a controller running under the owner account of a
configured `controller-host`, transfer using `sourceDevice: "controller-host"`,
`sourceContext: "user"`, the returned `controllerPath`, and the explicitly
chosen destination device, identity and filename. Keep the returned safe
`name` when naming the destination. The existing transfer implementation uses
generation-bound reads, private destination staging and bounded relay chunks;
it does not put file bytes in a tool result. Verify the destination's SHA-256
when integrity is an acceptance requirement, then process that target with
the existing job tools. `file_download` can independently return the original
immutable artifact to a Files-capable client.

## Verification

`tests/mcp-extensions.test.ts` exercises the actual HTTP/SDK path with synthetic
files and executor receipts: catalog manifests, native negotiation, the legacy
fallback, restart-bound handles, cancellation and error semantics, token/header
isolation, inline/empty files, upload/finalize/download, changed requests, bad
digests, premature completion, racing retries, concurrent quota admission,
interactive identity routing and staging/final result recovery. The existing modern HTTP and
legacy session suites cover unchanged cancellation, recovery and tool schemas.
Live client end-to-end behavior and deployment receipts are recorded privately.
