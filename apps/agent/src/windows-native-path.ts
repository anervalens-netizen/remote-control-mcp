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

/** Robocopy handles long DOS/UNC paths but rejects their native namespace prefix. */
export function windowsRobocopyPath(target: string): string {
  const native = windowsNativePath(target);
  if (native.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\") return "\\\\" + native.slice(8);
  if (native.startsWith("\\\\?\\") && /^[A-Za-z]:/.test(native.slice(4))) return native.slice(4);
  return native;
}
