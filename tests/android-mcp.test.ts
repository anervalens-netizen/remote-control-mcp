import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { AndroidController } from "../apps/mcp-server/src/android-controller.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";

const token = "android-mcp-token-012345678901234567890123456789";
const state = {
  androidSdk: 36, manufacturer: "OnePlus", model: "Nord", build: "test-build", appVersion: "0.1.0", uid: 12345,
  screenOn: true, keyguardLocked: false, userUnlocked: true, accessibility: true, paused: false,
  shellAvailable: false, network: "cellular", batteryPercent: 80,
};
const cleanups: Array<() => Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Android MCP integration", () => {
  it("registers Android tools only with a configured controller and returns native validated images", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-android-mcp-"));
    roots.push(root);
    const controller = new AndroidController({ host: "127.0.0.1", port: 0, stateDir: root, devices: [{ name: "phone-example", token }] });
    await controller.start();
    cleanups.push(() => controller.close());
    const server = new McpServer({ name: "android-test", version: "1" });
    registerTools(server, new AgentClient([], undefined, undefined, controller));
    const client = new Client({ name: "android-test-client", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => { await client.close(); await server.close(); });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["android_status", "android_observe", "android_action", "android_shell", "android_command_status"]));
    const devices = await client.callTool({ name: "devices_list", arguments: {} });
    expect(devices.structuredContent).toMatchObject({ devices: [{ name: "phone-example", url: "android-reverse://phone-example", contexts: { system: false, user: true, desktop: false } }] });

    const info = await client.callTool({ name: "device_info", arguments: { device: "phone-example" } });
    expect(info.isError).not.toBe(true);
    expect(info.structuredContent).toMatchObject({ name: "phone-example", transport: "android-reverse", online: false, readiness: "offline" });

    const capabilities = await client.callTool({ name: "capability_report", arguments: { devices: ["phone-example"] } });
    expect(capabilities.isError).not.toBe(true);
    expect(capabilities.structuredContent).toMatchObject({ items: [{
      device: "phone-example",
      configured: { system: false, user: true, desktop: false },
      endpoints: { user: { ok: true, info: { name: "phone-example", transport: "android-reverse" } } },
    }] });
    expect((capabilities.structuredContent as any).items[0].endpoints.system).toBeUndefined();

    const fleet = await client.callTool({ name: "fleet_status", arguments: { devices: ["phone-example"] } });
    expect(fleet.isError).not.toBe(true);
    expect(fleet.structuredContent).toMatchObject({ devices: [{ device: "phone-example", online: false, platform: "android", readiness: "offline", context: "user", contextAvailable: true }] });
    const fleetSystem = await client.callTool({ name: "fleet_status", arguments: { devices: ["phone-example"], context: "system" } });
    expect(fleetSystem.isError).not.toBe(true);
    expect(fleetSystem.structuredContent).toMatchObject({ devices: [{ device: "phone-example", platform: "android", context: "system", contextAvailable: false }] });

    const status = await client.callTool({ name: "android_status", arguments: { device: "phone-example" } });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ online: false, readiness: "offline" });
    const unknownId = crypto.randomUUID();
    const unknown = await client.callTool({ name: "android_command_status", arguments: { device: "phone-example", commandId: unknownId } });
    expect(unknown.isError).not.toBe(true);
    expect(unknown.structuredContent).toEqual({ found: false, commandId: unknownId, command: null });
    const sessionId = crypto.randomUUID();
    const address = controller.address()!;
    const poll = fetch(`http://127.0.0.1:${address.port}/android/v1/poll`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, device: "phone-example", sessionId, state }),
    });
    await expect.poll(() => (controller.status("phone-example") as {online:boolean}).online).toBe(true);
    const observe = client.callTool({ name: "android_observe", arguments: { device: "phone-example", image: true, tree: true, maxNodes: 200 } });
    const envelope = (await (await poll).json()).command;
    expect(envelope.request).toMatchObject({ operation: "observe", image: true, tree: true, maxNodes: 200 });
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    const result = {
      snapshot: { snapshotId: crypto.randomUUID(), observedAt: Date.now(), width: 1, height: 1, rotation: 0, generation: "g1" },
      image: { available: true, mimeType: "image/png", data: imageData },
      nodes: [],
      treeTruncated: false,
    };
    const uploaded = await fetch(`http://127.0.0.1:${address.port}/android/v1/result`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, device: "phone-example", sessionId, commandId: envelope.commandId, deliveryId: envelope.deliveryId, ok: true, status: "completed", result }),
    });
    expect(uploaded.status).toBe(200);
    const response = await observe;
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ ok: true, result: { image: { available: true, mimeType: "image/png", width: 1, height: 1 } } });
    expect((response.content as Array<{ type: string }>).map((item) => item.type)).toEqual(["text", "image"]);
    expect((response.content as Array<{ type: string; data?: string }>)[1]?.data).toBe(imageData);

    const mismatchPoll = fetch(`http://127.0.0.1:${address.port}/android/v1/poll`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, device: "phone-example", sessionId, state }),
    });
    const mismatchObserve = client.callTool({ name: "android_observe", arguments: { device: "phone-example", image: true, tree: false } });
    const mismatchEnvelope = (await (await mismatchPoll).json()).command;
    const mismatchResult = {
      snapshot: { snapshotId: crypto.randomUUID(), observedAt: Date.now(), width: 2, height: 2, rotation: 0, generation: "g2" },
      image: { available: true, mimeType: "image/png", data: imageData },
    };
    expect((await fetch(`http://127.0.0.1:${address.port}/android/v1/result`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, device: "phone-example", sessionId, commandId: mismatchEnvelope.commandId, deliveryId: mismatchEnvelope.deliveryId, ok: true, status: "completed", result: mismatchResult }),
    })).status).toBe(200);
    const mismatchResponse = await mismatchObserve;
    expect(mismatchResponse.isError).not.toBe(true);
    expect(mismatchResponse.structuredContent).toMatchObject({ ok: true, result: { image: { available: false, reason: "image_dimensions_mismatch", expectedWidth: 2, expectedHeight: 2, actualWidth: 1, actualHeight: 1 } } });
    expect((mismatchResponse.content as Array<{ type: string }>).map((item) => item.type)).toEqual(["text"]);

    const shellPoll = fetch(`http://127.0.0.1:${address.port}/android/v1/poll`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, device: "phone-example", sessionId, state: { ...state, shellAvailable: true } }),
    });
    const shellCommandId = crypto.randomUUID();
    const shell = client.callTool({ name: "android_shell", arguments: {
      device: "phone-example", commandId: shellCommandId, command: "id", timeoutMs: 5_000, maxOutputBytes: 8_192,
    } });
    const shellEnvelope = (await (await shellPoll).json()).command;
    expect(shellEnvelope).toMatchObject({
      commandId: shellCommandId,
      request: { operation: "shell", command: "id", timeoutMs: 5_000, maxOutputBytes: 8_192 },
    });
    expect((await fetch(`http://127.0.0.1:${address.port}/android/v1/result`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        version: 1, device: "phone-example", sessionId,
        commandId: shellEnvelope.commandId, deliveryId: shellEnvelope.deliveryId,
        ok: true, status: "completed",
        result: { code: 0, stdout: "uid=2000(shell)\\n", stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, uid: 2000 },
      }),
    })).status).toBe(200);
    const shellResponse = await shell;
    expect(shellResponse.isError).not.toBe(true);
    expect(shellResponse.structuredContent).toMatchObject({
      commandId: shellCommandId, status: "completed", ok: true,
      result: { code: 0, stdout: "uid=2000(shell)\\n", uid: 2000, timedOut: false },
    });
  });

  it("does not add Android-specific tools to the existing default surface", async () => {
    const server = new McpServer({ name: "baseline-test", version: "1" });
    registerTools(server, new AgentClient([]));
    const client = new Client({ name: "baseline-test-client", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toEqual(expect.arrayContaining(["android_status", "android_observe", "android_action", "android_shell", "android_command_status"]));
  });
});
