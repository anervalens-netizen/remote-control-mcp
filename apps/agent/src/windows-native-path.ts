import path from "node:path";

/**
 * Windows PowerShell/.NET Framework do not inherit Node's long-path handling.
 * Resolve the caller's path once and pass its extended-length form as a literal
 * environment value to native file/ACL APIs. UNC and already-namespaced paths
 * retain their meaning; paths are never interpolated into a PowerShell script.
 */
export function windowsNativePath(target: string): string {
  return path.win32.toNamespacedPath(target);
}
