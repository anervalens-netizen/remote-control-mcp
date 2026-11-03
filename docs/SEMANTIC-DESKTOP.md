# Semantic desktop backend

The optional agent-desktop backend adds `desktop_observe` and `desktop_act` on
Windows and Linux. Existing UIA, batch and browser operations remain available.
The native executable is a separately versioned dependency, not a separate MCP
server. Native invocations use argument arrays, never shell interpolation.

Install a verified official archive and its helpers into an immutable directory.
The owner agent discovers its private active manifest at
`~/.config/remote-control-mcp/agent-desktop.json` on Linux or
`%LOCALAPPDATA%/RemoteControlMCP/tools/agent-desktop/active.json` on Windows.
`RCMCP_AGENT_DESKTOP_MANIFEST` overrides the path. Restart an agent after first
enabling the backend; subsequent native version changes use the atomic manifest
and need no agent restart. `RCMCP_AGENT_DESKTOP_ENABLED=0` disables it.

Only the configured owner/desktop endpoint is selected. Linux session discovery
uses the owner's active logind graphical session and its systemd user-manager
environment. The system agent is not used to simulate an owner desktop. Status
works on a headless host; GUI observations correctly fail when no desktop exists.
KDE/Wayland supports semantic accessibility where applications expose it, but
physical input and native Qt popups have upstream limitations. No physical
fallback is automatic. A configured backend is not proof of GUI readiness.

## Observe and act

Use `kind=status`, `apps` and `windows` to discover capabilities and targets.
Snapshots default to compact interactive skeletons; drill down with the returned
`observationId` and a qualified `ref`. Preserve `complete=false` and subtree
truncation. `kind=get` reads one property without a screenshot.

An action requires the observation ID, qualified ref, action and a stable UUID
`commandId`. Observations expire after ten minutes and bind the native binary,
desktop session and refs actually returned. Every action writes a durable intent
before dispatch and persists delivery before post-action observation. Repeating
the same command ID recovers its result. Different arguments conflict. An
unfinished receipt after restart is uncertain and is never replayed.
`mode=status` reads a receipt without executing. UIA and semantic operations
share the existing agent desktop sequence. Caller cancellation does not turn an
already dispatched native effect into permission to retry.

`headed=true` explicitly permits focus/cursor effects. `delivered_unverified`
does not establish application persistence. The automatic fresh observation is
evidence to inspect, not an automatic assertion of business success. Native
payloads, private state and qualification receipts must stay out of public logs.

## Release notifications and owner-requested updates

`scripts/agent-desktop-release-notify.py <private-config.json>` checks stable
upstream releases without an LLM and sends a Telegram notification only for a
new version or a check failure. It never installs software. Run it from one
systemd oneshot service every six hours. `--test` sends one deduplicated setup
message. Keep `stateDirectory`, `installedVersion`, `telegramTokenFile` and
`telegramChatId` in a private configuration file. Existing owner notification
credentials can be referenced without copying their contents into source.

The notifier reserves each message before delivery and records the returned
Telegram message ID. An uncertain delivery is retained for inspection instead
of being resent automatically. Unchanged checks send no message. The private
installed version must be reconciled after an owner-requested upgrade.

## Optional automatic dependency updates

`scripts/agent-desktop-monitor.ts <private-config.json>` runs without an LLM.
Use one systemd oneshot service as its single writer, with a recurring timer.
The configuration contains a private state directory, explicit target devices,
owner/desktop contexts, absolute Node and installer paths, and an optional
owner-local notification command. The existing private device inventory and
credentials are loaded through the normal controller environment.

The monitor checks upstream stable releases every six hours and reconciles
pending targets on each timer invocation. It verifies exact release URLs,
archive digests and GitHub build provenance with `gh attestation verify` before
dispatching a durable keyed installation job. Offline devices remain pending.
Uncertain starts are reconciled by the original job key, never replayed.
Known failed or incompatible updates are retained as blocked for investigation.

`scripts/update-agent-desktop.ts <base64-candidate-json>` is the trusted
controller-to-agent installer. The authenticated controller attests provenance;
the installer independently checks the archive digest, platform and entries.
Only the expected regular executable/helper files are accepted. JSON contracts
2.5 and 2.6 are supported; responses must match the activated manifest; a new engine major requires adapter review. These compatibility
guards do not automatically accept arbitrary future releases.

Before activation the candidate must write/read a synthetic field, invoke a
synthetic button and recover the same command after backend recreation without
a second click. The fixture closes afterward. Headless servers explicitly use
`allowHeadless` and qualify only the binary/contract. This does not certify UI
actions on a server with no graphical session.

Activation atomically swaps the private manifest and keeps `.previous` plus the
old immutable binaries. `node scripts/update-agent-desktop.ts rollback` verifies
the prior bytes and restores that manifest. Failures during activation restore
the prior pointer. Old observation IDs become stale after a native update.
Never delete action receipts to force a retry.

Notifications are persistent, deduplicated events for new releases, completion,
pending devices and failures. Notification jobs also use stable keys. The
optional `scripts/agent-desktop-notify.py` sends a local D-Bus notification in
the owner's Linux session; it sends no email or third-party message. A delivered
notification is not proof that the owner read it.

Sources: [upstream installation](https://github.com/vercel-labs/agent-desktop/blob/v1.0.2/docs/install.md)
and [JSON contract](https://github.com/vercel-labs/agent-desktop/blob/v1.0.2/docs/json-output.md).

## Linux desktop tools

The existing desktop tools also support an owner-session Linux backend. Enable
`RCMCP_DESKTOP_ENABLED=1` on the owner agent, with the verified semantic engine
manifest installed. The controller preserves an explicit desktop endpoint;
otherwise it routes to the owner agent only after verifying Linux and the
`linux-desktop-v1` capability. It never falls back to root.

Qualified desktop environments are KDE Plasma on X11 and KDE Plasma on Wayland.
Both provide monitor geometry, window enumeration/focus, screenshots, mouse,
keyboard/Unicode text, clipboard, executable launch, browser launch and batches.
Accessibility uses AT-SPI through agent-desktop; applications must expose their
controls. Linux window handles can be strings and must be passed back unchanged.
Windows-specific UIA patterns are rejected; use semantic actions instead.

Install Python 3 with PyGObject/Gio, KWin, kscreen-doctor and Spectacle. X11
physical input additionally needs xdotool. Wayland physical input requires
KWin's owner-session EIS interface and libei with text capability (qualified
with libei 1.6). No root input daemon or broad device permissions are required.
The native clipboard helper and its containing directory must belong to the
owner and must not be writable by other users or groups.

Coordinates are logical desktop coordinates, including negative monitor origins.
Captures report their origin and scale. Mixed-scale screenshot layouts currently
fail explicitly pending qualification. Locked sessions refuse input. Other
compositors are not covered by this qualification. The Linux helper is one-shot;
`running=false` is normal between operations. Input delivery is not application
effect verification: observe the result before deciding on another action,
especially after a timeout. Never blindly repeat a click.

## JSON 2.6 compatibility

Agent Desktop 1.1.0 emits contract 2.6. Snapshot flags and ambiguity refusal details pass through unchanged. A snapshot
with `data.identity_unproven=true` remains readable but grants no actionable refs;
take a new snapshot with a larger timeout. This differs from `complete`, which
describes the presented tree and does not by itself invalidate proven refs.
No automatic action retry or physical fallback is added. Fresh native state and
observation bindings follow the binary hash and contract, so observations from
an older engine cannot be used to act after activation. Contract 2.5 remains
supported for rollback. Qualification still requires real synthetic UI effects.

Upstream [JSON 2.6 migration](https://github.com/vercel-labs/agent-desktop/blob/v1.1.0/docs/json-output.md#version-26-migration).
