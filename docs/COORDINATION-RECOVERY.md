# Coordination recovery

This contract extends the existing resource fence and durable job runner. It does
not authorize replay of an uncertain operation or provide a force-unlock switch.

## API and compatibility

The original `inspect`, `acquire` and `release` requests and their v1 records remain
valid. Both inspection actions are read-only: inspecting a terminal job does not
release its resource. Legacy job reconciliation still runs before admission of a
new write and before `acquire`/`release`. The new recovery actions exclusively use
their stronger evidence checks; they cannot unlock a legacy job through that older
automatic settlement policy.

The controller requires `coordination-recovery-v1` from the selected agent before
dispatching these new actions:

| Action | Inputs in addition to the resource | Result |
| --- | --- | --- |
| `inspect_recovery` | None | The current v1 record, observed base, and separate execution/resolution metadata. |
| `prepare_recovery` | Original token and `expectedCurrentBaseVersion` | A durable recovery intent with the original journal hash, execution identity, base and boot identity. |
| `reconcile` | Original token and `expectedCurrentBaseVersion`; optional `recoveryIntentId` | An evidence-bound disposition for that generation, or an explicit conflict. Failed Git commit observations are available through inspection and do not permit reconciliation. |

`expectedCurrentBaseVersion` acknowledges the freshly inspected resource. It is
not evidence that a process stopped. The original token's `baseVersion` remains
unchanged, even if a partial operation changed refs or other repository data.
Generation, operation, resource, device and execution identity must all match.

### Read-only device capacity diagnosis

The additive MCP tool `coordination_capacity` selects one configured device and
explicit execution identity; the selected agent must advertise
`coordination-capacity-v1`. Older agents fail capability checking before the
diagnostic request is dispatched. The authenticated agent endpoint
`POST /v1/coordination/capacity` accepts an empty JSON object only, and uses the
agent's own device identity to read at most four local capacity slots.

The diagnostic reports slot indices, occupied/free counts, recorded state,
same/different execution identity, approximate age and lease bands, and whether
a job binding or disposition exists. Missing/mismatched journals are
`orphan`; unreadable records are `unreadable` with partial visibility.
No repository path, resource key, operation/token/job identifier, credential,
command or producer-controlled error is serialized. The view is **non-atomic**
and may change during collection; free slots are an observation, not a promise
of immediate admission. A bound job is **not** verified terminal evidence.
A recorded disposition does not establish successful effects.

This read never probes process identity, runs a job, retries a request, settles a
writer, releases a slot or alters any journal. `active`, `uncertain`, orphan
and invalid records remain fenced. An elapsed lease does not demonstrate
quiescence or make an uncertain operation safe to replay. Recovery must still
follow the original token, full execution identity and independent containment
contract below. Selected Linux native SDK collection was qualified after the
[PR #60](https://github.com/anervalens-netizen/remote-control-mcp/pull/60)
source merge, including a second owner-route activation under guarded admission.
That demonstrates a bounded live diagnostic read and older-agent rejection,
not a clearance of the still-uncertain historical operations. One previously
occupied slot was independently observed released, while three other original
uncertain journals were verified unchanged. Job-terminal/resource
reconciliation and safe clearance of remaining historical reservations stay
separate work under
[RC26-REC-06](https://github.com/anervalens-netizen/remote-control-mcp/issues/58).

The main journal retains the exact strict v1 schema. Execution bindings live in
versioned sidecars under `executions/`; dispositions and original journal bytes
live under `reconciliations/`. Old agents can still parse active and released
journals and ignore these directories. Legacy inspect responses and conflict
records also contain only the v1 fields. New metadata is exposed separately by
`inspect_recovery` and the new mutation responses. Recovery inspection derives its
public record and metadata from one journal read, so a concurrent transition cannot
mix generations in those fields. Downgrading an agent does not
add synchronous recovery support to that older agent; existing fences and job
semantics remain in force. Preserve all sidecars during rollback.
A v1 agent can refresh only `updatedAt` on an already released journal before
reserving the next generation. Recovery tolerates that interrupted rollback state
without rewriting its journal; every other field must still match the disposition.
Back up the main journals and slots, `executions/`, `recovery-intents/`,
`reconciliations/`, `hook-failures/`, `repo-operations/` and the corresponding
existing job/key stores together. A checkout or release-directory rollback is not a state migration.

### Sharing between trusted Unix identities

Coordination state is private by default: new files use `0600` and new directories
use `0700`. Sharing is an explicit opt-in for trusted participating agents. Provision
the common root, its ancestor access and group membership externally, normally with
setgid group inheritance, then configure `RCMCP_COORDINATION_FILE_MODE=0660` on every
participant. New directories lexically inside the coordination root use `0770`; the inherited
setgid bit and group remain intact. Their permissions are applied after creation so
a restrictive umask does not silently remove the configured group access. Missing
ancestors outside that root retain private `0700` access bits, plus any inherited
setgid bit. Creating them does not grant another identity traversal access; shared
ancestors still need external provisioning.

The current boundary compares path names lexically; it is not a guarantee of
physical containment through symlinked parent components. A trusted participant
with write access inside the shared root can place a symlink that redirects a
lexically nested directory outside the physical root, where creation can still
apply the shared mode. Keep the provisioned directory topology stable during
active writes. Symlink-aware traversal and containment hardening remain deferred
under REC-04/HIS-04/MCP-04; private defaults and the trusted-participant sharing
model remain unchanged.

Normal coordination flows pre-create receipt parents with the configured mode.
If an external actor removes a parent between that step and an atomic write, the
generic atomic writer can recreate the missing directory with the process umask
default instead of the configured `0700` or `0770`. Configured directory access is
therefore not guaranteed across that external deletion window. Parent-recreation
hardening and fault coverage remain deferred under HIS-04/REC-04/MCP-04. This
limitation concerns recreated directories; it does not change the configured
mode of the receipt file being written.

This policy covers execution sidecars, recovery intents, reconciliations, retained
hook-failure outcomes and nested `repo-operations/` directories. Repository request and result receipts use the same
configured file mode on both successful and failed worker paths. The existing job
state remains separate and keeps its own permissions and execution identity.

Existing directories, ownership, group membership and ACLs are never automatically
rewritten. An existing private or incompatible recovery directory needs an explicit
operator-managed permission migration before cross-identity sharing can work. An
upgrade does not silently widen those directories or grant a group access to earlier
private receipts. Keep the original journals and recovery evidence intact during
that migration.

## Repository execution

For `repo_fetch`, `repo_pull` and non-dry-run `repo_push`, the agent chooses its
execution mode before dispatch:

* When the existing Linux systemd job backend can provide containment, the result
  reports `recoveryMode: "durable_job"`.
* Otherwise the existing synchronous implementation remains available and reports
  `recoveryMode: "legacy"`, `containment: "unverified"` and the capability reason.
  It does not acquire stronger recovery guarantees by running on a newer agent.

The durable path uses **one job for the entire high-level operation**. Fetch,
merge, before/after observations and result publication cannot be independently
reconciled between steps. The normal success response remains synchronous when
the complete job finishes within the bounded wait. A longer job returns HTTP 202
with `accepted`, `executionPending`, its job ID and the original coordination
token. The caller follows that job and reconciles its original token; it does not
repeat the repository request.

Before job reservation or dispatch, the agent publishes a binding containing the
operation token, device, identity, deterministic job key, input fingerprint and
request digest. A binding records intended execution identity, not proof that a
job was admitted. If request publication fails after this binding but before
dispatch, trusted
invocation-scoped evidence can still report `executionOutcome: "not_started"` and
a released fence. The existing binding remains as audit evidence, without a job ID
or invented result. A null binding means only that no binding is available in
the returned record view. It does not prove that no artifact was published or that
admission was never attempted or completed, and it never authorizes replay.
`not_started` requires invocation-bound evidence that the failure preceded dispatch;
neither a null binding nor a missing job ID supplies that proof.
A failed release still requires recovery; an attempted admission with a lost reply
remains uncertain even when no job ID was observed. A failed or ambiguous admission
never falls back to direct Git or a second job. The worker uses a pinned canonical
path and revalidates the resource, base, active token, execution sidecar and
durable job reservation immediately before invoking the repository helper. This closes the asynchronous admission gap;
it does not make unrelated raw filesystem writers participate in the resource
fence. The ordinary Git locks and fresh resource checks still apply.

The existing job key and containment records remain authoritative. A missing key,
wrong fingerprint, different job/device/identity, live cgroup, changed systemd
invocation or unreadable evidence cannot release a writer. A root process exit,
empty observed PID list or terminal status from an uncontained backend is not a
whole-tree proof. Removing a job before reconciliation may leave only an older
terminal tombstone without containment evidence; that is insufficient for this
new recovery path.

### Failed Git commit observations

A failed checkpoint retains the Git command exit status and bounded before/after
observations. The agent invokes the repository's configured hooks through Git
and reports the hook boundary and exit code as unavailable. It does not record
raw command output or reflog text. Missing, failed and truncated observations
have null digests.

The index digest describes listed index entries. The worktree digest describes
porcelain status, which can stay the same across a change to file contents. Process
containment is unavailable for this synchronous commit. Observed changes yield
`partially_applied`. Otherwise the effect is `unverified`. Neither state
qualifies for fence release from this evidence.

The MCP checkpoint error reports the observed command exit code, classification
and evidence availability. Its next action points to `inspect_recovery` with
the same repository and identity. The compact error carries `noReplay`.

Use `inspect_recovery` to read the observation tied to the original generation.
It is stored in a bounded, immutable `hook-failures/` sidecar. The uncertain
writer remains fenced. A recovery attempt needs independent quiescence/effect
evidence through a supported recovery path.

## Outcomes and publication

The API preserves separate facts:

* `operationSucceeded` describes the result published by the repository worker.
* For an admitted job, `executionOutcome` comes from its actual terminal evidence.
  A proved pre-dispatch failure can instead report `not_started`. A published
  successful result does not manufacture `exit_zero` if the worker later fails or
  its exit outcome is lost.
* `resultPublication` states whether the original result is available.
* `effectVerification` remains `unverified`; successful execution does not prove
  that the user's intended repository state was achieved.

A pull can fetch new refs, fail to merge because of an index lock, return an error,
and still release the resource after verified whole-job termination. The partial
effects and failed operation remain visible. A missing result can return HTTP 500
alongside a verified exit and a completed coordination disposition. Neither case
authorizes replay.
HTTP errors may also carry a typed recovery receipt with the job locator and
original token. The controller preserves only validated, mutually matching
recovery identifiers. That locator is correlation metadata, not terminal proof;
inspect the original job and resource before reconciliation. If an older agent or
an untyped error has no receipt, use `inspect_recovery` on the canonical resource.
An archive or journal publication failure also preserves the original observed
binding and any job ID already returned by admission, even if a later settlement
or recovery read fails. A bounded, hash-validated original worker result can still
report `operationSucceeded: true`, `executionOutcome: "exit_zero"` and publication
available alongside HTTP 500. That HTTP error concerns receipt publication; it does
not turn successful Git work into a failed operation. Missing result data remains
unavailable and unobserved process outcomes remain uncertain. A memory fallback
contains the last observed original record, not a new resource inspection. It never
invents a job ID after an uncertain admission or relaxes the persisted fence.
Post-dispatch coordination conflicts also retain this receipt alongside their
HTTP 409 code and unchanged v1 conflict details, including a slot-cleanup failure
after the released journal has been published. A conflict status alone does not
mean that Git was never dispatched or that its operation failed.

Before releasing the resource, reconciliation durably stores the original v1
journal bytes, their digest, execution metadata and the resolution. It then
publishes the released v1 record and frees only that operation's budget slot.
Failed archive publication keeps the writer fenced. An archive that was renamed
but whose durability was not confirmed is republished durably before an interrupted
release can finish. A catch handler cannot rewrite the original record after an
archive has bound it.

Repeated reconciliation returns the same disposition. It can finish that exact
interrupted transition only after rechecking the current base, exact original
journal bytes and budget slot. A changed fence keeps the writer blocked; the retry
does not rewrite the archived disposition to fit a new base or changed evidence.
Reading an already published disposition can tolerate a later resource base, but
it cannot change a later generation. Such a lookup accepts either the original
disposition's observed base or the freshly inspected current base, and returns the
unchanged original disposition. A pending release still requires the current base
to match the immutable archive's base; this lookup allowance cannot release it.
Original metadata
and private execution bindings are retained. Each execution, intent and resolution
store has a 4096-entry admission limit; saturation fails closed. Request receipts
are bounded to 64 KiB and result reads to 256 KiB. Each limit applies to its
directory under the configured coordination state root, not to the whole fleet or
one client session. Saturation returns `recovery_retention_full`; it refuses new
binding/preparation/publication rather than discarding evidence or releasing an
unverified writer. Binding also checks the reconciliation store before dispatch,
even when execution storage has space, because that future disposition must be
retained. This is a preflight check, not a reservation against concurrent archive
writers; later saturation still fails closed and preserves the writer and evidence.
Retained bindings for proved pre-dispatch failures also count toward the execution
store limit; they are not silently deleted after release. Unresolved evidence is
not expired to create capacity.
Do not delete journals, sidecars, intents, archives or job keys to retry a command.
Monitor capacity and preserve evidence for a separately qualified retention
change; that maintenance remains part of RC26-HIS-04 in the improvement plan.
Durable job output has the existing job store's separate lifecycle.

## Historical operations without execution receipts

A new receipt cannot retrospectively prove the outcome of an old synchronous
command. The supported historical procedure is:

1. Inspect the original token, current resource state and recovery metadata. Preserve
   repository edits and recovery files separately from the coordination decision.
2. Prepare a recovery intent against the original journal and the current base.
   The intent stores the exact original journal bytes and binds their digest,
   canonical resource, token, device, identity and current Linux boot identity.
3. Obtain independent quiescence evidence. An already-bound original job may supply
   verified containment. Otherwise the agent must observe a different valid boot
   identity after the intent was recorded. The API itself never reboots or stops
   a host. Age, wall-clock timestamps, process absence and an agent restart are
   deliberately insufficient.
4. Re-inspect the resource and reconcile the same intent and original token with
   an explicit matching current base. Changed journal bytes, generation or identity
   cause a conflict. A stale `expectedCurrentBaseVersion` also causes a conflict.
   The prepared base can differ from this new observed base: the boot boundary
   proves quiescence of the original writer, not an absence of repository changes.
   The disposition preserves both `preparedBaseVersion` and `observedBaseVersion`
   with outcome unknown. A repository change alone does not require another reboot.

Historical resolution records `outcome: "unknown"`. It retires the old writer
based on new quiescence evidence while preserving the historical uncertainty. It
does not assert that the command succeeded, that remote effects were absent or
that the repository is now in its desired state. Repository repair is a separate,
explicit operation after inspection. If the needed evidence is unavailable, the
resource remains fenced and the limitation remains visible.
