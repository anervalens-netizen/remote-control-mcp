import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { AndroidController, AndroidControllerError, type AndroidControllerConfig } from "../apps/mcp-server/src/android-controller.ts";
import { resolveExecutionContext } from "../apps/mcp-server/src/execution-identity.ts";

const controllers: AndroidController[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const token = "android-test-token-012345678901234567890123456789";
const state = {
  androidSdk: 36, manufacturer: "OnePlus", model: "Nord", build: "test-build", appVersion: "0.1.0", uid: 12345,
  screenOn: true, keyguardLocked: false, userUnlocked: true, accessibility: true, paused: false,
  shellAvailable: false, network: "cellular", batteryPercent: 80,
};

async function makeController(devices = [{ name: "phone-example", token }], options?: { offlineAfterMs?: number; maxDetailedCommands?: number }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-android-controller-"));
  roots.push(root);
  const config: AndroidControllerConfig = { host: "127.0.0.1", port: 0, stateDir: root, devices };
  const controller = new AndroidController(config, options);
  controllers.push(controller);
  await controller.start();
  const address = controller.address();
  if (!address) throw new Error("controller did not bind");
  return { controller, base: `http://127.0.0.1:${address.port}`, root };
}

async function post(base: string, route: string, body: unknown, credential = token, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function pollBody(sessionId = crypto.randomUUID(), device = "phone-example", overrides: Record<string, unknown> = {}) {
  return { version: 1, device, sessionId, state: { ...state, ...overrides } };
}

async function waitOnline(controller: AndroidController, device = "phone-example") {
  await expect.poll(() => (controller.status(device) as { online: boolean }).online, { interval: 5, timeout: 2_000 }).toBe(true);
}

const observe = { operation: "observe" as const, image: true, tree: true, maxNodes: 200 };

describe("Android reverse controller protocol and durable ledger", () => {
  it("authenticates before command handling and exposes truthful readiness state", async () => {
    const { controller, base } = await makeController();
    expect((await post(base, "/android/v1/poll", pollBody(), "wrong-token"))).toMatchObject({ status: 403 });
    expect((await post(base, "/android/v1/poll", { nope: true })).status).toBe(403);
    const sessionId = crypto.randomUUID();
    const abort = new AbortController();
    const poll = post(base, "/android/v1/poll", pollBody(sessionId, "phone-example", { accessibility: false, keyguardLocked: true }), token, abort.signal);
    await waitOnline(controller);
    expect(controller.status("phone-example")).toMatchObject({ online: true, readiness: "accessibility_unavailable", observedAt: expect.any(Number), lastPollAt: expect.any(Number) });
    abort.abort();
    await expect(poll).rejects.toMatchObject({ name: "AbortError" });
  });

  it("dispatches one command atomically, deduplicates identical callers, and binds results to delivery", async () => {
    const { controller, base } = await makeController();
    const sessionId = crypto.randomUUID();
    const pollPromise = post(base, "/android/v1/poll", pollBody(sessionId));
    await waitOnline(controller);
    const commandId = crypto.randomUUID();
    const first = controller.execute(commandId, observe, Date.now() + 5_000);
    const retryAbort = new AbortController();
    const second = controller.execute(commandId, observe, Date.now() + 5_000, retryAbort.signal);
    retryAbort.abort();
    await expect(second).resolves.toMatchObject({
      commandId, status: "cancelled", ok: false,
      error: { code: "wait_cancelled" },
    });
    expect(controller.lookup(commandId)).toMatchObject({ status: "dispatched" });
    const poll = await pollPromise;
    const pollResponse = await poll.json();
    expect(pollResponse).toMatchObject({ version: 1, serverTime: expect.any(Number), serverWaitMs: expect.any(Number) });
    const envelope = pollResponse.command;
    expect(envelope).toMatchObject({ commandId, request: observe, deliveryId: expect.any(String), expiresAt: expect.any(Number) });
    const snapshot = { snapshotId: crypto.randomUUID(), observedAt: Date.now(), width: 1080, height: 2400, rotation: 0, generation: "g1" };
    const incomplete = { version: 1, device: "phone-example", sessionId, commandId, deliveryId: envelope.deliveryId, ok: true, status: "completed", result: { snapshot } };
    expect((await post(base, "/android/v1/result", incomplete)).status).toBe(400);
    const resultBody = { ...incomplete, result: { snapshot, image: { available: false, reason: "test_unavailable" }, nodes: [], treeTruncated: false } };
    expect((await post(base, "/android/v1/result", resultBody)).status).toBe(200);
    expect(await first).toMatchObject({ commandId, status: "completed", ok: true });
    expect(controller.lookup(commandId)).toMatchObject({ status: "completed" });
    expect((controller.lookup(commandId) as { result?: unknown }).result).toBeUndefined();
    expect((await post(base, "/android/v1/result", { ...resultBody, result: { ...resultBody.result, changed: true } })).status).toBe(409);
    expect(() => controller.execute(commandId, { operation: "global_action", action: "home" }, Date.now() + 5000)).toThrow(/different input/);
  });

  it("treats an actively dispatched command as expected liveness until its deadline", async () => {
    const { controller, base } = await makeController(
      [{ name: "phone-example", token }], { offlineAfterMs: 20 },
    );
    const sessionId = crypto.randomUUID();
    const pollPromise = post(base, "/android/v1/poll", pollBody(sessionId));
    await waitOnline(controller);
    const commandId = crypto.randomUUID();
    const work = controller.execute(
      commandId,
      { operation: "shell", command: "sleep 1", timeoutMs: 1_000, maxOutputBytes: 1024 },
      Date.now() + 2_000,
    );
    const envelope = (await (await pollPromise).json()).command;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(controller.status("phone-example")).toMatchObject({ online: true, activeCommandId: commandId });
    const result = {
      version: 1, device: "phone-example", sessionId, commandId,
      deliveryId: envelope.deliveryId, ok: true, status: "completed",
      result: { code: 0, stdout: "", stderr: "", timedOut: false, uid: 2000 },
    };
    expect((await post(base, "/android/v1/result", result)).status).toBe(200);
    await expect(work).resolves.toMatchObject({ status: "completed", ok: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(controller.status("phone-example")).toMatchObject({ online: false, activeCommandId: null });
  });

  it("rejects an encoded command that cannot fit in the companion poll response before dispatch", async () => {
    const { controller } = await makeController();
    const commandId = crypto.randomUUID();
    const escapeHeavyScript = "\u0001".repeat(3_000_000);
    expect(() => controller.execute(
      commandId,
      { operation: "shell", command: escapeHeavyScript },
      Date.now() + 30_000,
    )).toThrowError(expect.objectContaining({ code: "request_too_large", status: 413 }));
    expect(controller.lookup(commandId)).toBeNull();
  });

  it("rejects offline work, cancels queued work without dispatch, and never replays an unknown effect", async () => {
    const { controller, base } = await makeController([{ name: "phone-example", token }], { offlineAfterMs: 2_000 });
    const commandId = crypto.randomUUID();
    await expect((async () => controller.execute(commandId, observe, Date.now() + 1000))()).rejects.toMatchObject({ code: "offline" });

    const sessionId = crypto.randomUUID();
    const pollPromise = post(base, "/android/v1/poll", pollBody(sessionId));
    await waitOnline(controller);
    const abort = new AbortController();
    const dispatchedId = crypto.randomUUID();
    const work = controller.execute(dispatchedId, observe, Date.now() + 5_000, abort.signal);
    const envelope = (await (await pollPromise).json()).command;
    abort.abort();
    await expect(work).resolves.toMatchObject({ commandId: dispatchedId, status: "outcome_unknown", ok: false });
    expect(controller.lookup(dispatchedId)).toMatchObject({ status: "outcome_unknown" });
    const nextPollAbort = new AbortController();
    const nextPoll = post(base, "/android/v1/poll", pollBody(sessionId), token, nextPollAbort.signal);
    await expect(Promise.race([nextPoll.then(async (response) => (await response.json()).command), new Promise((resolve) => setTimeout(() => resolve(null), 50))])).resolves.toBeNull();
    nextPollAbort.abort();
    await nextPoll.catch(() => undefined);
    expect(envelope.commandId).toBe(dispatchedId);
  });

  it("recovers dispatched commands as tombstones and accepts only their late authoritative result", async () => {
    const first = await makeController();
    const sessionId = crypto.randomUUID();
    const pollPromise = post(first.base, "/android/v1/poll", pollBody(sessionId));
    await waitOnline(first.controller);
    const commandId = crypto.randomUUID();
    const work = first.controller.execute(commandId, observe, Date.now() + 10_000);
    const envelope = (await (await pollPromise).json()).command;
    await first.controller.close();
    await expect(work).resolves.toMatchObject({ status: "outcome_unknown" });

    const second = new AndroidController({ host: "127.0.0.1", port: 0, stateDir: first.root, devices: [{ name: "phone-example", token }] });
    controllers.push(second);
    expect(second.lookup(commandId)).toMatchObject({ commandId, status: "outcome_unknown", deliveryId: envelope.deliveryId, sessionId });
    await second.start();
    const late = { version: 1, device: "phone-example", sessionId, commandId, deliveryId: envelope.deliveryId, ok: false, status: "error", error: { code: "accessibility_unavailable", message: "not available" } };
    expect((await post(`http://127.0.0.1:${second.address()!.port}`, "/android/v1/result", late)).status).toBe(200);
    expect(second.lookup(commandId)).toMatchObject({ status: "error" });
    expect(() => second.execute(commandId, { operation: "global_action", action: "home" }, Date.now() + 1000)).toThrowError(AndroidControllerError);
  });

  it("accepts a valid late result from a pre-operation journal after upgrade", async () => {
    const first = await makeController();
    const sessionId = crypto.randomUUID();
    const pollPromise = post(first.base, "/android/v1/poll", pollBody(sessionId));
    await waitOnline(first.controller);
    const commandId = crypto.randomUUID();
    const work = first.controller.execute(commandId, { operation: "global_action", action: "home" }, Date.now() + 10_000);
    const envelope = (await (await pollPromise).json()).command;
    await first.controller.close();
    await expect(work).resolves.toMatchObject({ status: "outcome_unknown" });

    const files = await (await import("node:fs/promises")).readdir(first.root);
    const journalPath = path.join(first.root, files.find((file) => file.endsWith(".json"))!);
    const legacyJournal = JSON.parse(await readFile(journalPath, "utf8"));
    delete legacyJournal.commands[0].operation;
    await writeFile(journalPath, JSON.stringify(legacyJournal));

    const second = new AndroidController({ host: "127.0.0.1", port: 0, stateDir: first.root, devices: [{ name: "phone-example", token }] });
    controllers.push(second);
    await second.start();
    const base = `http://127.0.0.1:${second.address()!.port}`;
    const late = { version: 1, device: "phone-example", sessionId, commandId, deliveryId: envelope.deliveryId, ok: true, status: "completed", result: {} };
    expect((await post(base, "/android/v1/result", late)).status).toBe(200);
    expect(second.lookup(commandId)).toMatchObject({ status: "completed" });
  });

  it("migrates legacy observe fingerprints so restarted results still require snapshots", async () => {
    const first = await makeController();
    const sessionId = crypto.randomUUID();
    const pollPromise = post(first.base, "/android/v1/poll", pollBody(sessionId));
    await waitOnline(first.controller);
    const commandId = crypto.randomUUID();
    const work = first.controller.execute(commandId, observe, Date.now() + 10_000);
    const envelope = (await (await pollPromise).json()).command;
    await first.controller.close();
    await expect(work).resolves.toMatchObject({ status: "outcome_unknown" });

    const files = await (await import("node:fs/promises")).readdir(first.root);
    const journalPath = path.join(first.root, files.find((file) => file.endsWith(".json"))!);
    const legacyJournal = JSON.parse(await readFile(journalPath, "utf8"));
    delete legacyJournal.commands[0].operation;
    await writeFile(journalPath, JSON.stringify(legacyJournal));

    const second = new AndroidController({ host: "127.0.0.1", port: 0, stateDir: first.root, devices: [{ name: "phone-example", token }] });
    controllers.push(second);
    await second.start();
    const base = `http://127.0.0.1:${second.address()!.port}`;
    const invalid = { version: 1, device: "phone-example", sessionId, commandId, deliveryId: envelope.deliveryId, ok: true, status: "completed", result: {} };
    expect((await post(base, "/android/v1/result", invalid)).status).toBe(400);
    const valid = { ...invalid, result: {
      snapshot: { snapshotId: crypto.randomUUID(), observedAt: Date.now(), width: 1080, height: 2400, rotation: 0, generation: "g2" },
      image: { available: false, reason: "test_unavailable" }, nodes: [], treeTruncated: false,
    } };
    expect((await post(base, "/android/v1/result", valid)).status).toBe(200);
    expect(second.lookup(commandId)).toMatchObject({ status: "completed" });
  });

  it("compacts terminal command details into a durable fail-closed no-replay filter", async () => {
    const first = await makeController([{ name: "phone-example", token }], { maxDetailedCommands: 2 });
    const sessionId = crypto.randomUUID();
    const ids: string[] = [];
    const acceptedResults: unknown[] = [];
    for (let index = 0; index < 4; index++) {
      const pollPromise = post(first.base, "/android/v1/poll", pollBody(sessionId));
      await waitOnline(first.controller);
      const commandId = crypto.randomUUID();
      ids.push(commandId);
      const work = first.controller.execute(commandId, { operation: "global_action", action: "home" }, Date.now() + 5_000);
      const envelope = (await (await pollPromise).json()).command;
      const result = { version: 1, device: "phone-example", sessionId, commandId, deliveryId: envelope.deliveryId, ok: true, status: "completed", result: {} };
      acceptedResults.push(result);
      expect((await post(first.base, "/android/v1/result", result)).status).toBe(200);
      await expect(work).resolves.toMatchObject({ status: "completed" });
    }
    expect(first.controller.lookup(ids[0]!)).toMatchObject({ status: "history_unavailable", compacted: true, noReplay: true });
    expect((await post(first.base, "/android/v1/result", acceptedResults[0])).status).toBe(200);
    const files = await (await import("node:fs/promises")).readdir(first.root);
    expect(files.some((file) => file.endsWith(".seen"))).toBe(true);
    const journalName = files.find((file) => file.endsWith(".json"))!;
    const journal = JSON.parse(await readFile(path.join(first.root, journalName), "utf8"));
    expect(journal.commands.length).toBeLessThanOrEqual(2);
    await first.controller.close();

    const second = new AndroidController({ host: "127.0.0.1", port: 0, stateDir: first.root, devices: [{ name: "phone-example", token }] }, { maxDetailedCommands: 2 });
    controllers.push(second);
    expect(second.lookup(ids[0]!)).toMatchObject({
      commandId: ids[0], status: "history_unavailable", compacted: true, noReplay: true,
      reason: "terminal_history_compacted_or_filter_match",
    });
    expect(() => second.execute(ids[0]!, { operation: "global_action", action: "home" }, Date.now() + 5_000)).toThrow(/compacted.*will not be replayed/);
  });

  it("separates Android user routing from unavailable root/system capability", async () => {
    const { controller } = await makeController();
    const client = new AgentClient([], undefined, undefined, controller);
    expect(client.configuredContexts("phone-example")).toEqual({ system: false, user: true, desktop: false });
    expect(resolveExecutionContext(client, "phone-example", { identity: "auto" }, "system")).toBe("user");
    expect(() => resolveExecutionContext(client, "phone-example", { identity: "root" }, "system")).toThrow(/system\/root identity/);
    expect(client.devices).toContainEqual({ name: "phone-example", url: "android-reverse://phone-example", transport: "android-reverse" });
  });

  it("keeps the command store private and detects token revocation", async () => {
    const first = await makeController();
    const files = await (await import("node:fs/promises")).readdir(first.root);
    expect(files).toHaveLength(0);
    await first.controller.close();
    const revoked = new AndroidController({ host: "127.0.0.1", port: 0, stateDir: first.root, devices: [{ name: "phone-example", token: "new-android-token-012345678901234567890123" }] });
    controllers.push(revoked);
    await revoked.start();
    const base = `http://127.0.0.1:${revoked.address()!.port}`;
    expect((await post(base, "/android/v1/poll", pollBody(), token)).status).toBe(403);
    const validPollAbort = new AbortController();
    const validPoll = post(base, "/android/v1/poll", pollBody(), "new-android-token-012345678901234567890123", validPollAbort.signal);
    await waitOnline(revoked);
    expect(revoked.status("phone-example")).toMatchObject({ online: true });
    validPollAbort.abort();
    await expect(validPoll).rejects.toMatchObject({ name: "AbortError" });
    const filesAfter = await (await import("node:fs/promises")).readdir(first.root);
    expect(filesAfter.every((file) => file.endsWith(".json"))).toBe(true);
    for (const file of filesAfter) expect((await readFile(path.join(first.root, file), "utf8"))).not.toContain(token);
  });
});
