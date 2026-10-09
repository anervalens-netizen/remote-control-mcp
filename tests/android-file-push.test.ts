import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidController } from "../apps/mcp-server/src/android-controller.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { sanitizeDownloadFilename, MAX_ANDROID_FILE_BYTES } from "../apps/mcp-server/src/android-file-push.ts";

const token = "synthetic-file-test-token-12345678901234567890";
const otherToken = "synthetic-second-token-1234567890123456789012";
const state = { androidSdk: 29, manufacturer: "example", model: "example", build: "test", appVersion: "test", uid: 10000,
  screenOn: false, keyguardLocked: true, userUnlocked: true, accessibility: false, paused: false,
  shellAvailable: false, network: "wifi", batteryPercent: 50 };
const roots: string[] = [];
const controllers: AndroidController[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const controller of controllers.splice(0)) await controller.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
// Exercise the real HTTP handler and streaming pipeline without binding a socket.
// Existing Android controller integration tests separately cover TCP transport.
function http(controller: AndroidController, route: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const req = Readable.from(init.body ? [Buffer.from(init.body)] : []) as unknown as IncomingMessage;
  req.method = init.method ?? "GET"; req.url = route; req.headers = init.headers ?? {};
  let status = 200; let headers: Record<string, string | number> = {}; const chunks: Buffer[] = [];
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  Object.assign(res, { writeHead(code: number, values: Record<string, string | number> = {}) { status = code; headers = values; return res; } });
  const response = new Promise<Response>((resolve, reject) => {
    res.once("finish", () => resolve(new Response(Buffer.concat(chunks), { status, headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])) })));
    res.once("error", reject);
  });
  void (controller as unknown as { handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> }).handleHttp(req, res as unknown as ServerResponse);
  return response;
}
const data = Buffer.from("synthetic download bytes\n");
const version = `1:2:${data.length}:4:5`;
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "android-file-push-test-")); roots.push(root);
  const config = { host: "127.0.0.1", port: 0, stateDir: root, devices: [{ name: "phone-example", token }, { name: "phone-other", token: otherToken }] };
  const controller = new AndroidController(config); controllers.push(controller);
  const get = (route: string, headers?: Record<string, string>) => http(controller, route, { headers });
  const client = new AgentClient([{ name: "source-example", url: "http://127.0.0.1:1" }], "synthetic", 1000, controller);
  const info = vi.spyOn(client, "info").mockResolvedValue({ runtime: { relaySourceVersion: 1 } });
  const read = vi.spyOn(client, "fsRead").mockImplementation(async (_device, raw) => {
    const input = raw as { offset: number; length: number; expectedVersion?: string };
    expect(input.expectedVersion === undefined || input.expectedVersion === version).toBe(true);
    const chunk = data.subarray(input.offset, input.offset + input.length);
    return { path: "/synthetic.bin", encoding: "base64", data: chunk.toString("base64"), bytesRead: chunk.length,
      nextOffset: input.offset + chunk.length, eof: input.offset + chunk.length === data.length,
      sourceVersion: version, totalBytes: data.length };
  });
  const sessionId = randomUUID();
  const post = (route: string, body: unknown) => http(controller, route, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const poll = () => post("/android/v1/poll", { version: 1, device: "phone-example", sessionId, state });
  const online = async () => { const pending = poll(); await expect.poll(() => (controller.status("phone-example") as { online: boolean }).online).toBe(true); return { pending }; };
  const input = { device: "phone-example", commandId: randomUUID(), sourceDevice: "source-example", sourcePath: "/synthetic.bin", filename: "../example file.bin" };
  const result = (command: any, receipt: unknown) => post("/android/v1/result", { version: 1, device: "phone-example", sessionId, commandId: command.commandId, deliveryId: command.deliveryId, ok: true, status: "completed", result: receipt });
  return { root, config, controller, client, get, info, read, input, poll, online, result };
}

describe("Android secure file push", () => {
  it("sanitizes paths, Unicode, empty leaves and bounds filename length", () => {
    expect(sanitizeDownloadFilename("C:\\folder\\../example file.bin")).toBe("example_file.bin");
    expect(sanitizeDownloadFilename("../../")).toBe("download.bin");
    expect(sanitizeDownloadFilename("..hidden")).toBe("hidden");
    expect(sanitizeDownloadFilename("x".repeat(200))).toHaveLength(120);
  });
  it("rejects offline/unpaired destinations without reading source or reserving", async () => {
    const x = await setup();
    expect(() => x.client.androidFilePush(x.input)).toThrow(/offline/);
    expect(() => x.client.androidFilePush({ ...x.input, device: "unpaired" })).toThrow(/Unknown Android/);
    expect(x.info).not.toHaveBeenCalled(); expect(x.read).not.toHaveBeenCalled();
    expect(await readdir(path.join(x.root, "android-file-push-v1"))).toEqual([]);
  });
  it("streams device-bound authenticated bytes, verifies receipts, deduplicates and cleans private staging", async () => {
    const x = await setup(); const { pending } = await x.online();
    const push = x.client.androidFilePush(x.input);
    const duplicate = x.client.androidFilePush({ ...x.input, device: "PHONE-EXAMPLE", commandId: x.input.commandId.toUpperCase() });
    expect(duplicate).toBe(push);
    expect(() => x.client.androidFilePush({ ...x.input, sourcePath: "/different.bin" })).toThrow(/command_conflict/);
    const command = (await (await pending).json()).command;
    const request = command.request;
    expect(request).toEqual({ operation: "receive_file", transferId: expect.any(String), filename: "example_file.bin", bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex") });
    const route = `/android/v1/files/${request.transferId}`;
    expect((await x.get(route)).status).toBe(401);
    expect((await x.get(route, { authorization: "Bearer incorrect" })).status).toBe(403);
    expect((await x.get(route, { authorization: `Bearer ${otherToken}` })).status).toBe(403);
    const response = await x.get(route, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    const staging = path.join(x.root, "android-file-push-v1");
    if (process.platform !== "win32") {
      expect((await stat(staging)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(staging, `${request.transferId}.bin`))).mode & 0o777).toBe(0o600);
    }
    const receipt = { transferId: request.transferId, bytes: request.bytes, sha256: request.sha256, published: true };
    for (const wrong of [{ ...receipt, bytes: 1 }, { ...receipt, sha256: "0".repeat(64) }, { ...receipt, transferId: randomUUID() }, { ...receipt, published: false }]) {
      expect((await x.result(command, wrong)).status).toBe(400);
    }
    expect((await x.result(command, receipt)).status).toBe(200);
    expect(await push).toMatchObject({ ok: true, status: "completed", result: receipt }); await duplicate;
    expect(await x.client.androidFilePush(x.input)).toMatchObject({ ok: true, result: receipt });
    expect(x.read).toHaveBeenCalledTimes(3);
    expect((await readdir(staging)).filter(f => f.endsWith(".bin"))).toEqual([]);
    expect((await x.get(route, { authorization: `Bearer ${token}` })).status).toBe(404);
    expect(x.controller.lookup("phone-example", x.input.commandId.toUpperCase())).toMatchObject({ ok: true, result: receipt });
    await x.controller.close();
    const restarted = new AndroidController(x.config); controllers.push(restarted);
    const again = new AgentClient([{ name: "source-example", url: "http://127.0.0.1:1" }], "test", 100, restarted);
    expect(await again.androidFilePush(x.input)).toMatchObject({ ok: true, result: receipt });
    expect(restarted.lookup("phone-example", x.input.commandId)).toMatchObject({ result: receipt });
  });
  it.each(["capability", "missing_version", "generation", "partial", "oversize", "exception"])("fails closed on source %s and retains identity without staged data", async failure => {
    const x = await setup(); const { pending } = await x.online();
    if (failure === "capability") x.info.mockResolvedValue({ runtime: { relaySourceVersion: 0 } });
    else if (failure === "exception") x.read.mockRejectedValue(new Error("synthetic read failure"));
    else {
      const original = x.read.getMockImplementation()!;
      x.read.mockImplementation(async (...args) => {
        const r = await original(...args) as any;
        if (failure === "missing_version") delete r.sourceVersion;
        if (failure === "oversize") r.totalBytes = MAX_ANDROID_FILE_BYTES + 1;
        if ((args[1] as any).length > 0) {
          if (failure === "generation") r.sourceVersion = "1:2:3:8:9";
          if (failure === "partial") { r.data = ""; r.bytesRead = 0; }
        }
        return r;
      });
    }
    await expect(x.client.androidFilePush(x.input)).rejects.toThrow();
    expect(await x.client.androidFilePush(x.input)).toMatchObject({ status: "outcome_unknown", noReplay: true });
    expect((await readdir(path.join(x.root, "android-file-push-v1"))).filter(f => f.endsWith(".bin"))).toEqual([]);
    await x.controller.close(); await pending;
  });
  it("expires staged bytes and never replays a dispatched uncertain transfer", async () => {
    const x = await setup(); const { pending } = await x.online(); const push = x.client.androidFilePush(x.input);
    const command = (await (await pending).json()).command;
    const original = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(original + 11 * 60_000);
    const response = await x.get(`/android/v1/files/${command.request.transferId}`, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(410); clock.mockRestore();
    await x.controller.close(); expect(await push).toMatchObject({ status: "outcome_unknown" });
    const before = x.read.mock.calls.length;
    expect(await x.client.androidFilePush(x.input)).toMatchObject({ status: "outcome_unknown" });
    expect(x.read).toHaveBeenCalledTimes(before);
  });
  it("accepts only a verified late receipt after restart without restaging or redelivery", async () => {
    const x = await setup(); const { pending } = await x.online(); const push = x.client.androidFilePush(x.input);
    const command = (await (await pending).json()).command;
    await x.controller.close(); expect(await push).toMatchObject({ status: "outcome_unknown" });
    const restarted = new AndroidController(x.config); controllers.push(restarted);
    const again = new AgentClient([{ name: "source-example", url: "http://127.0.0.1:1" }], "synthetic", 100, restarted);
    const spy = vi.spyOn(again, "fsRead");
    expect(await again.androidFilePush(x.input)).toMatchObject({ status: "outcome_unknown" });
    expect(spy).not.toHaveBeenCalled();
    const fileResult = { transferId: command.request.transferId, sha256: command.request.sha256, bytes: command.request.bytes, published: true };
    const journalFile = (await readdir(x.root)).find(name => name.endsWith(".json"))!;
    const journal = JSON.parse(await readFile(path.join(x.root, journalFile), "utf8"));
    const sessionId = journal.commands.find((item: any) => item.commandId === x.input.commandId).sessionId;
    const result = { version: 1, device: x.input.device, sessionId, commandId: command.commandId, deliveryId: command.deliveryId, ok: true, status: "completed", result: fileResult };
    const post = (body: unknown) => http(restarted, "/android/v1/result", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await post({ ...result, result: { ...fileResult, bytes: 0 } })).status).toBe(400);
    expect((await post(result)).status).toBe(200);
    expect(restarted.lookup(x.input.device, x.input.commandId)).toMatchObject({ ok: true, result: fileResult });
    expect(await again.androidFilePush(x.input)).toMatchObject({ ok: true, result: fileResult });
  });
  it("rejects corrupted retained file receipts rather than claiming verified success", async () => {
    const x = await setup(); const { pending } = await x.online(); const push = x.client.androidFilePush(x.input);
    const command = (await (await pending).json()).command;
    expect((await x.result(command, { transferId: command.request.transferId, sha256: command.request.sha256, bytes: command.request.bytes, published: true })).status).toBe(200);
    await push; await x.controller.close();
    const journalFile = (await readdir(x.root)).find(name => name.endsWith(".json"))!;
    const file = path.join(x.root, journalFile); const journal = JSON.parse(await readFile(file, "utf8"));
    journal.commands[0].fileResult.sha256 = "0".repeat(64);
    await writeFile(file, JSON.stringify(journal));
    expect(() => new AndroidController(x.config)).toThrow(/Invalid Android file receipt/);
  });
  it("detects a final source generation mismatch before queueing a receive operation", async () => {
    const x = await setup(); const { pending } = await x.online();
    const original = x.read.getMockImplementation()!; let reads = 0;
    x.read.mockImplementation(async (...args) => {
      const r = await original(...args) as any;
      if (++reads === 3) r.sourceVersion = "1:2:3:99:99";
      return r;
    });
    await expect(x.client.androidFilePush(x.input)).rejects.toThrow(/generation/);
    expect(x.controller.lookup(x.input.device, x.input.commandId)).toMatchObject({ noReplay: true });
    expect((x.controller.status(x.input.device) as { queuedCommands: number }).queuedCommands).toBe(0);
    await x.controller.close(); expect((await (await pending).json()).command).toBeNull();
  });
  it("cleans staged bytes after caller cancellation without replaying the dispatched command", async () => {
    const x = await setup(); const { pending } = await x.online(); const abort = new AbortController();
    const push = x.client.androidFilePush(x.input, abort.signal); await pending; abort.abort();
    expect(await push).toMatchObject({ status: "outcome_unknown" });
    expect((await readdir(path.join(x.root, "android-file-push-v1"))).filter(file => file.endsWith(".bin"))).toEqual([]);
    expect(await x.client.androidFilePush(x.input)).toMatchObject({ status: "outcome_unknown" });
    expect(x.read).toHaveBeenCalledTimes(3);
  });
  it("registers and calls the actual MCP tool through SDK in-memory transport", async () => {
    const x = await setup(); const { pending } = await x.online();
    const server = new McpServer({ name: "synthetic-file-push", version: "1" });
    registerTools(server, x.client);
    const client = new Client({ name: "synthetic-file-client", version: "1" });
    const [st, ct] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const tool = (await client.listTools()).tools.find(tool => tool.name === "android_file_push");
      expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["device", "commandId", "sourceDevice", "sourcePath"]));
      const push = client.callTool({ name: "android_file_push", arguments: x.input });
      const command = (await (await pending).json()).command;
      expect((await x.result(command, { transferId: command.request.transferId, sha256: command.request.sha256, bytes: command.request.bytes, published: true })).status).toBe(200);
      expect((await push).structuredContent).toMatchObject({ ok: true, status: "completed" });
    } finally { await client.close(); await server.close(); }
  });
  it("reports reserved source failures through UUID status and refuses different filenames", async () => {
    const x = await setup(); const { pending } = await x.online(); x.info.mockRejectedValue(new Error("synthetic failure"));
    await expect(x.client.androidFilePush(x.input)).rejects.toThrow();
    expect(x.controller.lookup("PHONE-EXAMPLE", x.input.commandId.toUpperCase())).toMatchObject({ status: "outcome_unknown", noReplay: true });
    expect(() => x.client.androidFilePush({ ...x.input, filename: "different.bin" })).toThrow(/command_conflict/);
    await x.controller.close(); await pending;
  });
  it("removes orphan staging on restart without deleting reservations", async () => {
    const x = await setup(); await x.controller.close();
    const dir = path.join(x.root, "android-file-push-v1");
    const id = randomUUID(); await writeFile(path.join(dir, `${id}.bin`), "synthetic orphan");
    await writeFile(path.join(dir, "retained.json"), "{}");
    const restarted = new AndroidController(x.config); controllers.push(restarted);
    expect(await readdir(dir)).toEqual(["retained.json"]);
    expect(await readFile(path.join(dir, "retained.json"), "utf8")).toBe("{}");
  });
});
