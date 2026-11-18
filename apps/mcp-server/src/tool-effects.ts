// Explicit effect contracts shared by annotations, observation and recovery.
// Unknown tools/branches remain effectful. Never infer safety from names, error
// messages, shell commands, package-manager verbs or arbitrary browser scripts.
export type ToolEffect = "read" | "effectful";
export type ToolEffectContract = ToolEffect | "mixed";
export type EffectAnnotations = {
  readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean;
  openWorldHint?: boolean; title?: string;
};

export const readOnlyTools: ReadonlySet<string> = new Set([
  "android_observe", "android_command_status", "android_status",
  "batch_recover", "batch_read", "browser_execution", "capability_report", "coordination_capacity",
  "desktop_clipboard_get", "desktop_helper_status", "desktop_monitors", "desktop_observe",
  "desktop_screenshot", "desktop_session_status", "desktop_windows",
  "device_info", "device_contexts", "devices_list", "diagnostic_doctor", "fleet_status", "usage_report", "usage_window",
  "docker_snapshot", "docker_summary", "exec_recover", "fs_read", "fs_list",
  "gpu_snapshot", "host_inventory", "network_snapshot", "package_managers", "storage_snapshot", "system_metrics",
  "job_input_hash", "job_status", "job_output", "job_output_since", "job_wait", "job_list", "job_history", "job_lineage",
  "process_find", "process_list", "pty_list", "pty_output",
  "repo_compare", "repo_git_path", "repo_snapshot", "search", "search_results", "search_sessions", "search_status",
  "secret_list", "secret_status", "service_inspect", "service_logs",
  "open_remote_control_console", "dashboard_snapshot", "operation_inspect", "result_recover",
]);

type Input = Record<string, unknown>;
const objectInput = (value: unknown): Input | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Input : undefined;
const readUia = (input: Input) => input.action === undefined || input.action === "query" || input.action === "inspect";
const readMouse = (input: Input) => input.action === "position" && [input.x, input.y, input.button, input.delta].every(value => value === undefined);
const readDesktopBatch = (input: Input) => Array.isArray(input.actions) && input.actions.length > 0 && input.actions.every(value => {
  const action = objectInput(value);
  if (!action) return false;
  if (typeof action.kind === "string" && ["monitors", "windows", "session", "wait", "screenshot", "clipboardGet"].includes(action.kind)) return true;
  return action.kind === "uia" ? readUia(action) : action.kind === "mouse" && readMouse(action);
});
// These predicates inspect only audited discriminants after SDK input parsing.
// Their arguments are never copied into the observation journal.
const readBranches = new Map<string, (input: Input) => boolean>([
  ["fs_manage", input => input.operation === "stat"],
  ["service_manage", input => input.action === "status"],
  ["resource_coordination", input => input.action === "inspect" || input.action === "inspect_recovery"],
  ["desktop_act", input => input.mode === "status"],
  ["desktop_uia", readUia],
  ["desktop_mouse", readMouse],
  ["desktop_batch", readDesktopBatch],
  ["browser_session", input => input.action === "list" || input.action === "status"],
  ["host_power", input => input.dryRun === true],
  ["wake_on_lan", input => input.dryRun === true],
]);

export function toolEffectContract(tool: string): ToolEffectContract {
  return readOnlyTools.has(tool) ? "read" : readBranches.has(tool) ? "mixed" : "effectful";
}

/** Tool-level hints describe every branch; a mixed tool is never advertised read-only. */
export function toolEffectAnnotations(tool: string, explicit?: EffectAnnotations): EffectAnnotations {
  if (readOnlyTools.has(tool) && explicit?.readOnlyHint !== false && explicit?.destructiveHint !== true) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...explicit };
  }
  // Preserve conservative metadata, but an optimistic hint cannot add a new
  // read contract or make a mixed tool's write branches appear read-only.
  return { ...explicit, readOnlyHint: false };
}

export function classifyToolEffect(tool: string, input?: unknown, explicit?: EffectAnnotations): ToolEffect {
  if (readOnlyTools.has(tool)) return toolEffectAnnotations(tool, explicit).readOnlyHint ? "read" : "effectful";
  const rule = readBranches.get(tool), args = objectInput(input);
  return rule && args && rule(args) ? "read" : "effectful";
}

// Keep the strict v1 journal schema readable by rollback controllers. Only this
// bounded marker carries per-call read evidence for a mixed tool after restart.
// The original safe category is preserved in full; an oversized one is not
// truncated into false evidence. The original result remains in its receipt.
const observationFailurePrefix = "observation_failed:v1:";
export function observationFailureKind(kind: string | undefined): string | undefined {
  if (!kind || !/^[a-zA-Z0-9_]+$/.test(kind)) return undefined;
  const marked = `${observationFailurePrefix}${kind}`;
  return marked.length <= 64 ? marked : undefined;
}
export function isObservationFailureKind(kind: unknown): boolean {
  return typeof kind === "string" && kind.startsWith(observationFailurePrefix) &&
    observationFailureKind(kind.slice(observationFailurePrefix.length)) === kind;
}
