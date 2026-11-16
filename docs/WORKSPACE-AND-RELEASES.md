# Source workspaces and runtime releases

A repository checkout identifies source work. A release directory identifies
installed files. A service definition identifies the next configured start.
An authenticated runtime response identifies an observed process. Record these
separately before changing or diagnosing an installation.

This document defines a generic workflow. Keep real device names, paths,
endpoints, service inventories, credentials, receipts and local diffs in private
operator storage. Public examples and tests must remain synthetic.

## Maintain a private workspace map

For each host and execution identity, record:

| Record | Required evidence |
| --- | --- |
| Canonical source repository | Current host, physical path, Git common directory, remote identity and purpose. |
| Active change worktree | Path, branch, base commit, current commit, status, task reference and owner. |
| Older worktree | Path, commit, branch or detached state, local-change status and preservation reference. |
| Immutable release | Physical path, commit/tree claim, verification receipt, manifest digest and generated-asset receipt. |
| Configured startup | Service/task identity, loaded executable and entry point, configuration precedence, state directory and selected version declarations. |
| Running component | Process/instance identity, start time, actual executable/entry point, authenticated diagnostic response and observation time. |

Inspect existing worktrees with `git worktree list --porcelain` and inspect each
relevant path before using it. A repository named as the canonical source may
have an older local branch while a separate worktree holds the current change.
That is a valid state.

Preserve local edits and untracked work. Record a private diff or preservation
reference before a change that could affect them. Do not reset an older checkout,
delete a worktree, prune metadata, or overwrite a local branch to make the
workspace list appear current. Missing paths require inspection; they do not
authorize cleanup.

Fetch current remote references and create an isolated worktree for new work.
Record the exact base commit. Keep old branches and unfinished work intact.
A newly created worktree needs its own dependency links; copying or symlinking
another worktree's dependencies can bind workspace packages to the wrong source.

## Distinguish four version states

| State | Meaning | Evidence needed |
| --- | --- | --- |
| Desired | The operator's intended version for this component. | A task, rollout plan or explicit retained-version decision. |
| Installed | Candidate or retained files exist at a specific release location. | File verification against the intended source, generated-asset evidence and manifest digest. |
| Startup target | The service manager is configured to start this component from a location. | Loaded service/task configuration, executable/entry point, ordered overrides and selected environment declarations. |
| Running | A particular process currently reports and executes a version. | Process identity, start time, executable/entry point and authenticated runtime diagnostics. |

Use `unknown` when the required evidence is absent. Do not fill a missing
version from a directory name, branch name, most recent commit, package version,
or another component's version.

Compare the states per component and execution identity. Controller, root agent,
owner agent, desktop helper and Android companion may intentionally use different
versions. Check the capability/protocol requirements of the actual operation.
Matching SHAs alone do not establish compatibility, and different SHAs alone do
not establish a defect.

A healthy process can have a stale startup target. Inspect loaded service
configuration and applicable files without restarting it as a diagnostic shortcut.
Account for override order and both environment-file and command-line version
declarations. Compare the resulting target with the process entry point and
runtime identity. Keep an intentional difference and its reason visible.

The application currently exposes runtime SHA, its source/binding, and a bounded
release-integrity snapshot through `releaseIdentity`. This is useful running
evidence. It does not independently enumerate every installed release or establish
the operator's desired version and future service-manager target. Keep those
separate private records until a version inventory supplies independently sourced
values.

## Verify and activate a release

1. Finish source validation, required current-head reviews and CI. Record both
   the reviewed commit and the source tree being promoted.
2. Stage a new immutable release outside active development worktrees. Build
   generated assets from that source and retain their hashes and build receipt.
3. Use `scripts/verify-release.ts` to compare the release with the immutable Git
   source. Use `scripts/create-release-manifest.ts` when a manifest is required.
   Read the exact script arguments before running either helper.
4. Keep private configuration and persistent state at explicitly configured paths.
   Record the previous release, service definitions and applicable recovery point.
   Do not copy an active queue or schedule into a second running instance.
5. Inspect active operations and use a concrete, recoverable rollout plan.
   Preserve original execution keys, receipts, recovery intents and uncertain
   operations. A lost connection does not authorize replay.
6. Change only the intended component and startup configuration. Read back the
   service target, process identity and authenticated runtime evidence.
7. Verify behavior that exercises the changed contract through the real client
   path. Store the result separately from command exit status and service liveness.
8. Update the private workspace/runtime map, task checkpoint and public tracker
   with the exact verified scope. Clean temporary fixtures after their evidence
   has been retained; keep required recovery material under an explicit policy.

For failures, restore the verified prior service/release configuration according
to the rollout plan. Do not delete durable job reservations or coordination
journals to make an operation retryable. Use original receipts and supported
inspection/reconciliation. See [Coordination recovery](COORDINATION-RECOVERY.md).

## Interpret release integrity correctly

The runtime's manifest check covers the listed files at process startup.
`pinned_integrity` means the listed bytes match and the manifest digest matches
the configured pin. The manifest is an unsigned local attestation. Its source
claims are not independently verified upstream by a runtime request.

Dependencies, runtime binaries, private configuration, unlisted files, symlink
targets and changes after startup are outside that snapshot's stated scope.
Record independent checks where a rollout requires them. Do not describe a
startup snapshot as continuous integrity monitoring.

A manifest-free retained release remains visible with missing evidence. Do not
silently substitute the release directory's name or a parent checkout's HEAD for
verified source identity. See [Reliability and release qualification](RELIABILITY.md).

## Preserve fleet identity and availability distinctions

Keep canonical device identity and aliases stable for durable job and operation
references. Reconcile roles and availability with current owner intent before
interpreting a fleet result. An entry left in a transport catalog does not prove
that its historical production role still exists.

Record retired, intermittent and active roles privately. The current transport
configuration's `expectedAvailability` supports `continuous` and
`intermittent`; it does not by itself express retirement or remove an endpoint
from automatic probes. Changing a live inventory must account for existing
durable references and routing.

Report identity configuration, endpoint reachability, runtime readiness and
capabilities separately. A failed diagnostic request does not prove a device is
powered off. A responding agent with unavailable metrics remains reachable.
Bound read-only diagnostic probes independently of execution deadlines, and stop
queued probes when their caller cancels.

Add or tune persistent probe backoff only after measuring repeated unnecessary
requests. Keep explicit fresh diagnostics available and retain observation times
so a cached result cannot appear current.
