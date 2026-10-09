# Android companion

The application identity remains `eu.astancu.rcmcp.android`; protocol version 1 remains compatible with the existing controller. Version 0.1.10-android10 (code 11) supports Android 10 / API 29 and later.

Rootless input and UI-tree observation use the owner-enabled Accessibility service. They need neither ADB nor Shizuku. Optional Shizuku shell has its own authorization and remains independent.

On Android 11 and later, screenshots continue to use Accessibility. On Android 10, start control and enable Accessibility, then press **Enable screen sharing (Android 10)** and approve the system screen-sharing dialog. A separate foreground notification shows **Screen sharing active** and provides **STOP**. Consent is never requested at boot or by a remote command. After reboot, revocation, local STOP, disabling Accessibility, or configuration/authentication changes, enable sharing again locally. Denial or inactive sharing produces an unavailable image with a reason; tree observation can remain available.

Projection frames are drained and discarded. Only an on-demand screenshot is copied and encoded; there is no recording, audio, or saved frame. Requests have a 2.5-second capture deadline and reject overlapping captures. Images retain display resolution, with at most 8,294,400 pixels and 8 MiB compressed bytes, using the existing PNG/JPEG fallback. Android secure-window protection remains in force. Locked or noninteractive screens are not captured. A rotation or display-size change ends the projection session: refresh observation and enable sharing again before requesting another image. Snapshot-bound inputs still require the existing fresh window identity, generation, dimensions, and rotation.

## Import configuration

Press **Import configuration (JSON)** and select a document through Android's system file picker. The document must be a UTF-8 JSON object containing exactly three strings: `endpoint`, `device`, and `token`, with a total size of at most 8192 bytes. Existing endpoint and pairing validation applies. Unknown/duplicate fields, malformed JSON, invalid types, and oversized documents are rejected.

The import fills fields for review. Press **Save configuration** to confirm, then **Start foreground control** explicitly. Import neither saves nor starts control. No credentials are accepted from launch-intent extras. The token field is hidden from Accessibility and autofill, excluded from saved view state, and protected by `FLAG_SECURE` during entry/import. URI grants and consent results are not persisted. Keep configuration documents in private owner-controlled storage.

## Validation

With Java 21 and the configured Android SDK, run from this directory:

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

From the repository root, run the companion static regression tests. Physical qualification must separately exercise API 29 consent grant/deny/revoke, STOP during capture, rotation, lock/secure windows, reboot without renewed consent, and API 30+ Accessibility screenshots. Compilation and unit/static checks do not establish installed-device behavior.

## Secure Downloads receive

`android_file_push` transfers files from a configured source agent while the
paired foreground control loop is online. It uses the existing authenticated
controller and VPN route policy, with no storage permission or optional shell
requirement. Names are reduced to a safe leaf; files larger than 512 MiB are
rejected. Downloads remain pending until streamed length and SHA-256 match the
controller command. On failure the new pending entry is deleted when possible;
abandoned pending entries also expire. MediaStore may choose a distinct display
name when a Downloads file already exists.

Keep the command UUID unchanged across retries and inspect
`android_command_status` after an uncertain result. A different UUID requests a
new download. Reboot, disconnection, and lost result acknowledgement must never
be handled by automatically repeating the receive operation. Physical storage,
STOP during transfer, pending-entry cleanup and result recovery require separate
installed-device qualification.
