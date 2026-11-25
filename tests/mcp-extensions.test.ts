import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { CLIENT_CAPABILITIES, ExtensionStore, FILES_EXTENSION, TASKS_EXTENSION, sha256 } from "../apps/mcp-server/src/mcp-extension-store.ts";
import { McpFiles, isPublicAddress, publicFileSource } from "../apps/mcp-server/src/mcp-files.ts";
import { REMOTE_CONTROL_SKILLS, REMOTE_CONTROL_SKILL_MARKDOWN } from "../apps/mcp-server/src/mcp-skills.ts";
import { toolResultSchemas } from "../apps/mcp-server/src/semantic-result-schemas.ts";
import { withErrorOutputContract } from "../apps/mcp-server/src/error-output-contract.ts";

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const both = { extensions: { [TASKS_EXTENSION]: {}, [FILES_EXTENSION]: { upload: {}, download: {} } } };
const syntheticBytes = Buffer.from("synthetic attachment\n");
async function harness(options: { client?: AgentClient; root?: string; token?: string; fetchSource?: () => Promise<AsyncIterable<Uint8Array>> } = {}) {
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), "rc-mcp-extensions-"));
  if (!options.root) close.push(() => rm(root, { recursive: true, force: true }));
  const token = options.token ?? "synthetic-owner";
  const http = createMcpHttpServer(options.client ?? new AgentClient([]), { token, extensionStateDirectory: root, fileSourceFetcher: options.fetchSource });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  close.push(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  async function rpc(method: string, params: Record<string, unknown> = {}, caps: object = both, headers: Record<string, string> = {}) {
    const response = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
      ...((method === "tools/call" || method.startsWith("tasks/") || method === "resources/read" || method === "skills/get") ? { "Mcp-Name": String(params.name ?? params.taskId ?? params.uri) } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: "same-logical-request", method, params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, [CLIENT_CAPABILITIES]: caps,
      } } }) });
    const text = await response.text();
    const data = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split("\n").filter(x => x.startsWith("data:")).at(-1)!.slice(5)) : JSON.parse(text);
    return { response, data };
  }
  return { root, url, rpc, token };
}
function input(data = syntheticBytes) { return { id: "fixture-file", name: "folder/report.txt", mimeType: "text/plain", size: data.length, digest: { algorithm: "sha-256", value: sha256(data) } }; }
function fakeClient() {
  const client = new AgentClient([{ name: "fixture", url: "https://agent.invalid", userUrl: "https://owner.invalid" }]);
  const job = { id: "e6b2cd00-4135-428b-b83f-ae0e2bfa3b66", command: "printf synthetic", state: "running", startedAt: new Date().toISOString(), stdoutBytes: 0, stderrBytes: 0, exitCode: null as number | null };
  const start = vi.spyOn(client, "jobStart").mockImplementation(async () => ({ ...job }));
  vi.spyOn(client, "jobStatus").mockImplementation(async () => ({ ...job }));
  vi.spyOn(client, "jobFollow").mockImplementation(async () => ({ ...job, terminal: true, waitExpired: false, outputComplete: true, stdout: { data: "synthetic", nextOffset: 9, eof: true }, stderr: { data: "", nextOffset: 0, eof: true }, cursor: { stdout: 9, stderr: 0 } }));
  const cancel = vi.spyOn(client, "jobCancel").mockImplementation(async () => { job.state = "cancelling"; return { ...job }; });
  return { client, job, start, cancel };
}

describe("standard MCP extensions and legacy compatibility", () => {
  it("advertises concrete extensions and digest-verified skills through the official SDK", async () => {
    const h = await harness();
    const discovery = (await h.rpc("server/discover")).data.result;
    expect(discovery.capabilities.extensions[TASKS_EXTENSION]).toEqual({});
    expect(discovery.capabilities.extensions[FILES_EXTENSION]).toMatchObject({ upload: {}, maxInlineBytes: 1048576 });
    expect(discovery.capabilities.extensions["io.modelcontextprotocol/skills"]).toBeDefined();
    const list = (await h.rpc("skills/list")).data.result;
    expect(list.skills[0]).toEqual(REMOTE_CONTROL_SKILLS[0]);
    const read = (await h.rpc("resources/read", { uri: list.skills[0].uri })).data.result;
    expect(read.contents[0].text).toEqual(REMOTE_CONTROL_SKILL_MARKDOWN);
    expect(list.skills[0].resources[0].digest).toBe("sha256:" + createHash("sha256").update(read.contents[0].text).digest("hex"));
    const tools = (await h.rpc("tools/list")).data.result.tools;
    const receive = tools.find((x: any) => x.name === "file_receive");
    expect(receive._meta["openai/fileParams"]).toEqual(["file"]);
    expect(receive.inputSchema.properties.file.required).toEqual(expect.arrayContaining(["download_url", "file_id"]));
    expect(receive.inputSchema.properties.file.properties.mime_type).toBeDefined();
    expect(tools.find((x: any) => x.name === "file_upload").inputSchema.properties.file["x-mcp-file"].maxSize).toBe(150 * 1024 * 1024);
  });
  it("reuses one durable executor job and survives controller restart without another start", async () => {
    const fixture = fakeClient(); const h = await harness({ client: fixture.client });
    const call = (await h.rpc("tools/call", { name: "job_start", arguments: { device: "fixture", identity: "owner", command: "printf synthetic", idempotencyKey: "stable" } })).data;
    expect(call.result.resultType).toBe("task"); expect(call.result.taskId).toMatch(/^rct1\./); expect(call.result.task).toBeUndefined();
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect((await h.rpc("tasks/get", { taskId: call.result.taskId })).data.result.status).toBe("working");
    fixture.job.state = "completed"; fixture.job.exitCode = 0;
    const restarted = await harness({ client: fixture.client, root: h.root });
    const completed = (await restarted.rpc("tasks/get", { taskId: call.result.taskId })).data.result;
    expect(completed.resultType).toBe("complete"); expect(completed.status).toBe("completed"); expect(completed.result.structuredContent.stdout.data).toBe("synthetic");
    expect(completed.result.isError).not.toBe(true); expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(withErrorOutputContract(toolResultSchemas.job_start).safeParse(completed.result.structuredContent).success).toBe(true);
    fixture.job.command = "x".repeat(128 * 1024);
    const bounded = (await restarted.rpc("tasks/get", { taskId: call.result.taskId })).data.result;
    expect(JSON.stringify(bounded.result).length).toBeLessThan(256 * 1024);
    expect(bounded.result.structuredContent.resultRecovery).toBeDefined();
    expect(withErrorOutputContract(toolResultSchemas.job_start).safeParse(bounded.result.structuredContent).success).toBe(true);
    fixture.job.exitCode = 1;
    const failedTool = (await restarted.rpc("tasks/get", { taskId: call.result.taskId })).data.result;
    expect(failedTool.status).toBe("completed"); expect(failedTool.result.isError).toBe(true);
  });
  it("does not send Tasks to nondeclaring clients and refuses malformed, foreign or unrequested input", async () => {
    const fixture = fakeClient(); const h = await harness({ client: fixture.client });
    const args = { device: "fixture", identity: "owner", command: "printf synthetic" };
    const legacy = (await h.rpc("tools/call", { name: "job_start", arguments: args }, {})).data.result;
    expect(legacy.resultType).toBe("complete"); expect(legacy.structuredContent.id).toBe(fixture.job.id);
    const task = (await h.rpc("tools/call", { name: "job_start", arguments: args })).data.result;
    expect((await h.rpc("tasks/get", { taskId: task.taskId }, {})).data.error.code).toBe(-32021);
    expect((await h.rpc("tasks/get", { taskId: task.taskId + "x" })).data.error.code).toBe(-32602);
    expect((await h.rpc("tasks/update", { taskId: task.taskId, inputResponses: { approved: { action: "accept" } } })).data.error.code).toBe(-32602);
    expect((await h.rpc("tasks/cancel", { taskId: task.taskId })).data.result.resultType).toBe("complete");
    expect((await h.rpc("tasks/get", { taskId: task.taskId })).data.result.status).toBe("working");
    fixture.job.state = "cancelled";
    expect((await h.rpc("tasks/get", { taskId: task.taskId })).data.result.status).toBe("cancelled");
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    const foreign = await harness({ client: fixture.client, root: h.root, token: "other-owner" });
    expect((await foreign.rpc("tasks/get", { taskId: task.taskId })).data.error.code).toBe(-32602);
    expect((await h.rpc("tasks/get", { taskId: task.taskId }, both, { "Mcp-Name": "wrong" })).data.error.code).toBe(-32020);
  });
  it("uploads out of band, confirms exact bytes once, and downloads through an authenticated target", async () => {
    const h = await harness(); const args = { file: input() };
    const pending = (await h.rpc("tools/call", { name: "file_upload", arguments: args })).data.result;
    expect(pending.resultType).toBe("upload_required"); expect(pending.uploads).toHaveLength(1);
    expect((await readdir(path.join(h.root, "artifacts"))).length).toBe(0);
    const target = h.url + pending.uploads[0].path;
    expect((await fetch(target, { method: "PUT", body: syntheticBytes })).status).toBe(401);
    expect((await fetch(target, { method: "PUT", headers: { Authorization: "Bearer " + h.token }, body: syntheticBytes })).status).toBe(204);
    expect((await readdir(path.join(h.root, "artifacts"))).length).toBe(0);
    const ready = (await h.rpc("tools/call", { name: "file_upload", arguments: args, requestState: pending.requestState })).data.result;
    expect(ready.resultType).toBe("complete"); expect(ready.structuredContent.digest.value).toBe(sha256(syntheticBytes));
    expect(await readFile(ready.structuredContent.controllerPath)).toEqual(syntheticBytes);
    const repeated = (await h.rpc("tools/call", { name: "file_upload", arguments: args, requestState: pending.requestState })).data;
    expect(repeated.error.code).toBe(-32602);
    const artifactId = ready.structuredContent.artifactId;
    const download = (await h.rpc("tools/call", { name: "file_download", arguments: { artifactId } })).data.result;
    const downloadTarget = h.url + download._meta[FILES_EXTENSION].downloads[0].path;
    expect((await fetch(downloadTarget)).status).toBe(401);
    expect(Buffer.from(await (await fetch(downloadTarget, { headers: { Authorization: "Bearer " + h.token } })).arrayBuffer())).toEqual(syntheticBytes);
    expect((await h.rpc("tools/call", { name: "file_download", arguments: { artifactId } }, {})).data.result._meta?.[FILES_EXTENSION]).toBeUndefined();
  });
  it("rejects missing capabilities, changed requests, invalid checksums and premature or repeated finalization", async () => {
    const h = await harness(); const args = { file: input() };
    expect((await h.rpc("tools/call", { name: "file_upload", arguments: args }, {})).data.error.code).toBe(-32021);
    const pending = (await h.rpc("tools/call", { name: "file_upload", arguments: args })).data.result;
    const changed = (await h.rpc("tools/call", { name: "file_upload", arguments: { file: { ...args.file, name: "changed.txt" } }, requestState: pending.requestState })).data;
    expect(changed.error.code).toBe(-32602);
    const premature = (await h.rpc("tools/call", { name: "file_upload", arguments: args, requestState: pending.requestState })).data.result;
    expect(premature.isError).toBe(true);
    expect((await fetch(h.url + pending.uploads[0].path, { method: "PUT", headers: { Authorization: "Bearer " + h.token }, body: Buffer.alloc(syntheticBytes.length) })).status).toBe(400);
    expect((await readdir(path.join(h.root, "artifacts"))).filter(x => x.endsWith(".json"))).toHaveLength(0);
    const badInline = (await h.rpc("tools/call", { name: "file_upload", arguments: { file: { ...input(), data: Buffer.alloc(syntheticBytes.length).toString("base64") } } })).data.result;
    expect(badInline.isError).toBe(true);
    const empty = (await h.rpc("tools/call", { name: "file_upload", arguments: { file: { id: "empty", mimeType: "text/plain", size: 0 } } }, {})).data.result;
    expect(empty.resultType).toBe("complete"); expect(empty.structuredContent.size).toBe(0);
  });
  it("pulls OpenAI attachments only through the explicit safe downloader and applies declared integrity", async () => {
    const fetcher = vi.fn(async () => (async function* () { yield syntheticBytes; })());
    const h = await harness({ fetchSource: fetcher });
    const receive = (await h.rpc("tools/call", { name: "file_receive", arguments: { file: { download_url: "https://files.example.test/synthetic", file_id: "synthetic-file", file_name: "../report.txt", mime_type: "text/plain" }, sha256: createHash("sha256").update(syntheticBytes).digest("hex") } })).data.result;
    expect(receive.isError).not.toBe(true); expect(receive.structuredContent.name).toBe("report.txt");
    expect(receive.structuredContent.digest.value).toBe(sha256(syntheticBytes)); expect(fetcher).toHaveBeenCalledTimes(1);
    for (const url of ["http://files.example.test/file", "https://127.0.0.1/file", "https://[::1]/file", "https://user:pass@files.example.test/file"]) await expect(publicFileSource(url)).rejects.toThrow();
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "100.100.100.100", "169.254.169.254", "172.16.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fd00::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:a00:1::", "3fff::1"]) expect(isPublicAddress(ip)).toBe(false);
  });
  it("atomically consumes one shared state when two finalized retries race", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rc-files-race-")); close.push(() => rm(root, { recursive: true, force: true }));
    const store = new ExtensionStore(root), files = new McpFiles(store, "principal");
    const args = { file: { ...input(), digest: { algorithm: "sha-256" as const, value: sha256(syntheticBytes) } } };
    const pending = await files.upload(args, { [CLIENT_CAPABILITIES]: both });
    await store.writeBytes("uploads", pending.requestState as string, [syntheticBytes], syntheticBytes.length, sha256(syntheticBytes));
    const outcomes = await Promise.allSettled([files.upload(args, { [CLIENT_CAPABILITIES]: both }, pending.requestState as string), files.upload(args, { [CLIENT_CAPABILITIES]: both }, pending.requestState as string)]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect((await readdir(path.join(root, "artifacts"))).filter(x => x.endsWith(".json"))).toHaveLength(1);
  });
});
