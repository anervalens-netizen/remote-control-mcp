# INV-05 — isolated review source probes

This is a source-probe launcher, not a sandbox for the DSH model session.
It does not create a new authorization model for Remote Control MCP. Keep the
existing owner-controlled agent tools available for explicitly authorized work.

## Linux contract

The script scripts/review-sandbox.py reads a pinned, root-owned, non-symlink
policy from /etc/remote-control-mcp/inv05-review-sandbox.json. The keys are:

    {
      "workspaceRoot": "/srv/review-worktrees",
      "workspaceRootDev": 12345,
      "workspaceRootIno": 67890,
      "runtimeDirs": [],
      "timeoutSeconds": 240
    }

The device and inode numbers above are placeholders: replace them with
the real st_dev and st_ino returned by stat on the trusted workspace root.
They bind future admissions to the originally provisioned directory, not a
replacement inode at the same pathname. Any parent symlink is refused.
The launcher traverses from a pinned filesystem root descriptor using
O_NOFOLLOW on every component before passing the accepted checkout FD to
bubblewrap. Root replacement or a symlink swap fails closed.

An operating-system administrator installs the policy and source launcher
outside any DSH or repository writable workspace. The policy file must be
owned by root, not writable by group/other, at most 4096 bytes. Do not accept
the policy filename from a worker's command line or environment. The trusted
workspace root must be a physical directory, not a broad system root; every
selected checkout must be an owned, physical descendant. Optional runtime
directories must be physical descendants of /opt/runtimes with root-owned,
non-group/world-writable ancestry. Each selected runtime is opened through
pinned, symlink-free directory descriptors and mounted read-only via the
descriptor-consuming --ro-bind-fd operation. A mutable runtime directory is
rejected rather than bound by its pathname. On hosts with Node in /usr/bin,
no additional runtime mounts are necessary. The command arguments themselves have no allowlist.

Invocation:

    /usr/bin/python3 /usr/local/libexec/rcmcp-review-sandbox \
      --workspace /srv/review-worktrees/ticket-123 -- \
      /usr/bin/node --test /work/fixture.test.mjs

Each invocation pins the approved checkout inode with an open directory
descriptor and passes it to bubblewrap using --bind-fd, which consumes the FD
during mount setup. The source descriptor must **not** be inherited by the
executed test process: otherwise openat("..") on it can escape the sandbox.
A rename or symlink swap between validation and mount cannot redirect the
source to a different host directory.

Every invocation starts a separate bubblewrap user/PID/network/IPC/UTS
namespace. The sole host writable mount is the selected checkout at /work.
Core system runtime mounts are read-only; /tmp, /proc and /dev are new
per invocation. Environment clearing removes inherited provider credentials
and host configuration. There is no host /home tree, /root, /run service
socket or host /var mount. Commands may communicate with their own localhost
fixtures, but not the host controller or the external network. A timeout
kills only the launcher-owned process group; --die-with-parent confines
descendants if the launcher stops.

The runner refuses a missing/invalid policy, unavailable bubblewrap, symlink
checkout, outside-workspace path, untrusted runtime mount, oversized request
or invalid timeout. It must never silently fall back to an unconfined command.
A source review needs its dependencies available inside the selected checkout;
network-dependent dependency acquisition is a separate controlled preparation
step. Do not mount the host's personal package cache or provider credentials
into these probes.

## Selected Linux installation and DSH integration

After the PR #61 source merge, a selected Linux review host installed the
unmodified, source-hash-verified launcher at
`/usr/local/libexec/rcmcp-review-sandbox` and a pinned root-owned policy at
`/etc/remote-control-mcp/inv05-review-sandbox.json`. The actual installed
entrypoint was run as a non-root review account against a disposable checkout.
Native Node tests passed: host process/service sockets and provider state were
not visible, inherited mount-source descriptors were consumed, the checkout
could be modified, an outside-root workspace was rejected and the owned
fixture was removed. The running DSH service retained its process identity.

The scoped DSH profile's prompt configuration now includes a
`review-source-probes` skill and explicit guidance to use the installed
launcher for executable source probes. A role prompt preview confirmed the
guidance reaches a new review worker; existing model/executor/permission
settings were checked unchanged and the DSH service was not restarted.
The prior profile version remains in a private, protected backup.

**This is a partial delivery.** The DSH worker's native shell tools and
subagents are not yet forcibly routed through the isolated launcher.
A source-probe command could still bypass the guidance. The enforceable,
profile-scoped dispatch and end-to-end PR-review/publication acceptance are
tracked in [INV-05 dispatch enforcement](https://github.com/anervalens-netizen/remote-control-mcp/issues/64).
No workaround should mislabel optional use of the launcher as complete
process isolation. Other DSH profiles and owner-authorized Remote Control
operations retain their existing capabilities.

## Acceptance boundary

The synthetic test executes the actual runner, checks private paths and host
processes cannot be observed/signalled, checks that mount-source directory
descriptors have been consumed before the probe executes, verifies own
checkout build/test and localhost behavior, and confirms time-bounded process
termination. A host
without working Linux namespaces explicitly skips native exercise; the
configuration and syntax tests still run.

Not yet covered by the script alone: DSH's own persistent model sessions,
its native bash/pwsh tools, other application profiles, Windows/macOS, or
actual review-publication flow. The host DSH workspace-write sandbox is
same-world filesystem confinement; it is not a host PID boundary.
An operator must integrate this executable into real source-probe dispatch,
verify that review probes cannot silently bypass it, then validate DSH review
and publication with a synthetic ticket. Without this end-to-end verification,
the full INV-05 item remains active, not verified.

Historical REC-05 journal/intent, installed release directories, host service
configuration and unrelated DSH sessions are outside this workflow and must
not be modified by its probes. Private host receipts belong in ContextKeep.
