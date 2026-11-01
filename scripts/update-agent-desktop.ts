import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { semanticManifestSchema } from "../packages/protocol/src/semantic-desktop.ts";
import { atomicWriteJson } from "../apps/agent/src/state.ts";
import { digest, loadSemanticManifest, semanticManifestPath, semanticSession } from "../apps/agent/src/semantic-desktop-env.ts";
import { qualifySemanticDesktop } from "../apps/agent/src/semantic-desktop-qualification.ts";

const run = promisify(execFile);
export const candidateSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  provenanceVerified: z.literal(true),
  allowHeadless: z.boolean().default(false),
}).strict();
export function validateArchiveEntries(names: string[], verbose: string[]) {
  const allowed = new Set(["agent-desktop", "agent-desktop.exe", "agent-desktop-linux-clipboard-owner"]);
  if (!names.length || names.some(n => !allowed.has(n)) || new Set(names).size !== names.length || verbose.some(line => line && line[0] !== "-")) throw new Error("unsafe_release_archive");
}
export async function installCandidate(raw: unknown) {
  const candidate = candidateSchema.parse(raw);
  const target = process.platform === "win32" ? "x86_64-pc-windows-msvc" : process.platform === "linux" ? "x86_64-unknown-linux-gnu" : "unsupported";
  if (process.arch !== "x64" || target === "unsupported") throw new Error("platform_unsupported");
  const expectedUrl = `https://github.com/vercel-labs/agent-desktop/releases/download/v${candidate.version}/agent-desktop-v${candidate.version}-${target}.tar.gz`;
  if (candidate.url !== expectedUrl) throw new Error("release_url_mismatch");
  const activePath = semanticManifestPath();
  const previous = existsSync(activePath) ? semanticManifestSchema.parse(JSON.parse(readFileSync(activePath, "utf8"))) : undefined;
  if (previous?.archiveSha256 === candidate.sha256 && previous.provenanceVerified) {
    loadSemanticManifest(); return { ok: true, changed: false, engineVersion: previous.engineVersion };
  }
  if (previous && candidate.version.split(".")[0] !== previous.engineVersion.split(".")[0]) throw new Error("engine_major_requires_adapter_review");
  const base = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RemoteControlMCP", "tools", "agent-desktop") : path.join(os.homedir(), ".local", "opt", "agent-desktop");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = path.join(base, `managed-v${candidate.version}-${candidate.sha256.slice(0, 16)}`);
  const staging = `${directory}.staging`;
  if (existsSync(staging)) throw new Error("candidate_staging_exists_inspect_before_retry");
  mkdirSync(staging, { mode: 0o700 });
  let activated = false;
  try {
    const response = await fetch(candidate.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`release_download_http_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 64 * 1024 * 1024 || digest(bytes) !== candidate.sha256) throw new Error("archive_digest_mismatch");
    const archive = path.join(staging, "release.tar.gz"); writeFileSync(archive, bytes, { mode: 0o600 });
    const names = (await run("tar", ["-tzf", archive], { timeout: 10000 })).stdout.trim().split(/\r?\n/);
    const verbose = (await run("tar", ["-tvzf", archive], { timeout: 10000 })).stdout.trim().split(/\r?\n/);
    validateArchiveEntries(names, verbose);
    const extracted = path.join(staging, "extracted"); mkdirSync(extracted);
    await run("tar", ["-xzf", archive, "-C", extracted], { timeout: 10000 });
    if (existsSync(directory)) {
      // A known failed qualification may be retried against the same immutable bytes.
      for (const name of names) if (digest(readFileSync(path.join(directory, name))) !== digest(readFileSync(path.join(extracted, name)))) throw new Error("existing_candidate_integrity_mismatch");
    } else { const { renameSync } = await import("node:fs"); renameSync(extracted, directory); }
    const binary = path.join(directory, process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop");
    const manifest = semanticManifestSchema.parse({ version: 1, engineVersion: candidate.version, jsonVersion: "2.5", binary, sha256: digest(readFileSync(binary)),
      files: names.filter(name => path.join(directory, name) !== binary).map(name => ({ path: path.join(directory, name), sha256: digest(readFileSync(path.join(directory, name))) })),
      upstreamCommit: candidate.commit, archiveSha256: candidate.sha256, provenanceVerified: true });
    const version = JSON.parse((await run(binary, ["version"], { timeout: 10000 })).stdout);
    if (version.version !== "2.5" || version.data?.version !== candidate.version || !version.ok) throw new Error("candidate_contract_mismatch");
    let qualification: unknown;
    if (candidate.allowHeadless) {
      const session = await semanticSession(false);
      const status = JSON.parse((await run(binary, ["status"], { timeout: 10000, env: session.env })).stdout);
      if (!status.ok || status.version !== "2.5") throw new Error("candidate_status_failed");
      qualification = { ok: true, scope: "binary_and_contract_only", desktopEffectVerified: false };
    } else qualification = await qualifySemanticDesktop(manifest);
    atomicWriteJson(path.join(directory, "qualification.json"), qualification);
    if (previous) atomicWriteJson(`${activePath}.previous`, previous);
    atomicWriteJson(activePath, manifest); activated = true;
    // Read the activated pointer and re-hash its exact files before reporting success.
    if (loadSemanticManifest().sha256 !== manifest.sha256) throw new Error("activation_readback_mismatch");
    return { ok: true, changed: true, engineVersion: candidate.version, archiveSha256: candidate.sha256, qualification, previousVersion: previous?.engineVersion ?? null };
  } catch (error) {
    if (activated && previous) atomicWriteJson(activePath, previous);
    else if (activated) rmSync(activePath, { force: true });
    throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "rollback") {
      const activePath = semanticManifestPath();
      const previous = semanticManifestSchema.parse(JSON.parse(readFileSync(`${activePath}.previous`, "utf8")));
      for (const file of [{ path: previous.binary, sha256: previous.sha256 }, ...previous.files]) if (digest(readFileSync(file.path)) !== file.sha256) throw new Error("rollback_integrity_mismatch");
      atomicWriteJson(activePath, previous);
      console.log(JSON.stringify({ ok: true, rollback: true, engineVersion: previous.engineVersion }));
    } else console.log(JSON.stringify(await installCandidate(JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")))));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "update_failed" })); process.exitCode = 1; }
}
