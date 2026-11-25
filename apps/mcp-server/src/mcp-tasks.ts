import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ExtensionError, ExtensionStore, TASKS_EXTENSION, canonicalJson, requireExtension, sha256 } from "./mcp-extension-store.ts";

type TaskHandle = { device: string; context: AgentEndpointContext; endpoint: string; jobId: string; principal: string; createdAt: string };

/** Standard Tasks is an authenticated view of the durable executor receipt.
 * There is no second worker, process launch, execution queue or replay path. */
export class McpTasks {
  private readonly client: AgentClient;
  private readonly store: ExtensionStore;
  private readonly principal: string;
  private readonly readResult: (device: string, context: AgentEndpointContext, id: string) => Promise<CallToolResult>;
  constructor(client: AgentClient, store: ExtensionStore, principal: string, readResult: (device: string, context: AgentEndpointContext, id: string) => Promise<CallToolResult>) {
    this.client = client; this.store = store; this.principal = principal; this.readResult = readResult;
  }
  prepare() { return this.store.key(); }
  private endpoint(deviceName: string, context: AgentEndpointContext): string {
    const device = this.client.getDevice(deviceName);
    const url = context === "system" ? device.url : context === "desktop" ? device.desktopUrl : device.userUrl ?? device.desktopUrl;
    return sha256(canonicalJson({ device: device.name, context, url }));
  }
  async created(device: string, original: CallToolResult): Promise<Record<string, unknown> | undefined> {
    const job = original.structuredContent;
    if (original.isError || !job || typeof job.id !== "string" || typeof job.context !== "string") return undefined;
    const context = job.context;
    if (context !== "system" && context !== "user" && context !== "desktop") throw new Error("Executor did not return a bound identity");
    const handle: TaskHandle = { device: this.client.getDevice(device).name, context, endpoint: this.endpoint(device, context), jobId: job.id, principal: this.principal, createdAt: new Date().toISOString() };
    const taskId = await this.store.sign(handle);
    // Returning working is valid even when the executor completed quickly;
    // tasks/get reads the durable terminal receipt and final output.
    return { resultType: "task", taskId, status: "working", createdAt: handle.createdAt, lastUpdatedAt: handle.createdAt,
      ttlMs: null, pollIntervalMs: 2000, statusMessage: "Durable job accepted. Use tasks/get; disconnect does not cancel execution.",
      _meta: { "io.remote-control-mcp/job": { device: handle.device, context, jobId: handle.jobId } } };
  }
  private async handle(taskId: string): Promise<TaskHandle> {
    const value = await this.store.verify<TaskHandle>(taskId);
    if (value.principal !== this.principal || typeof value.device !== "string" || typeof value.jobId !== "string"
      || !["system", "user", "desktop"].includes(value.context) || !Number.isFinite(Date.parse(value.createdAt))) throw new ExtensionError(-32602, "Unknown task");
    let current: string; try { current = this.endpoint(value.device, value.context); } catch { throw new ExtensionError(-32602, "Task execution target is no longer configured"); }
    if (value.endpoint !== current) throw new ExtensionError(-32602, "Task execution target changed; inspect its original executor receipt");
    return value;
  }
  async get(taskId: string, meta?: Record<string, unknown>): Promise<Record<string, unknown>> {
    requireExtension(meta, TASKS_EXTENSION);
    const handle = await this.handle(taskId);
    let job: Record<string, unknown>;
    try { job = await this.client.jobStatus(handle.device, handle.jobId, handle.context) as Record<string, unknown>; }
    catch (error) {
      if ((error as { status?: number }).status === 404) throw new ExtensionError(-32602, "Task executor receipt is unavailable");
      throw error;
    }
    if (job.id !== handle.jobId || typeof job.state !== "string") throw new ExtensionError(-32602, "Task executor receipt is unavailable");
    const changed = typeof job.finishedAt === "string" ? job.finishedAt : typeof job.startedAt === "string" ? job.startedAt : handle.createdAt;
    const common = { resultType: "complete", taskId, createdAt: handle.createdAt, lastUpdatedAt: new Date(Math.max(Date.parse(handle.createdAt), Date.parse(changed) || 0)).toISOString(), ttlMs: null, pollIntervalMs: 2000 };
    if (job.state === "cancelled") return { ...common, status: "cancelled", statusMessage: "Executor confirmed cancellation" };
    if (job.state === "running" || job.state === "cancelling") return { ...common, status: "working", statusMessage: job.state === "cancelling" ? "Cancellation requested; executor has not confirmed terminal state" : "Durable job is still running" };
    if (job.state !== "completed" && job.state !== "lost") throw new Error("Unrecognized durable executor state");
    // Reuse the wrapped read tool, including routing, semantic output
    // validation, bounded previews and original-result recovery. A raw agent
    // response would omit identity and bypass the controller's result budget.
    const output = await this.readResult(handle.device, handle.context, handle.jobId);
    return { ...common, status: "completed", statusMessage: job.state === "lost" ? "Executor outcome is uncertain; inspect the original job without replay" : "Executor returned a terminal receipt",
      result: { ...output, ...(job.state === "lost" || job.exitCode !== 0 ? { isError: true } : {}) } };
  }
  async cancel(taskId: string, meta?: Record<string, unknown>): Promise<Record<string, unknown>> {
    requireExtension(meta, TASKS_EXTENSION); const handle = await this.handle(taskId);
    await this.client.jobCancel(handle.device, handle.jobId, handle.context);
    return { resultType: "complete" };
  }
  async update(taskId: string, inputResponses: Record<string, unknown>, meta?: Record<string, unknown>): Promise<Record<string, unknown>> {
    requireExtension(meta, TASKS_EXTENSION); await this.handle(taskId);
    // Shell jobs never request user data. A generic answer must never become
    // permission to launch a replacement job or write to another execution.
    throw new ExtensionError(-32602, "This task has no outstanding input requests");
  }
}
