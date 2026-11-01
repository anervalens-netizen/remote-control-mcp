import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { semanticActSchema, semanticObserveSchema, type SemanticAct, type SemanticObserve, type SemanticManifest } from "../../../packages/protocol/src/semantic-desktop.ts";
import { atomicWriteJson, stateRoot } from "./state.ts";
import { desktopSequence } from "./desktop-sequence.ts";
import { digest, loadSemanticManifest, semanticSession } from "./semantic-desktop-env.ts";

type Envelope = { version: string; ok: boolean; command?: string; data?: Record<string, any>; error?: Record<string, any> };
type Observation = { id: string; createdAt: number; binding: string; refs: string[]; request: SemanticObserve };
type Context = { manifest: SemanticManifest; env: NodeJS.ProcessEnv; binding: string };
type Dependencies = { root?: string; manifest?: () => SemanticManifest; session?: typeof semanticSession; invoke?: (ctx: Context, args: string[], timeout: number) => Promise<Envelope> };
const run = promisify(execFile);
function failure(code: string, delivery = "not_delivered") { return { ok: false, error: { code, disposition: { delivery, retry: delivery === "not_delivered" ? "safe" : "unsafe" } } }; }
export function collectRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const walk = (v: unknown) => { if (v && typeof v === "object") for (const [key, item] of Object.entries(v)) { if (key === "ref_id" && typeof item === "string" && /^@[A-Za-z0-9_-]+:e\d+$/.test(item)) refs.add(item); else if (item && typeof item === "object") walk(item); } };
  walk(value); return [...refs];
}
export class SemanticDesktop {
  private root: string;
  private deps: Dependencies;
  private secured = false;
  constructor(deps: Dependencies = {}) { this.deps = deps; this.root = deps.root ?? path.join(stateRoot, "semantic-desktop-v1"); }
  private directory(name: string) {
    if (!this.secured) {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      if (lstatSync(this.root).isSymbolicLink()) throw new Error("semantic_state_root_must_not_be_symbolic");
      if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[IO.Directory]::GetAccessControl($env:RCMCP_SEMANTIC_PRIVATE_ROOT,[Security.AccessControl.AccessControlSections]::Access);$acl.SetAccessRuleProtection($true,$false);foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)};foreach($identity in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};[IO.Directory]::SetAccessControl($env:RCMCP_SEMANTIC_PRIVATE_ROOT,$acl)"], { env: { ...process.env, RCMCP_SEMANTIC_PRIVATE_ROOT: this.root }, timeout: 5000, windowsHide: true, stdio: "pipe" });
      if (process.platform !== "win32") chmodSync(this.root, 0o700);
      this.secured = true;
    }
    const dir = path.join(this.root, name); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir;
  }
  private async context(graphical = true): Promise<Context> {
    const manifest = (this.deps.manifest ?? loadSemanticManifest)();
    const session = await (this.deps.session ?? semanticSession)(graphical);
    const binding = digest(`${manifest.sha256}:${manifest.jsonVersion}:${session.fingerprint}`);
    return { manifest, binding, env: { ...session.env, AGENT_DESKTOP_HOME: this.directory(`native-${binding}`) } };
  }
  private async invoke(ctx: Context, args: string[], timeout: number): Promise<Envelope> {
    let value: Envelope;
    if (this.deps.invoke) value = await this.deps.invoke(ctx, args, timeout);
    else {
      let stdout: string;
      try { ({ stdout } = await run(ctx.manifest.binary, args, { env: ctx.env, timeout: timeout + 3000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8" })); }
      catch (error) {
        const e = error as { stdout?: string; killed?: boolean; code?: unknown };
        if (e.killed || !e.stdout) throw new Error("native_execution_uncertain");
        stdout = e.stdout;
      }
      value = JSON.parse(stdout.trim());
    }
    if (!value || value.version !== "2.5" || typeof value.ok !== "boolean") throw new Error("native_contract_mismatch");
    return value;
  }
  private readObservation(id: string, ctx: Context, ref: string): Observation {
    const obs = JSON.parse(readFileSync(path.join(this.directory("observations"), `${id}.json`), "utf8")) as Observation;
    if (obs.binding !== ctx.binding || Date.now() - obs.createdAt > 10 * 60_000 || !obs.refs.includes(ref)) throw new Error("stale_observation");
    return obs;
  }
  private async observeInner(input: SemanticObserve, ctx: Context) {
    const args: string[] = [];
    let parent: Observation | undefined;
    if (input.ref) {
      if (!input.observationId) return failure("observation_id_required");
      parent = this.readObservation(input.observationId, ctx, input.ref);
    }
    if (input.kind === "status") args.push("status");
    else if (input.kind === "apps") args.push("list-apps");
    else if (input.kind === "windows") args.push("list-windows");
    else if (input.kind === "get") {
      if (!input.ref || !parent) return failure("observation_ref_required");
      args.push("get", input.ref, "--property", input.property);
    } else {
      args.push("snapshot", "--compact", "--max-depth", String(input.maxDepth), "--timeout-ms", String(input.timeoutMs));
      if (input.interactiveOnly) args.push("-i");
      if (input.ref) args.push("--root", input.ref);
      else {
        if (input.windowId) args.push("--window-id", input.windowId);
        if (input.surface) args.push("--surface", input.surface);
        if (input.skeleton && (!input.surface || input.surface === "window")) args.push("--skeleton");
      }
    }
    if (input.app && ["snapshot", "apps", "windows"].includes(input.kind) && !input.ref) args.push("--app", input.app);
    const result = await this.invoke(ctx, args, input.timeoutMs);
    if (!result.ok || input.kind !== "snapshot") return { ...result, engineVersion: ctx.manifest.engineVersion };
    const id = randomUUID();
    const request = parent ? { ...parent.request, ...input, app: parent.request.app, windowId: parent.request.windowId } : input;
    atomicWriteJson(path.join(this.directory("observations"), `${id}.json`), { id, createdAt: Date.now(), binding: ctx.binding, refs: collectRefs(result.data), request } satisfies Observation);
    return { ...result, observationId: id, engineVersion: ctx.manifest.engineVersion };
  }
  observe(raw: unknown): Promise<Record<string, any>> {
    const input = semanticObserveSchema.parse(raw);
    return desktopSequence(async () => { try { return await this.observeInner(input, await this.context(input.kind !== "status")); } catch (error) { return failure(error instanceof Error ? error.message : "observation_failed"); } });
  }
  act(raw: unknown): Promise<Record<string, any>> {
    const input = semanticActSchema.parse(raw);
    return desktopSequence(async () => {
      const file = path.join(this.directory("commands"), `${input.commandId}.json`);
      const hash = digest(JSON.stringify(input));
      if (existsSync(file)) {
        const old = JSON.parse(readFileSync(file, "utf8"));
        if (input.mode !== "status" && old.hash !== hash) return failure("command_id_conflict");
        return { ...(old.result ?? failure("command_outcome_unknown", "delivery_uncertain")), commandId: input.commandId, recovered: true, replayed: false };
      }
      if (input.mode === "status") return failure("command_not_found");
      if (!input.observationId || !input.ref || !input.action) return failure("observation_ref_action_required");
      if (["set-value", "type", "select"].includes(input.action) && input.value === undefined) return failure("value_required");
      let ctx: Context; let obs: Observation;
      try { ctx = await this.context(); obs = this.readObservation(input.observationId, ctx, input.ref); }
      catch { return failure("stale_observation_or_session_unavailable"); }
      const fd = openSync(file, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ hash, startedAt: Date.now() })); fsyncSync(fd); } finally { closeSync(fd); }
      if (process.platform !== "win32") { const dir = openSync(path.dirname(file), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
      let result: Record<string, any>;
      try {
        const args = [input.action, "--timeout-ms", String(input.timeoutMs)];
        if (input.headed) args.push("--headed");
        args.push("--", input.ref);
        if (["set-value", "type", "select"].includes(input.action)) args.push(input.value!);
        result = await this.invoke(ctx, args, input.timeoutMs);
        const disposition = result.ok ? result.data?.disposition : result.error?.disposition;
        if (!disposition || !["unknown", "not_delivered", "delivery_uncertain", "delivered_unverified", "delivered_verified"].includes(disposition.delivery)) result = failure("action_delivery_unproven", "delivery_uncertain");
      } catch { result = failure("native_execution_uncertain", "delivery_uncertain"); }
      // Persist delivery before attempting a readback. A crash must never replay an effect.
      result = { ...result, commandId: input.commandId, engineVersion: ctx.manifest.engineVersion, applicationEffectVerified: false };
      atomicWriteJson(file, { hash, result, finishedAt: Date.now() });
      if (input.observeAfter) {
        try { result.observation = await this.observeInner({ ...obs.request, kind: "snapshot", ref: undefined, observationId: undefined }, ctx); }
        catch { result.observation = failure("post_action_observation_failed"); }
        atomicWriteJson(file, { hash, result, finishedAt: Date.now() });
      }
      return result;
    });
  }
}
export const semanticDesktop = new SemanticDesktop();
