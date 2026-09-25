import { jobLineageResultSchema } from "../../../packages/protocol/src/project.ts";
import { browserActionResultSchema, browserExecutionResultSchema } from "../../../packages/protocol/src/browser.ts";
import { z } from "zod";
import { execResultSchema, fsReadResultSchema } from "../../../packages/protocol/src/execution.ts";

const identity = z.enum(["owner", "root", "interactive"]);
const context = z.enum(["user", "system", "desktop"]);
const route = { identity, context };
const nonnegative = z.number().int().nonnegative();
const stringOrNull = z.string().nullable();

const jobSummary = z.object({
  id: z.string().min(1),
  state: z.enum(["running", "cancelling", "completed", "cancelled", "lost"]),
  pid: z.number().int().positive().optional(),
  processIdentity: z.string().optional(), trackedProcessCount: nonnegative.optional(),
  terminationVerified: z.boolean().optional(), terminationForced: z.boolean().optional(),
  terminationVerification: z.enum(["identity_bound_job", "posix_identity_set", "partial_windows_job", "unverified_windows_fallback"]).optional(),
  terminationVerificationScope: z.enum(["whole_tree", "root_and_descendants_created_after_attach", "root_only", "unverified"]).optional(),
  terminationReason: z.string().optional(), cancellationError: z.string().optional(), recoveryReason: z.string().optional(),
  progress: z.unknown().optional(), progressInterrupted: z.boolean().optional(),
}).passthrough();
const process = z.object({ pid: nonnegative.optional(), ProcessId: nonnegative.optional() }).passthrough().refine((value) => value.pid !== undefined || value.ProcessId !== undefined, "process result must identify a PID");
const fileEntry = z.object({ name: z.string(), path: z.string(), type: z.enum(["directory", "file", "symlink", "other"]), size: nonnegative }).passthrough();
const searchResult = z.object({ path: z.string() }).passthrough();

const jobManyItem = z.union([
  z.object({ device: z.string().min(1), identity, context, ok: z.literal(true), job: jobSummary }).passthrough(),
  z.object({ device: z.string().min(1), identity, context, ok: z.literal(false), error: z.string() }).passthrough(),
]);
const jobList = z.object({ items: z.array(jobSummary), ...route }).passthrough();
const jobOutput = z.object({
  id: z.string().min(1), stream: z.enum(["stdout", "stderr"]), offset: nonnegative,
  nextOffset: nonnegative, totalBytes: nonnegative, eof: z.boolean(), data: z.string(), ...route,
}).passthrough();
const jobFollow = z.object({
  ...jobSummary.shape,
  id: z.string().min(1), state: z.enum(["running", "cancelling", "completed", "cancelled", "lost"]),
  terminal: z.boolean(), waitExpired: z.boolean(), cursor: z.object({ stdout: nonnegative, stderr: nonnegative }),
  stdout: z.object({ nextOffset: nonnegative, eof: z.boolean(), data: z.string() }).passthrough(),
  stderr: z.object({ nextOffset: nonnegative, eof: z.boolean(), data: z.string() }).passthrough(),
  outputComplete: z.boolean(), ...route,
}).passthrough();

const androidDeviceInfo = z.object({
  name: z.string(), transport: z.literal("android-reverse"), online: z.boolean(), readiness: z.string(), readinessReason: z.string(),
  observedAt: z.number().nullable(), lastPollAt: z.number().nullable(), state: z.record(z.string(), z.unknown()).nullable(),
  queuedCommands: nonnegative, activeCommandId: z.string().nullable(),
}).passthrough();
const deviceInfo = z.object({
  hostname: z.string().optional(), platform: z.string().optional(),
  name: z.string().optional(), transport: z.literal("android-reverse").optional(), online: z.boolean().optional(),
  readiness: z.string().optional(), readinessReason: z.string().optional(), observedAt: z.number().nullable().optional(),
  lastPollAt: z.number().nullable().optional(), state: z.record(z.string(), z.unknown()).nullable().optional(),
  queuedCommands: nonnegative.optional(), activeCommandId: z.string().nullable().optional(),
}).passthrough().refine((value) =>
  (typeof value.hostname === "string" && typeof value.platform === "string") || androidDeviceInfo.safeParse(value).success,
  "device info must identify either a host runtime or an Android reverse device",
);
const fsWrite = z.object({ path: z.string(), bytes: nonnegative, writtenBytes: nonnegative, mode: z.enum(["rewrite", "append"]), atomic: z.boolean(), durable: z.boolean() }).passthrough();
const fsManage = z.object({ operation: z.enum(["stat", "mkdir", "move", "copy", "delete", "times"]).optional(), path: z.string(), size: nonnegative.optional(), ok: z.boolean().optional(),
  copied: nonnegative.optional(), skipped: nonnegative.optional(),
  outcome: z.enum(["copied", "skipped", "partial", "failed"]).optional(), reason: z.literal("destination_exists").optional(),
}).passthrough().refine((value) => value.operation !== undefined || value.size !== undefined || value.ok !== undefined, "filesystem management result must identify the operation or stat data");
const ptyOutput = z.object({ id: z.string(), state: z.string(), offset: nonnegative, nextOffset: nonnegative, totalBytes: nonnegative, bytesRead: nonnegative, eof: z.boolean(), data: z.string() }).passthrough();
const ptySession = z.object({ id: z.string(), pid: z.number().int().positive(), state: z.string() }).passthrough();
const searchEnvelope = z.object({ results: z.array(searchResult).optional(), limited: z.boolean().optional(), items: z.array(searchResult).optional() }).passthrough().refine((value) => (value.results !== undefined && value.limited !== undefined) || value.items !== undefined, "search result must contain matches");
const searchPage = z.object({ id: z.string(), status: z.string(), results: z.array(searchResult), available: nonnegative, limited: z.boolean() }).passthrough();
const searchSession = z.object({ id: z.string(), status: z.string(), available: nonnegative }).passthrough();
const desktopAction = z.object({ index: nonnegative, kind: z.string(), ok: z.boolean() }).passthrough();

/**
 * Every registered tool has a named semantic contract. The registry includes
 * the twelve tools that already publish specialized schemas so the inventory
 * is auditable in one place; the installer only fills missing schemas.
 */
export const toolResultSchemas = {
  capability_report: z.object({ items: z.array(z.object({ device: z.string(), configured: z.object({ system: z.boolean(), user: z.boolean(), desktop: z.boolean() }), endpoints: z.record(z.string(), z.union([z.object({ ok: z.literal(true), info: deviceInfo }).passthrough(), z.object({ ok: z.literal(false), error: z.string() }).passthrough()])) }).passthrough()) }),
  file_transfer: z.object({ sourceDevice: z.string(), sourcePath: z.string(), destinationDevice: z.string(), destinationPath: z.string(), bytes: nonnegative, chunks: nonnegative, sameFile: z.boolean(), atomic: z.boolean(), durationMs: z.number().nonnegative() }).passthrough(),
  directory_sync: z.object({ sourceDevice: z.string(), sourcePath: z.string(), destinationDevice: z.string(), destinationPath: z.string(), directories: nonnegative, files: nonnegative, bytes: nonnegative, skipped: z.array(z.object({ path: z.string(), type: z.string() }).passthrough()), transferred: z.array(z.object({ relative: z.string(), bytes: nonnegative, chunks: nonnegative, unchanged: z.literal(false) }).passthrough()), unchanged: z.array(z.string()), filesTransferred: nonnegative, filesUnchanged: nonnegative, durationMs: z.number().nonnegative() }).passthrough(),
  secret_status: z.object({ alias: z.string(), present: z.boolean() }).passthrough(),
  secret_list: z.object({ secrets: z.array(z.object({ alias: z.string(), present: z.boolean() }).passthrough()) }).passthrough(),
  secret_import_file: z.object({ alias: z.string(), bytes: nonnegative, importedFrom: z.object({ device: z.string(), identity: z.enum(["root", "owner"]) }).passthrough() }).passthrough(),
  secret_install: z.object({ alias: z.string(), device: z.string(), destination: z.string(), bytes: nonnegative, identity: z.enum(["root", "owner"]), atomic: z.boolean(), destinationAtomic: z.boolean() }).passthrough(),
  secret_template_render: z.object({ aliases: z.array(z.string()), device: z.string(), destination: z.string(), bytes: nonnegative, identity: z.enum(["root", "owner"]), atomic: z.boolean(), destinationAtomic: z.boolean() }).passthrough(),
  secret_rotate: z.object({ alias: z.string(), present: z.boolean() }).passthrough(),
  secret_delete: z.object({ alias: z.string(), deleted: z.boolean() }).passthrough(),
  devices_list: z.object({ devices: z.array(z.object({ name: z.string(), url: z.string(), contexts: z.object({ system: z.boolean(), user: z.boolean(), desktop: z.boolean() }) })) }).passthrough(),
  device_info: deviceInfo,
  android_status: androidDeviceInfo,
  android_observe: z.object({ commandId: z.string().uuid(), status: z.enum(["completed", "error", "outcome_unknown", "cancelled", "expired"]), ok: z.boolean() }).passthrough(),
  android_action: z.object({ commandId: z.string().uuid(), status: z.enum(["completed", "error", "outcome_unknown", "cancelled", "expired"]), ok: z.boolean() }).passthrough(),
  android_command_status: z.object({ found: z.boolean(), commandId: z.string().uuid(), command: z.record(z.string(), z.unknown()).nullable() }),
  exec: z.object({ ...execResultSchema.shape, ...route }).passthrough(),
  fs_read: fsReadResultSchema,
  fs_write: fsWrite,
  fs_list: z.object({ items: z.array(fileEntry) }).passthrough(),
  fs_manage: fsManage,
  process_start: z.object({ pid: z.number().int().positive(), command: z.string(), detached: z.boolean() }).passthrough(),
  process_list: z.object({ items: z.array(process) }).passthrough(),
  process_kill: z.object({ ok: z.boolean(), pid: z.number().int().positive(), alreadyExited: z.boolean() }).passthrough(),
  pty_list: z.object({ items: z.array(ptySession) }).passthrough(),
  pty_start: z.object({ id: z.string(), pid: z.number().int().positive(), shell: z.string(), cwd: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive(), state: z.string() }).passthrough(),
  pty_input: z.object({ ok: z.literal(true), id: z.string(), bytes: nonnegative }).passthrough(),
  pty_output: ptyOutput,
  pty_resize: z.object({ ok: z.literal(true), id: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }).passthrough(),
  pty_terminate: z.object({ ok: z.literal(true), id: z.string(), state: z.string(), exited: z.boolean(), terminationVerified: z.boolean() }).passthrough(),
  pty_remove: z.object({ id: z.string(), removed: z.literal(true) }).passthrough(),
  browser_session: z.object({ context: z.enum(["system", "user"]), sessionId: z.string().min(1).optional(), sessions: z.array(z.object({ sessionId: z.string(), engine: z.string() }).passthrough()).optional() }).passthrough().refine(value => value.sessions !== undefined || value.sessionId !== undefined, "browser result must identify a session or list sessions"),
  browser_action: browserActionResultSchema.extend({context:z.enum(["system","user"]).optional()}),
  browser_execution: browserExecutionResultSchema.extend({context:z.enum(["system","user"]).optional()}),
  batch_exec: z.object({ items: z.array(z.object({ index: nonnegative, ok: z.boolean(), device: z.string(), ...route }).passthrough()), errors: z.array(z.object({ index: nonnegative, ok: z.literal(false), device: z.string(), error: z.string(), ...route }).passthrough()), partial: z.boolean() }).passthrough(),
  batch_read: z.object({ items: z.array(z.object({ index: nonnegative, ok: z.boolean(), device: z.string(), ...route }).passthrough()), errors: z.array(z.object({ index: nonnegative, ok: z.literal(false), device: z.string(), error: z.string(), ...route }).passthrough()), partial: z.boolean() }).passthrough(),
  fleet_status: z.object({ devices: z.array(z.object({ device: z.string(), online: z.boolean() }).passthrough()) }).passthrough(),
  process_find: z.object({ device: z.string(), matched: nonnegative, returned: nonnegative, processes: z.array(process) }).passthrough(),
  repo_compare: z.object({ items: z.array(z.union([
    z.object({ index: nonnegative, ok: z.literal(true), result: z.object({ device: z.string(), path: z.string(), head: stringOrNull, clean: z.boolean().nullable() }).passthrough() }).passthrough(),
    z.object({ index: nonnegative, ok: z.literal(false), error: z.string() }).passthrough(),
  ])) }).passthrough(),
  docker_summary: z.object({ device: z.string(), available: z.boolean(), containers: z.object({ total: nonnegative, running: nonnegative, stopped: nonnegative, unhealthy: z.array(z.string().nullable()) }), images: nonnegative, matched: nonnegative, returned: nonnegative, matches: z.array(z.object({ name: stringOrNull, image: stringOrNull, state: stringOrNull, status: stringOrNull, ports: stringOrNull }).passthrough()), errors: z.array(z.string()) }).passthrough(),
  repo_snapshot: z.object({ head: stringOrNull, branch: stringOrNull, clean: z.boolean().nullable() }).passthrough(),
  repo_checkpoint: z.object({ mode: z.enum(["all", "staged", "paths"]), changes: z.array(z.object({ status: z.string(), path: z.string() }).passthrough()), created: z.boolean() }).passthrough(),
  repo_apply_patch: z.object({ ok: z.boolean() }).passthrough(),
  fs_edit: z.object({ path: z.string(), beforeSha256: z.string(), afterSha256: z.string(), replacements: z.array(nonnegative), changed: z.boolean() }).passthrough(),
  repo_fetch: z.object({ identity, context, result: z.object({ ok: z.literal(true), operation: z.literal("fetch"), remote: z.string() }).passthrough() }).passthrough(),
  repo_pull: z.object({ identity, context, result: z.object({ ok: z.literal(true), operation: z.literal("pull"), beforeHead: stringOrNull, afterHead: stringOrNull, headChanged: z.boolean() }).passthrough() }).passthrough(),
  repo_push: z.object({ identity, context, result: z.object({ ok: z.literal(true), operation: z.literal("push"), remote: z.string() }).passthrough() }).passthrough(),
  project_run: z.object({ identity, context, plan: z.object({}).passthrough() }).passthrough(),
  deploy_run: z.object({ identity, context }).passthrough().refine((value) => value.started === true || value.dryRun === true || (typeof value.job === "object" && value.job !== null), "deployment result must report a preview or submitted job"),
  service_inspect: z.object({ status: z.object({}).passthrough(), logs: z.object({}).passthrough() }).passthrough(),
  docker_snapshot: z.object({ available: z.boolean(), containers: z.array(z.object({}).passthrough()), images: z.array(z.object({}).passthrough()), compose: z.array(z.object({}).passthrough()), errors: z.array(z.string()) }).passthrough(),
  search: searchEnvelope,
  service_manage: z.object({ Id: z.string().optional(), Name: z.string().optional(), State: z.string().optional(), ActiveState: z.string().optional() }).passthrough().refine((value) => Boolean(value.Id || value.Name || value.State || value.ActiveState), "service status must identify the service"),
  service_logs: z.object({ name: z.string(), scope: z.enum(["user", "system"]), lines: z.array(z.string()).optional(), events: z.array(z.union([z.string(), z.object({}).passthrough()])).optional() }).passthrough(),
  system_metrics: z.object({ profile: z.enum(["light", "full"]), hostname: z.string(), platform: z.string(), cpuCount: z.number().int().positive(), totalMemoryBytes: z.number().positive(), freeMemoryBytes: z.number().nonnegative() }).passthrough(),
  search_start: z.object({ id: z.string(), status: z.string(), createdAt: z.string(), available: nonnegative.optional() }).passthrough(),
  search_results: searchPage,
  search_stop: z.object({ id: z.string(), status: z.string(), available: nonnegative }).passthrough(),
  search_sessions: z.object({ items: z.array(searchSession) }).passthrough(),
  search_remove: z.object({ id: z.string(), removed: z.literal(true) }).passthrough(),
  host_inventory: z.object({ device: z.string(), context: z.enum(["system", "user"]), profile: z.enum(["light", "full"]), partial: z.boolean(), errors: z.record(z.string(), z.string()) }).passthrough(),
  network_snapshot: z.object({ hostname: z.string(), platform: z.string() }).passthrough(),
  storage_snapshot: z.object({ blockdevices: z.array(z.object({}).passthrough()).optional(), disks: z.array(z.object({}).passthrough()).optional(), volumes: z.array(z.object({}).passthrough()).optional(), error: z.string().optional() }).passthrough().refine((value) => value.blockdevices !== undefined || value.disks !== undefined || value.volumes !== undefined || value.error !== undefined, "storage snapshot must contain storage fields"),
  gpu_snapshot: z.object({ backend: z.string().optional(), controllers: z.array(z.union([z.string(), z.object({ Name: z.string().nullable() }).passthrough()])).optional(), activeEngines: z.array(z.object({ InstanceName: z.string(), CookedValue: z.number() }).passthrough()).optional() }).passthrough().refine(value => value.backend !== undefined || (value.controllers !== undefined && value.activeEngines !== undefined), "GPU result must identify a backend or Windows controllers and engines"),
  package_managers: z.object({ platform: z.string(), managers: z.array(z.string()) }).passthrough(),
  package_manage: z.object({ manager: z.string(), action: z.enum(["list", "search", "install", "upgrade", "remove"]), ok: z.boolean(), code: z.number().int().nullable(), timedOut: z.boolean() }).passthrough(),
  host_power: z.object({ context: z.enum(["system", "user"]), ok: z.literal(true), scheduled: z.boolean(), submissionVerified: z.boolean().optional(), powerStateVerified: z.boolean(), dryRun: z.boolean().optional() }).passthrough().refine((value) => value.dryRun === true || value.submissionVerified === true, "power result must report submission or dry-run state"),
  wake_on_lan: z.object({ sent: z.boolean(), wakeVerified: z.boolean(), mac: z.string(), broadcast: z.string(), port: z.number().int().positive() }).passthrough(),
  job_start: z.object({ ...jobSummary.shape, ...route }).passthrough(),
  job_start_many: z.object({ items: z.array(jobManyItem), ...route }).passthrough(),
  job_status: z.object({ ...jobSummary.shape, ...route }).passthrough(),
  job_output: jobOutput,
  job_wait: jobFollow,
  job_output_since: jobFollow,
  job_cancel: z.object({ ...jobSummary.shape, ...route }).passthrough(),
  job_list: jobList,
  job_lineage: jobLineageResultSchema.extend(route),
  job_remove: z.object({ id: z.string(), removed: z.literal(true), ...route }).passthrough(),
  repo_git_path: z.object({ root: stringOrNull, gitDir: stringOrNull, commonGitDir: stringOrNull, gitPath: z.string(), resolved: stringOrNull }).passthrough(),
  desktop_monitors: z.object({ items: z.array(z.object({ deviceName: z.string(), primary: z.boolean(), bounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }) }).passthrough()) }).passthrough(),
  desktop_windows: z.object({ items: z.array(z.object({ handle: z.number().int().nonnegative(), pid: z.number().int().nonnegative(), title: z.string() }).passthrough()) }).passthrough(),
  desktop_uia: z.object({ elements: z.array(z.object({ elementId: z.string() }).passthrough()).optional(), element: z.object({ elementId: z.string() }).passthrough().optional(), ok: z.boolean().optional() }).passthrough().refine((value) => value.elements !== undefined || value.element !== undefined || value.ok !== undefined, "UIA result must identify elements, an element, or an action outcome"),
  desktop_session_status: z.object({ interactiveSession: z.boolean(), secureDesktopLikely: z.boolean(), inputDesktop: z.object({ accessible: z.boolean() }).passthrough() }).passthrough(),
  desktop_helper_status: z.object({ enabled: z.boolean(), transport: z.enum(["oneshot", "persistent"]), running: z.boolean() }).passthrough(),
  desktop_batch: z.object({ ok: z.boolean(), requested: nonnegative, executed: nonnegative, skipped: nonnegative, stoppedOnError: z.boolean(), results: z.array(desktopAction) }).passthrough(),
  desktop_screenshot: z.object({ originX: z.number(), originY: z.number(), sourceWidth: z.number().positive(), sourceHeight: z.number().positive(), width: z.number().positive(), height: z.number().positive(), scale: z.number().positive() }).passthrough(),
  desktop_focus: z.object({ ok: z.boolean(), handle: z.number().int().positive(), foregroundHandle: z.number().int().nonnegative() }).passthrough(),
  desktop_mouse: z.object({ ok: z.literal(true), x: z.number().int(), y: z.number().int() }).passthrough(),
  desktop_keyboard: z.object({ ok: z.boolean(), keys: z.array(z.string()).optional() }).passthrough(),
  desktop_clipboard_get: z.object({ text: z.string() }).passthrough(),
  desktop_clipboard_set: z.object({ ok: z.literal(true), chars: nonnegative }).passthrough(),
  desktop_launch: z.object({ ok: z.boolean(), launchAccepted: z.boolean(), verified: z.boolean(), verificationStatus: z.string(), target: z.string() }).passthrough(),
  browser_open: z.object({ ok: z.literal(true), browser: z.string(), executable: z.string(), url: z.string().url() }).passthrough(),
} as const;

export type ToolResultName = keyof typeof toolResultSchemas;
