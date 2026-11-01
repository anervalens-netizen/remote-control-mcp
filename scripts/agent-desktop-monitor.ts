import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AgentClient, type AgentEndpointContext } from "../apps/mcp-server/src/agent-client.ts";
import { atomicWriteJson } from "../apps/agent/src/state.ts";
import { digest } from "../apps/agent/src/semantic-desktop-env.ts";

const run = promisify(execFile);
const configSchema = z.object({
  stateDirectory: z.string(),
  targets: z.array(z.object({ device: z.string(), context: z.enum(["user", "desktop"]), node: z.string(), runner: z.string(), windows: z.boolean().default(false), allowHeadless: z.boolean().default(false) })),
  notify: z.object({ device: z.string(), command: z.string(), context: z.enum(["user", "desktop"]).default("user") }).optional(),
});
type State = { release?: any; checkedAt?: number; targets: Record<string, any>; events: Array<{ id: string; message: string; createdAt: string; notificationJobId?: string; notified?: boolean }> };
export function quoteArgument(value: string, windows: boolean) { return windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`; }
export function candidateAsset(release: any, windows: boolean) {
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name) || release.prerelease || release.draft) throw new Error("invalid_stable_release");
  const target = windows ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
  const name = `agent-desktop-${release.tag_name}-${target}.tar.gz`;
  const asset = release.assets?.find((a: any) => a.name === name);
  const url = `https://github.com/vercel-labs/agent-desktop/releases/download/${release.tag_name}/${name}`;
  if (asset?.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset?.digest ?? "")) throw new Error("release_asset_unverified");
  return { name, url, sha256: asset.digest.slice(7) as string };
}
async function github(relative: string) {
  const response = await fetch(`https://api.github.com/repos/vercel-labs/agent-desktop/${relative}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "remote-control-mcp-updater" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`github_http_${response.status}`);
  return response.json() as Promise<any>;
}
export async function monitor(configFile: string) {
  const config = configSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
  if (!path.isAbsolute(config.stateDirectory)) throw new Error("absolute_state_directory_required");
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(config.stateDirectory, "state.json");
  const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { targets: {}, events: [] };
  const save = () => atomicWriteJson(stateFile, state);
  const emit = (key: string, message: string) => { const id = digest(key); if (!state.events.some(e => e.id === id)) state.events.push({ id, message, createdAt: new Date().toISOString() }); save(); };
  const client = new AgentClient();
  if (!state.release || !state.checkedAt || Date.now() - state.checkedAt > 6 * 3600_000 || process.argv.includes("--refresh")) {
    try {
      const release = await github("releases/latest");
      candidateAsset(release, false); candidateAsset(release, true);
      const ref = await github(`git/ref/tags/${release.tag_name}`);
      let commit = ref.object;
      if (commit.type === "tag") commit = (await github(`git/tags/${commit.sha}`)).object;
      if (commit.type !== "commit" || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("release_commit_unresolved");
      const releaseIdentity = digest(JSON.stringify([release.tag_name, commit.sha, candidateAsset(release, false).sha256, candidateAsset(release, true).sha256]));
      if (state.release && state.release.identity !== releaseIdentity) emit(`release:${releaseIdentity}`, `agent-desktop: versiune disponibilă ${release.tag_name}. Verificarea și actualizarea automată au început.`);
      state.release = { ...release, commit: commit.sha, identity: releaseIdentity }; state.checkedAt = Date.now(); save();
    } catch (error) { emit(`discovery:${String(error)}`, `agent-desktop: verificarea versiunilor a eșuat (${error instanceof Error ? error.message : "eroare"}).`); }
  }
  const release = state.release;
  if (release) for (const target of config.targets) {
    const asset = candidateAsset(release, target.windows);
    const key = `${target.device}:${asset.sha256}`;
    const current = state.targets[key] ??= { attempts: 0, phase: "pending" };
    if (current.phase === "verified" || current.phase === "blocked") continue;
    try {
      const info: any = await client.info(target.device, target.context, { timeoutMs: 5000 });
      if (info.arch !== "x64") throw new Error("target_architecture_unsupported");
      if ((info.platform === "win32") !== target.windows) throw new Error("target_platform_mismatch");
      if (current.jobId) {
        const job: any = await client.jobStatus(target.device, current.jobId, target.context);
        if (["running", "cancelling"].includes(job.state)) continue;
        if (job.state !== "completed" || job.exitCode !== 0) {
          current.phase = "blocked"; current.jobState = job.state; current.exitCode = job.exitCode; save();
          emit(`failed:${key}`, `agent-desktop ${release.tag_name}: actualizarea pe ${target.device} a eșuat; versiunea anterioară rămâne disponibilă. Este necesară verificarea rezultatului.`); continue;
        }
        const probe = await client.semanticDesktopObserve(target.device, { kind: "status" }, target.context);
        if (probe.ok !== true || probe.engineVersion !== release.tag_name.slice(1)) throw new Error("activated_engine_readback_mismatch");
        current.phase = "verified"; current.verifiedAt = new Date().toISOString(); save();
        emit(`complete:${key}`, `agent-desktop ${release.tag_name}: actualizat și verificat pe ${target.device}.`); continue;
      }
      if (current.phase === "starting" || current.phase === "uncertain") {
        try { const job: any = await client.jobStatusByKey(target.device, current.operationKey, target.context); if (job?.id) { current.jobId = job.id; current.phase = "running"; save(); } }
        catch { current.phase = "uncertain"; save(); }
        continue;
      }
      const archive = path.join(config.stateDirectory, asset.name);
      if (!existsSync(archive) || digest(readFileSync(archive)) !== asset.sha256) {
        const response = await fetch(asset.url, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`archive_http_${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 64 * 1024 * 1024 || digest(bytes) !== asset.sha256) throw new Error("archive_integrity_mismatch");
        writeFileSync(archive, bytes, { mode: 0o600 });
      }
      const proofFile = `${archive}.verified.json`;
      if (!existsSync(proofFile) || JSON.parse(readFileSync(proofFile, "utf8")).sourceCommit !== release.commit) {
        const proof = await run("gh", ["attestation", "verify", archive, "--repo", "vercel-labs/agent-desktop", "--source-digest", release.commit, "--signer-workflow", "vercel-labs/agent-desktop/.github/workflows/release.yml", "--format", "json"], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        atomicWriteJson(proofFile, { sha256: asset.sha256, sourceCommit: release.commit, verifiedAt: new Date().toISOString(), result: JSON.parse(proof.stdout) });
      } else if (JSON.parse(readFileSync(proofFile, "utf8")).sha256 !== asset.sha256) throw new Error("cached_provenance_mismatch");
      const candidate = { version: release.tag_name.slice(1), url: asset.url, sha256: asset.sha256, commit: release.commit, provenanceVerified: true, allowHeadless: target.allowHeadless };
      const payload = Buffer.from(JSON.stringify(candidate)).toString("base64");
      const command = `${target.windows ? "& " : ""}${quoteArgument(target.node, target.windows)} ${quoteArgument(target.runner, target.windows)} ${quoteArgument(payload, target.windows)}`;
      current.operationKey = `agent-desktop-${asset.sha256.slice(0, 16)}-${digest(target.device).slice(0, 10)}-${++current.attempts}`;
      current.phase = "starting"; save();
      try {
        const job: any = await client.jobStart(target.device, { command, idempotencyKey: current.operationKey }, target.context);
        if (!job.id) throw new Error("job_receipt_missing");
        current.jobId = job.id; current.phase = "running"; save();
      } catch { current.phase = "uncertain"; save(); emit(`uncertain:${key}`, `agent-desktop: rezultat incert la pornirea actualizării pe ${target.device}; comanda nu va fi repetată automat.`); }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unavailable";
      current.lastError = message; current.lastAttemptAt = new Date().toISOString(); save();
      emit(`pending:${key}`, `agent-desktop ${release.tag_name}: actualizare în așteptare pe ${target.device}; dispozitivul sau verificarea necesară nu este disponibilă.`);
    }
  }
  if (config.notify) for (const event of state.events.filter(e => !e.notified)) {
    try {
      if (event.notificationJobId) {
        const job: any = await client.jobStatus(config.notify.device, event.notificationJobId, config.notify.context);
        if (job.state === "completed" && job.exitCode === 0) { event.notified = true; save(); }
        continue;
      }
      const encoded = Buffer.from(event.message).toString("base64");
      const job: any = await client.jobStart(config.notify.device, { command: `${config.notify.command} '${encoded}'`, idempotencyKey: `agent-desktop-notify-${event.id}` }, config.notify.context as AgentEndpointContext);
      if (job.id) { event.notificationJobId = job.id; save(); }
    } catch { /* Keep the event for the next scheduled pass; stable job key prevents duplicate sends. */ }
  }
  return { ok: true, release: release?.tag_name ?? null, targets: Object.fromEntries(Object.entries(state.targets).map(([key, value]) => [key, { phase: value.phase, jobId: value.jobId, lastError: value.lastError }])), pendingNotifications: state.events.filter(e => !e.notified).length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await monitor(process.argv[2] ?? ""))); }
  catch (error) { console.error(error instanceof Error ? error.message : "monitor_failed"); process.exitCode = 1; }
}
