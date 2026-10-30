// Explicit effect contracts shared by annotations and observation. Unknown tools
// remain effectful for recovery; never infer safety from a tool name or error.
export const readOnlyTools = new Set([
  "android_observe", "android_command_status", "batch_recover", "pty_output", "search_results", "search_status", "exec_recover", "fs_read", "fs_list", "batch_read", "job_status", "job_output", "job_output_since", "job_wait", "job_list", "job_history", "job_lineage", "device_info", "device_contexts", "devices_list", "service_inspect", "service_logs", "network_snapshot", "android_status", "repo_snapshot",
]);
