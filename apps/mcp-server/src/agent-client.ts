import { jobRecoveryPayload, type JobRecoveryPayload } from "../../../packages/protocol/src/job-recovery.ts";
import type { JobFollowInput, ProjectRunInput } from "../../../packages/protocol/src/project.ts";
import type { DesktopUiaInput, DesktopWindowsInput, DesktopBatchInput } from "../../../packages/protocol/src/desktop.ts";
import { filterProcesses, summarizeDockerSnapshot, type DockerSnapshot } from "../../../packages/protocol/src/filtering.ts";
import fs from "node:fs";
import type { DeviceConfig, ExecRequest, ExecResult } from "../../../packages/protocol/src/index.ts";
import type { AndroidController } from "./android-controller.ts";
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_TRANSFER_TIMEOUT_MS,
  HTTP_GRACE_MS,
  createDeadline,
  withTimeoutGrace,
} from "../../../packages/protocol/src/deadline.ts";

type DeviceFile = { devices: DeviceConfig[] };
export type AgentContext = "system" | "user";
export type AgentEndpointContext = AgentContext | "desktop";
export type AgentRequestOptions = { timeoutMs?: number; signal?: AbortSignal };

function configuredTimeout(): number {
  const parsed = Number(process.env.RCMCP_HTTP_TIMEOUT_MS ?? DEFAULT_HTTP_TIMEOUT_MS);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_HTTP_TIMEOUT_MS;
}

export class AgentRequestError extends Error {
  readonly device: string;
  readonly context: AgentEndpointContext;
  readonly route: string;
  readonly kind: "timeout" | "network" | "http" | "protocol" | "context" | "cancelled";
  readonly status: number | undefined;
  readonly recovery: JobRecoveryPayload | undefined;
  readonly responseBodyTruncated: boolean;

  constructor(message: string, device: string, context: AgentEndpointContext, route: string, kind: "timeout" | "network" | "http" | "protocol" | "context" | "cancelled", status?: number, recovery?: JobRecoveryPayload, responseBodyTruncated = false) {
    super(message);
    this.name = "AgentRequestError";
    this.device = device;
    this.context = context;
    this.route = route;
    this.kind = kind;
    this.status = status;
    this.recovery = recovery;
    this.responseBodyTruncated = responseBodyTruncated;
  }
}

function boundedHttpDiagnostic(text: string): { diagnostic: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  const budget = 8192;
  if (bytes.length <= budget) return { diagnostic: text, truncated: false };
  return { diagnostic: bytes.subarray(0, budget - 8).toString("utf8") + "…", truncated: true };
}

function ordinaryHttpDiagnostic(value: unknown): { diagnostic: string; truncated: boolean } {
  if (typeof value === "string") return boundedHttpDiagnostic(value);
  const fields = ["error", "message", "code", "details"] as const;
  const select = (item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(fields.filter(key => Object.hasOwn(item, key)).map(key => [key, (item as Record<string, unknown>)[key]]))
    : item;
  const selected = Array.isArray(value) ? value.map(select) : select(value);
  // Keep the agent's ordinary error/validation contract, not arbitrary body
  // fields. Named credentials inside diagnostics are never echoed back.
  const sensitive = /^(authorization|cookie|set-cookie)$|(?:password|passwd|secret|token|credentials?|api[_-]?key|private[_-]?key)$/i;
  const diagnostic = JSON.stringify(selected, (key, item) => sensitive.test(key) ? "[redacted]" : item);
  return boundedHttpDiagnostic(diagnostic === "{}" ? "" : diagnostic ?? "");
}

async function readAgentError(response: Response): Promise<{ recovery?: JobRecoveryPayload; diagnostic?: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      // Allow old agents' diagnostics above 64 KiB without truncating the JSON
      // before parsing. New agents already emit a bounded typed receipt.
      if (size > 1024 * 1024) { await reader.cancel(); return { truncated: true }; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks).toString("utf8");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return boundedHttpDiagnostic(raw); }
  try {
    const recovery = jobRecoveryPayload(value);
    return recovery ? { recovery, truncated: false } : ordinaryHttpDiagnostic(value);
  } catch {
    // A parsed body's excessive depth must not bypass field selection/redaction
    // by falling back to its raw JSON representation.
    return { diagnostic: "HTTP error diagnostics exceeded formatting limits", truncated: true };
  }
}

export function loadDevices(): DeviceConfig[] {
  const inline = process.env.RCMCP_DEVICES_JSON;
  const file = process.env.RCMCP_DEVICES_FILE;
  if (inline) return (JSON.parse(inline) as DeviceFile).devices;
  if (file) return (JSON.parse(fs.readFileSync(file, "utf8")) as DeviceFile).devices;
  return [{ name: "server", url: "http://127.0.0.1:45231" }];
}

export class AgentClient {
  readonly devices: DeviceConfig[];
  readonly token: string | undefined;
  readonly requestTimeoutMs: number;
  readonly androidController: AndroidController | undefined;

  constructor(devices = loadDevices(), token = process.env.RCMCP_AGENT_TOKEN, requestTimeoutMs = configuredTimeout(), androidController?: AndroidController) {
    const configured = androidController?.descriptors().map((descriptor) => ({
      name: descriptor.name, url: descriptor.url, transport: "android-reverse" as const,
    })) ?? [];
    const names = new Set<string>();
    for (const device of devices) {
      const key = device.name.toLowerCase();
      if (names.has(key)) throw new Error(`Duplicate device name: ${device.name}`);
      names.add(key);
    }
    for (const device of configured) {
      const key = device.name.toLowerCase();
      if (names.has(key)) throw new Error(`Android device name collides with an existing device: ${device.name}`);
      names.add(key);
    }
    this.devices = [...devices, ...configured];
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
    this.androidController = androidController;
  }

  getDevice(name: string): DeviceConfig {
    const device = this.devices.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!device) throw new Error(`Unknown device: ${name}`);
    return device;
  }

  hasUserContext(name: string): boolean {
    const device = this.getDevice(name);
    if (device.transport === "android-reverse") return true;
    return Boolean(device.userUrl ?? device.desktopUrl);
  }

  configuredContexts(name: string) {
    const device = this.getDevice(name);
    if (device.transport === "android-reverse") return { system: false, user: true, desktop: false } as const;
    return { system: true, user: Boolean(device.userUrl ?? device.desktopUrl), desktop: Boolean(device.desktopUrl) };
  }

  private endpoint(name: string, context: AgentEndpointContext, route: string) {
    const device = this.getDevice(name);
    if (device.transport === "android-reverse") {
      throw new AgentRequestError(`${name} android-reverse does not support ${route}; use an Android-specific tool`, name, context, route, "context");
    }
    if (context === "desktop") {
      if (!device.desktopUrl) throw new AgentRequestError(`${name} desktop context is not configured`, name, context, route, "context");
      return { base: device.desktopUrl, token: device.desktopToken ?? device.userToken ?? device.token ?? this.token };
    }
    if (context === "user") {
      const base = device.userUrl ?? device.desktopUrl;
      if (!base) throw new AgentRequestError(`${name} user context is not configured`, name, context, route, "context");
      return { base, token: device.userToken ?? device.desktopToken ?? device.token ?? this.token };
    }
    return { base: device.url, token: device.token ?? this.token };
  }

  async requestRoute<T>(name: string, route: string, body: unknown | undefined, context: AgentEndpointContext = "system", options: AgentRequestOptions = {}): Promise<T> {
    const endpoint = this.endpoint(name, context, route);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const deadline = createDeadline(timeoutMs, options.signal);
    const signal = deadline.signal;
    try {
      const response = await fetch(`${endpoint.base}${route}`, {
        method: body === undefined ? "GET" : "POST", headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        const { recovery, diagnostic, truncated } = await readAgentError(response);
        const detail = recovery ? " job_recovery_required" : diagnostic ? ` ${diagnostic}` : "";
        throw new AgentRequestError(`${name} ${context} ${route} failed: HTTP ${response.status}${detail}`, name, context, route, "http", response.status, recovery, truncated);
      }
      try {
        return await response.json() as T;
      } catch (error) {
        if (signal?.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new AgentRequestError(`${name} ${context} ${route} invalid JSON response: ${detail}`, name, context, route, "protocol");
      }
    } catch (error) {
      if (error instanceof AgentRequestError) throw error;
      if (options.signal?.aborted && !deadline.timedOut()) {
        throw new AgentRequestError(`${name} ${context} ${route} cancelled by caller`, name, context, route, "cancelled");
      }
      if (deadline.timedOut()) {
        throw new AgentRequestError(`${name} ${context} ${route} timed out after ${timeoutMs}ms`, name, context, route, "timeout");
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentRequestError(`${name} ${context} ${route} network failure: ${detail}`, name, context, route, "network");
    } finally {
      deadline.dispose();
    }
  }

  private request<T>(name: string, route: string, body?: unknown, context: AgentEndpointContext = "system", options?: AgentRequestOptions): Promise<T> {
    return this.requestRoute(name, route, body, context, options);
  }
  private desktopRequest<T>(name: string, route: string, body?: unknown, options?: AgentRequestOptions): Promise<T> {
    return this.requestRoute(name, route, body, "desktop", options);
  }

  info(name: string, context: AgentEndpointContext = "system", options?: AgentRequestOptions): Promise<unknown> {
    const device = this.getDevice(name);
    if (device.transport === "android-reverse") {
      if (context !== "user") {
        throw new AgentRequestError(`${name} ${context} context is not configured for android-reverse`, name, context, "/v1/info", "context");
      }
      return Promise.resolve(this.requireAndroid().status(device.name));
    }
    return this.requestRoute(name, "/v1/info", undefined, context, options);
  }

  private requireAndroid(): AndroidController {
    if (!this.androidController) throw new Error("Android reverse controller is not configured");
    return this.androidController;
  }

  androidStatus(name: string): unknown { return this.requireAndroid().status(this.getDevice(name).name); }
  androidObserve(name: string, commandId: string, request: unknown, deadline: number, signal?: AbortSignal): Promise<unknown> {
    return this.requireAndroid().execute(name, commandId, request, deadline, signal);
  }
  androidAction(name: string, commandId: string, request: unknown, deadline: number, signal?: AbortSignal): Promise<unknown> {
    return this.requireAndroid().execute(name, commandId, request, deadline, signal);
  }
  androidCommandStatus(name: string, commandId: string): unknown { return this.requireAndroid().lookup(name, commandId); }
  exec(name: string, request: ExecRequest, context: AgentEndpointContext = "system", options: AgentRequestOptions = {}): Promise<ExecResult> {
    const commandTimeout = request.timeoutMs ?? 120_000;
    const transportTimeout = commandTimeout <= 0 ? 0 : Math.max(this.requestTimeoutMs, withTimeoutGrace(commandTimeout));
    return this.request(name, "/v1/exec", request, context, { ...options, timeoutMs: options.timeoutMs ?? transportTimeout });
  }
  service(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/service", input, context); }
  serviceLogs(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/service/logs", input, context); }


  directTransfer(sourceName: string, destinationName: string, input: {
    sourcePath: string; destinationPath: string; timeoutMs?: number;
    expectedBytes?: number; expectedModifiedAt?: string; preserveTimestamps?: boolean;
  }, sourceContext: AgentContext = "system", destinationContext: AgentContext = "system", signal?: AbortSignal): Promise<{
    ok: boolean; bytes: number; chunks: number; sameFile: boolean; atomic: boolean;
    destinationAtomic: boolean; transport: string; modifiedAtPreserved: boolean; sha256: string;
  }> {
    const source = this.endpoint(sourceName, sourceContext, "/v1/fs/raw");
    const device = this.getDevice(sourceName);
    const sourceBase = sourceContext === "system" ? device.directUrl ?? source.base
      : device.userUrl ? device.userDirectUrl ?? source.base
      : device.desktopDirectUrl ?? source.base;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    return this.requestRoute(destinationName, "/v1/fs/transfer-from", {
      ...input, sourceBase, sourceToken: source.token, timeoutMs,
    }, destinationContext, { timeoutMs: timeoutMs === 0 ? 0 : withTimeoutGrace(timeoutMs), signal });
  }

  async rawFile(name: string, pathname: string, context: AgentEndpointContext = "system", timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS): Promise<{
    size: number;
    modifiedAt: string | null;
    chunks: AsyncIterable<Buffer>;
  }> {
    const endpoint = this.endpoint(name, context, "/v1/fs/raw");
    const url = new URL("/v1/fs/raw", endpoint.base);
    url.searchParams.set("path", pathname);
    const headers: Record<string, string> = {};
    if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`;
    const deadline = createDeadline(timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { headers, ...(deadline.signal ? { signal: deadline.signal } : {}) });
    } catch (error) {
      if (deadline.timedOut()) {
        deadline.dispose();
        throw new AgentRequestError(`${name} ${context} /v1/fs/raw timed out after ${timeoutMs}ms`, name, context, "/v1/fs/raw", "timeout");
      }
      deadline.dispose();
      throw error;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 64 * 1024);
      deadline.dispose();
      throw new AgentRequestError(`${name} ${context} /v1/fs/raw failed: HTTP ${response.status} ${detail}`, name, context, "/v1/fs/raw", "http", response.status);
    }
    if (!response.body) {
      deadline.dispose();
      throw new AgentRequestError(`${name} ${context} /v1/fs/raw returned no response body`, name, context, "/v1/fs/raw", "protocol");
    }
    const lengthHeader = response.headers.get("content-length");
    const size = lengthHeader === null ? NaN : Number(lengthHeader);
    if (!Number.isSafeInteger(size) || size < 0) {
      deadline.dispose();
      await response.body.cancel().catch(() => undefined);
      throw new AgentRequestError(`${name} ${context} /v1/fs/raw returned invalid content-length`, name, context, "/v1/fs/raw", "protocol");
    }
    const mtimeHeader = response.headers.get("x-rcmcp-modified-at");
    const modifiedAt = mtimeHeader && Number.isFinite(Date.parse(mtimeHeader)) ? new Date(mtimeHeader).toISOString() : null;

    const chunks = (async function* (): AsyncGenerator<Buffer> {
      let bytes = 0;
      try {
        for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > size) throw new Error(`Raw file exceeded advertised size ${size}`);
          if (buffer.length) yield buffer;
        }
        if (bytes !== size) throw new Error(`Raw file size mismatch: expected ${size}, got ${bytes}`);
      } finally {
        deadline.dispose();
        await response.body?.cancel().catch(() => undefined);
      }
    })();

    return { size, modifiedAt, chunks };
  }

  fsRead(name: string, input: unknown, context: AgentEndpointContext = "system", options?: AgentRequestOptions): Promise<unknown> { return this.request(name, "/v1/fs/read", input, context, options); }
  fsWrite(name: string, input: unknown, context: AgentEndpointContext = "system", options?: AgentRequestOptions): Promise<unknown> { return this.request(name, "/v1/fs/write", input, context, options); }
  fsList(name: string, input: unknown, context: AgentEndpointContext = "system", options?: AgentRequestOptions): Promise<unknown> { return this.request(name, "/v1/fs/list", input, context, options); }
  fsManage(name: string, input: unknown, context: AgentEndpointContext = "system", options?: AgentRequestOptions): Promise<unknown> { return this.request(name, "/v1/fs/manage", input, context, options); }

  processes(name: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/processes", undefined, context); }
  async processFind(name: string, input: { query?: string; pid?: number; limit?: number }, context: AgentEndpointContext = "system"): Promise<unknown> {
    try { return await this.request(name, "/v1/processes/find", input, context); }
    catch (error) {
      if (!(error instanceof AgentRequestError) || error.status !== 404) throw error;
      return filterProcesses(await this.processes(name, context) as Array<Record<string, unknown>>, input);
    }
  }
  startProcess(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/processes/start", input, context); }
  killProcess(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/processes/kill", input, context); }

  jobStart(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/jobs/start", input, context); }
  jobFollow(name: string, input: JobFollowInput, context: AgentEndpointContext = "system", signal?: AbortSignal): Promise<unknown> {
    return this.request(name, "/v1/jobs/follow", input, context, { timeoutMs: withTimeoutGrace(input.waitMs ?? 30000), signal });
  }
  deployRun(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/deploy/run", input, context); }
  jobStatus(name: string, id: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/jobs/status", { id }, context); }
  jobOutput(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/jobs/output", input, context); }
  jobCancel(name: string, id: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/jobs/cancel", { id }, context); }
  jobRemove(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/jobs/remove", input, context); }
  jobs(name: string, limit = 100, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, `/v1/jobs?limit=${limit}`, undefined, context); }

  repoSnapshot(name: string, input: unknown, context: AgentEndpointContext = "user"): Promise<unknown> { return this.request(name, "/v1/repo/snapshot", input, context); }
  repoApplyPatch(name: string, input: unknown, context: AgentEndpointContext = "user"): Promise<unknown> { return this.request(name, "/v1/repo/apply-patch", input, context); }
  fsEdit(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/fs/edit", input, context); }
  repoCheckpoint(name: string, input: unknown, context: AgentEndpointContext = "user"): Promise<unknown> { return this.request(name, "/v1/repo/checkpoint", input, context); }
  repoGitPath(name: string, input: unknown, context: AgentEndpointContext = "user"): Promise<unknown> { return this.request(name, "/v1/repo/git-path", input, context); }
  private gitNetworkRequest(name: string, route: string, input: unknown, context: AgentEndpointContext): Promise<unknown> {
    const requested = typeof input === "object" && input !== null && typeof (input as { timeoutMs?: unknown }).timeoutMs === "number"
      ? (input as { timeoutMs: number }).timeoutMs
      : undefined;
    const transportTimeout = requested === undefined
      ? undefined
      : requested <= 0 ? 0 : Math.max(this.requestTimeoutMs, withTimeoutGrace(requested));
    return this.request(name, route, input, context, transportTimeout === undefined ? undefined : { timeoutMs: transportTimeout });
  }
  repoFetch(name: string, input: unknown, context: AgentEndpointContext = "user"): Promise<unknown> { return this.gitNetworkRequest(name, "/v1/repo/fetch", input, context); }
  repoPull(name: string, input: unknown, context: AgentEndpointContext = "user"): Promise<unknown> { return this.gitNetworkRequest(name, "/v1/repo/pull", input, context); }
  repoPush(name: string, input: unknown, context: AgentEndpointContext = "user"): Promise<unknown> { return this.gitNetworkRequest(name, "/v1/repo/push", input, context); }
  projectRun(name: string, input: ProjectRunInput, context: AgentEndpointContext = "user", options: AgentRequestOptions = {}): Promise<unknown> {
    const timeoutMs = input.mode === "exec" ? input.timeoutMs === 0 ? 0 : withTimeoutGrace(input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS) : undefined;
    return this.request(name, "/v1/project/run", input, context, { ...options, timeoutMs: options.timeoutMs ?? timeoutMs });
  }
  projectPlan(name: string, input: unknown, context: AgentEndpointContext = "user"): Promise<unknown> { return this.request(name, "/v1/project/plan", input, context); }

  dockerSnapshot(name: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/docker/snapshot", undefined, context); }
  async dockerSummary(name: string, input: { query?: string; state?: "all" | "running" | "stopped"; limit?: number }, context: AgentEndpointContext = "system"): Promise<unknown> {
    try { return await this.request(name, "/v1/docker/summary", input, context); }
    catch (error) {
      if (!(error instanceof AgentRequestError) || error.status !== 404) throw error;
      return summarizeDockerSnapshot(await this.dockerSnapshot(name, context) as DockerSnapshot, input);
    }
  }
  networkSnapshot(name: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/network", undefined, context); }
  storageSnapshot(name: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/storage", undefined, context); }
  gpuSnapshot(name: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/gpu", undefined, context); }
  packageManagers(name: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/packages/managers", undefined, context); }
  packageManage(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> {
    const requested = typeof input === "object" && input !== null && typeof (input as { timeoutMs?: unknown }).timeoutMs === "number"
      ? (input as { timeoutMs: number }).timeoutMs
      : DEFAULT_TRANSFER_TIMEOUT_MS;
    const transportTimeout = requested <= 0 ? 0 : Math.max(this.requestTimeoutMs, withTimeoutGrace(requested));
    return this.request(name, "/v1/packages/manage", input, context, { timeoutMs: transportTimeout });
  }
  hostPower(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/power/request", input, context); }

  desktopMonitors(name: string, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/monitors", undefined, { signal }); }
  desktopUia(name: string, input: DesktopUiaInput, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/uia", input, { signal }); }
  desktopWindows(name: string, input: DesktopWindowsInput = {}, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/windows", Object.keys(input).length ? input : undefined, { signal }); }
  desktopSessionStatus(name: string, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/session", undefined, { signal }); }
  desktopHelperStatus(name: string, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/helper/status", undefined, { signal }); }
  desktopScreenshot(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/screenshot", input, { signal }); }
  desktopFocus(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/focus", input, { signal }); }
  desktopMouse(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/mouse", input, { signal }); }
  desktopKeyboard(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/keyboard", input, { signal }); }
  desktopClipboard(name: string, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/clipboard", undefined, { signal }); }
  desktopClipboardSet(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/clipboard", input, { signal }); }
  desktopLaunch(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/launch", input, { signal }); }
  desktopBrowserOpen(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> { return this.desktopRequest(name, "/v1/desktop/browser/open", input, { signal }); }
  desktopBatch(name: string, input: DesktopBatchInput, signal?: AbortSignal): Promise<unknown> {
    const budget = input.actions.reduce((sum, action) => sum + (action.kind === "wait" ? action.ms : 30_000), HTTP_GRACE_MS);
    return this.desktopRequest(name, "/v1/desktop/batch", input, { signal, timeoutMs: Math.max(this.requestTimeoutMs, budget) });
  }

  ptyList(name: string, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/pty", undefined, context); }
  ptyStart(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/pty/start", input, context); }
  ptyInput(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/pty/input", input, context); }
  ptyOutput(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/pty/output", input, context); }
  ptyResize(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/pty/resize", input, context); }
  ptyTerminate(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/pty/terminate", input, context); }
  ptyRemove(name: string, input: unknown, context: AgentEndpointContext = "system"): Promise<unknown> { return this.request(name, "/v1/pty/remove", input, context); }
}
