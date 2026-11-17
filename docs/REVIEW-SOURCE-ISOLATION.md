# INV-05 — isolated review source probes

This is a source-probe launcher, not a sandbox for the DSH model session.
It does not create a new authorization model for Remote Control MCP. Keep the
existing owner-controlled agent tools available for explicitly authorized work.

## Linux contract

The script scripts/review-sandbox.py reads a pinned, root-owned, non-symlink
policy from /etc/remote-control-mcp/inv05-review-sandbox.json. The keys are:

    {
      "workspaceRoot": "/srv/review-worktrees",
      "runtimeDirs": [],
      "timeoutSeconds": 240
    }

An operating-system administrator installs the policy and source launcher
outside any DSH or repository writable workspace. The policy file must be
owned by root, not writable by group/other, at most 4096 bytes. Do not accept
the policy filename from a worker's command line or environment. The trusted
workspace root must be a physical directory, not a broad system root; every
selected checkout must be an owned, physical descendant. Optional runtime
directories must be physical descendants of /opt/runtimes, selected by the
trusted policy. On hosts with Node in /usr/bin, no additional runtime mounts
are necessary. The command arguments themselves have no allowlist.

Invocation:

    /usr/bin/python3 /usr/local/libexec/rcmcp-review-sandbox \
      --workspace /srv/review-worktrees/ticket-123 -- \
      /usr/bin/node --test /work/fixture.test.mjs

Each invocation pins the approved checkout inode with an open directory
file descriptor and passes that descriptor to bubblewrap. A rename or symlink
swap between validation and the mount cannot redirect the source to a
different host directory.

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

## Acceptance boundary

The synthetic test executes the actual runner, checks private paths and host
processes cannot be observed/signalled, verifies own checkout build/test and
localhost behavior, and confirms time-bounded process termination. A host
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
