import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve existing ancestors on the selected host, including symlink/junction
 * targets. Missing descendants are appended only after a real existing prefix
 * is found. Dangling links and inaccessible ancestors are errors, not evidence
 * that the source and destination are independent. No paths are created. */
export async function resolveProspectivePath(input: string) {
  // Windows resolves drive-relative/root-relative forms using native DOS
  // normalization. On POSIX, do not collapse dot segments before symlinks.
  let candidate = process.platform === "win32" ? path.resolve(input)
    : path.isAbsolute(input) ? input : process.cwd() + path.sep + input;
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = await realpath(candidate);
      return { resolvedPath: path.join(resolved, ...missing), existingPath: resolved, missingComponents: missing.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        const entry = await lstat(candidate);
        if (entry.isSymbolicLink()) throw new Error("Cannot resolve a dangling path link");
      } catch (inspection) {
        if ((inspection as NodeJS.ErrnoException).code !== "ENOENT") throw inspection;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      const leaf = path.basename(candidate);
      if (leaf === "." || leaf === "..") throw new Error("Cannot resolve dot segments through a missing path ancestor");
      missing.unshift(leaf);
      candidate = parent;
    }
  }
}
