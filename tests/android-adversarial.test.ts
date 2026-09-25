import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AndroidController, parseAndroidControllerConfig } from "../apps/mcp-server/src/android-controller.ts";
import { androidCommandRequestSchema, androidStateSchema } from "../packages/protocol/src/android.ts";

const token = "independent-test-credential-0123456789abcdef";
const state = { androidSdk: 36, manufacturer: "Fixture", model: "Simulator", build: "test", appVersion: "0.1.0", uid: 10100,
  screenOn: true, keyguardLocked: false, userUnlocked: true, accessibility: true, paused: false,
  shellAvailable: false, network: "cellular", batteryPercent: 70 };
const controllers: AndroidController[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(c => c.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(root?: string) {
  root ??= await mkdtemp(path.join(os.tmpdir(), "android-adversarial-"));
  if (!roots.includes(root)) roots.push(root);
  const config = { host: "127.0.0.1", port: 0, stateDir: root, devices: [{ name: "phone-example", token }] };
  const controller = new AndroidController(config, { pollWaitMs: 25 });
  controllers.push(controller);
  await controller.start();
  const base = `http://127.0.0.1:${controller.address()!.port}`;
  const sessionId = crypto.randomUUID();
  const post = (route: string, body: unknown, credential = token) => fetch(base + route, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body),
  });
  const poll = (overrides = {}, session = sessionId) => post("/android/v1/poll", { version: 1, device: "phone-example", sessionId: session, state: { ...state, ...overrides } });
  const body = (envelope: any, result: unknown = {}) => ({ version: 1, device: "phone-example", sessionId,
    commandId: envelope.commandId, deliveryId: envelope.deliveryId, ok: true, status: "completed", result });
  const connect = async () => { expect((await poll()).status).toBe(200); };
  const deliver = async (request: unknown = { operation: "global_action", action: "home" }, timeout = 5000) => {
    const id = crypto.randomUUID();
    const work = controller.execute(id, request, Date.now() + timeout);
    const envelope = (await (await poll()).json()).command;
    expect(envelope?.commandId).toBe(id);
    return { id, work, envelope };
  };
  return { root, config, controller, base, post, poll, body, connect, deliver, sessionId };
}

describe("Android independent failure/recovery regressions", () => {
  it("authenticates even malformed bodies before parsing and rejects cross-device binding", async () => {
    const f = await setup();
    const invalid = await fetch(f.base + "/android/v1/poll", { method: "POST", headers: { authorization: "Bearer invalid" }, body: "{broken" });
    expect(invalid.status).toBe(403);
    expect((await f.post("/android/v1/poll", { version: 1, device: "another-phone", sessionId: f.sessionId, state })).status).toBe(403);
    expect(f.controller.status("phone-example")).toMatchObject({ online: false });
  });

  it("rejects version/state mismatches without changing readiness", async () => {
    const f = await setup();
    expect((await f.post("/android/v1/poll", { version: 2, device: "phone-example", sessionId: f.sessionId, state })).status).toBe(400);
    expect((await f.poll({ shellAvailable: "yes" })).status).toBe(400);
    expect(f.controller.status("phone-example")).toMatchObject({ online: false });
  });

  it("records unavailable battery and backward-compatible control generation truthfully", () => {
    const parsed = androidStateSchema.parse({ ...state, batteryPercent: null });
    expect(parsed.batteryPercent).toBeNull();
    expect(parsed.controlGeneration).toBe(0);
    expect(androidStateSchema.parse({ ...state, controlGeneration: 17 }).controlGeneration).toBe(17);
    expect(androidStateSchema.safeParse({ ...state, batteryPercent: -1 }).success).toBe(false);
    expect(androidStateSchema.safeParse({ ...state, controlGeneration: 2_147_483_648 }).success).toBe(false);
  });

  it("bounds set_text and positional node IDs before companion dispatch", () => {
    const snapshotId = crypto.randomUUID();
    const base = { operation: "set_text", snapshotId, nodeId: "0" };
    expect(androidCommandRequestSchema.safeParse({ ...base, text: "x".repeat(1024 * 1024) }).success).toBe(true);
    expect(androidCommandRequestSchema.safeParse({ ...base, text: "x".repeat(1024 * 1024 + 1) }).success).toBe(false);

    const deepestValid = "0/" + Array(999).fill("999").join("/");
    expect(androidCommandRequestSchema.safeParse({ operation: "node_action", snapshotId, nodeId: deepestValid, action: "click" }).success).toBe(true);
    expect(androidCommandRequestSchema.safeParse({ operation: "node_action", snapshotId, nodeId: deepestValid + "/0", action: "click" }).success).toBe(false);
    expect(androidCommandRequestSchema.safeParse({ operation: "node_action", snapshotId, nodeId: "0/1000", action: "click" }).success).toBe(false);
    expect(androidCommandRequestSchema.safeParse({ operation: "node_action", snapshotId, nodeId: "0/" + "0/".repeat(2500), action: "click" }).success).toBe(false);
  });

  it("never dispatches an already-cancelled command", async () => {
    const f = await setup(); await f.connect();
    const abort = new AbortController(); abort.abort();
    const id = crypto.randomUUID();
    await expect(f.controller.execute(id, { operation: "global_action", action: "home" }, Date.now() + 5000, abort.signal)).resolves.toMatchObject({ status: "cancelled", ok: false });
    expect((await (await f.poll()).json()).command).toBeNull();
    expect(f.controller.status("PHONE-EXAMPLE")).toMatchObject({ queuedCommands: 0 });
  });

  it("serializes mutations and removes a cancelled queued command", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver();
    const abort = new AbortController();
    const id2 = crypto.randomUUID();
    const second = f.controller.execute(id2, { operation: "global_action", action: "back" }, Date.now() + 5000, abort.signal);
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 1, activeCommandId: first.id });
    expect((await (await f.poll()).json()).command).toBeNull();
    abort.abort();
    await expect(second).resolves.toMatchObject({ status: "cancelled" });
    expect((await f.post("/android/v1/result", f.body(first.envelope))).status).toBe(200);
    await expect(first.work).resolves.toMatchObject({ status: "completed" });
    expect((await (await f.poll()).json()).command).toBeNull();
  });

  it("expires queued work without residual queue entries", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver();
    const id2 = crypto.randomUUID();
    await expect(f.controller.execute(id2, { operation: "global_action", action: "back" }, Date.now() + 20)).resolves.toMatchObject({ status: "expired" });
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 0 });
    await f.post("/android/v1/result", f.body(first.envelope)); await first.work;
  });

  it("keeps queued deadline transitions recoverable when journal persistence fails", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver();
    const secondId = crypto.randomUUID();
    const second = f.controller.execute(secondId, { operation: "global_action", action: "back" }, Date.now() + 30_000);
    const internal = f.controller as any;
    const device = internal.find("phone-example");
    const queued = device.commands.get(secondId);

    await rm(f.root, { recursive: true, force: true });
    await writeFile(f.root, "temporarily-not-a-directory");
    expect(() => internal.handleDeadline(device, queued)).not.toThrow();
    expect(queued.status).toBe("queued");
    expect(device.queue).toContain(secondId);

    await rm(f.root, { force: true });
    await mkdir(f.root, { recursive: true });
    internal.handleDeadline(device, queued);
    await expect(second).resolves.toMatchObject({ status: "expired", ok: false });
    expect(device.queue).not.toContain(secondId);

    expect((await f.post("/android/v1/result", f.body(first.envelope))).status).toBe(200);
    await expect(first.work).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps dispatched deadline transitions recoverable when journal persistence fails", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver(undefined, 30_000);
    const internal = f.controller as any;
    const device = internal.find("phone-example");
    const active = device.commands.get(first.id);

    await rm(f.root, { recursive: true, force: true });
    await writeFile(f.root, "temporarily-not-a-directory");
    expect(() => internal.handleDeadline(device, active)).not.toThrow();
    expect(active.status).toBe("dispatched");
    expect(active.unknownSynthetic).not.toBe(true);
    expect(device.active).toBe(active);

    await rm(f.root, { force: true });
    await mkdir(f.root, { recursive: true });
    internal.handleDeadline(device, active);
    await expect(first.work).resolves.toMatchObject({ status: "outcome_unknown", ok: false });
    expect(active.status).toBe("outcome_unknown");
    expect(active.unknownSynthetic).toBe(true);
  });

  it("holds uncertain input until the phone returns its authoritative result", async () => {
    const f = await setup(); await f.connect();
    // Give slow hosted Windows enough time to dispatch through the HTTP
    // poll before the deadline. The assertion is about post-dispatch unknown
    // outcome semantics, not sub-100ms controller scheduling latency.
    const first = await f.deliver(undefined, 1000);
    await expect(first.work).resolves.toMatchObject({ status: "outcome_unknown" });
    const id2 = crypto.randomUUID();
    const second = f.controller.execute(id2, { operation: "global_action", action: "back" }, Date.now() + 5000);
    expect((await (await f.poll()).json()).command).toBeNull();
    expect(f.controller.status("phone-example")).toMatchObject({ activeCommandId: first.id });
    expect((await f.post("/android/v1/result", f.body(first.envelope))).status).toBe(200);
    const envelope2 = (await (await f.poll()).json()).command;
    expect(envelope2.commandId).toBe(id2);
    await f.post("/android/v1/result", f.body(envelope2)); await second;
  });

  it("a fresh phone session releases a command whose poll response was lost without replaying it", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver();
    const secondId = crypto.randomUUID();
    const second = f.controller.execute(secondId, { operation: "global_action", action: "back" }, Date.now() + 5000);

    // Retrying the long poll with the same session must not replay the first
    // command whose delivery outcome is unknown.
    expect((await (await f.poll()).json()).command).toBeNull();

    const replacementSession = crypto.randomUUID();
    const replacementPoll = await f.poll({}, replacementSession);
    const secondEnvelope = (await replacementPoll.json()).command;
    expect(secondEnvelope.commandId).toBe(secondId);
    await expect(first.work).resolves.toMatchObject({ status: "outcome_unknown" });

    const result = { version: 1, device: "phone-example", sessionId: replacementSession,
      commandId: secondEnvelope.commandId, deliveryId: secondEnvelope.deliveryId,
      ok: true, status: "completed", result: {} };
    expect((await f.post("/android/v1/result", result)).status).toBe(200);
    await expect(second).resolves.toMatchObject({ status: "completed" });
  });

  it("cancels queued work when local STOP advances the durable control generation", async () => {
    const f = await setup(); await f.connect();
    const active = await f.deliver({ operation: "global_action", action: "home" });
    const queuedId = crypto.randomUUID();
    const queued = f.controller.execute(
      queuedId, { operation: "global_action", action: "back" }, Date.now() + 30_000,
    );
    expect(f.controller.status("phone-example")).toMatchObject({ activeCommandId: active.id, queuedCommands: 1 });

    const replacementSession = crypto.randomUUID();
    const replacement = await f.poll({ controlGeneration: 1 }, replacementSession);
    expect(replacement.status).toBe(200);
    expect((await replacement.json()).command).toBeNull();

    await expect(active.work).resolves.toMatchObject({ status: "outcome_unknown", ok: false });
    await expect(queued).resolves.toMatchObject({ commandId: queuedId, status: "cancelled", ok: false });
    expect(f.controller.lookup(queuedId)).toMatchObject({ status: "cancelled" });
    expect(f.controller.status("phone-example")).toMatchObject({ online: true, queuedCommands: 0, activeCommandId: null });

    const next = await f.poll({}, replacementSession);
    expect((await next.json()).command).toBeNull();
  });

  it("releases serialized input after the phone authoritatively reports outcome_unknown", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver();
    const secondId = crypto.randomUUID();
    const second = f.controller.execute(secondId, { operation: "global_action", action: "back" }, Date.now() + 5000);

    const unknown = {
      version: 1, device: "phone-example", sessionId: f.sessionId,
      commandId: first.envelope.commandId, deliveryId: first.envelope.deliveryId,
      ok: false, status: "outcome_unknown",
      error: { code: "outcome_unknown", message: "phone_could_not_prove_completion" },
    };
    expect((await f.post("/android/v1/result", unknown)).status).toBe(200);
    await expect(first.work).resolves.toMatchObject({ status: "outcome_unknown", ok: false });

    const secondEnvelope = (await (await f.poll()).json()).command;
    expect(secondEnvelope.commandId).toBe(secondId);
    expect(f.controller.status("phone-example")).toMatchObject({ activeCommandId: secondId });
    expect((await f.post("/android/v1/result", f.body(secondEnvelope))).status).toBe(200);
    await expect(second).resolves.toMatchObject({ status: "completed" });
  });

  it("rolls back an accepted-in-memory submission when the durable journal write fails", async () => {
    const f = await setup(); await f.connect();
    await rm(f.root, { recursive: true, force: true });
    await writeFile(f.root, "not-a-directory");
    const commandId = crypto.randomUUID();
    expect(() => f.controller.execute(commandId, { operation: "global_action", action: "home" }, Date.now() + 5000)).toThrow();
    expect(f.controller.lookup(commandId)).toBeNull();
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 0, activeCommandId: null });

    await rm(f.root, { force: true });
    await mkdir(f.root, { recursive: true });
    expect((await (await f.poll()).json()).command).toBeNull();
  });

  it("keeps the original caller attached when dispatch persistence fails against a waiting poll", async () => {
    const f = await setup(); await f.connect();
    const internal = f.controller as any;
    internal.pollWaitMs = 5_000;
    const device = internal.find("phone-example");
    const waitingPoll = f.poll();
    await expect.poll(() => Boolean(device.poll), { interval: 5, timeout: 1_000 }).toBe(true);

    const originalPersist = internal.persist.bind(internal);
    let persistCalls = 0;
    internal.persist = (candidate: unknown) => {
      persistCalls++;
      if (persistCalls === 2) throw new Error("injected-dispatch-persist-failure");
      return originalPersist(candidate);
    };

    const commandId = crypto.randomUUID();
    const work = f.controller.execute(
      commandId, { operation: "global_action", action: "home" }, Date.now() + 30_000,
    );
    expect(f.controller.lookup(commandId)).toMatchObject({ status: "queued" });
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 1, activeCommandId: null });

    internal.persist = originalPersist;
    internal.dispatchNext(device);
    const envelope = (await (await waitingPoll).json()).command;
    expect(envelope.commandId).toBe(commandId);
    expect((await f.post("/android/v1/result", f.body(envelope))).status).toBe(200);
    await expect(work).resolves.toMatchObject({ commandId, status: "completed", ok: true });
  });

  it("restores a queued command when dispatch journaling fails before poll delivery", async () => {
    const f = await setup(); await f.connect();
    const commandId = crypto.randomUUID();
    const work = f.controller.execute(commandId, { operation: "global_action", action: "home" }, Date.now() + 30_000);
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 1, activeCommandId: null });

    await rm(f.root, { recursive: true, force: true });
    await writeFile(f.root, "temporarily-not-a-directory");
    expect((await f.poll()).status).toBe(500);
    expect(f.controller.lookup(commandId)).toMatchObject({ status: "queued" });
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 1, activeCommandId: null });

    await rm(f.root, { force: true });
    await mkdir(f.root, { recursive: true });
    const envelope = (await (await f.poll()).json()).command;
    expect(envelope.commandId).toBe(commandId);
    expect(f.controller.lookup(commandId)).toMatchObject({ status: "dispatched", deliveryId: envelope.deliveryId });
    expect((await f.post("/android/v1/result", f.body(envelope))).status).toBe(200);
    await expect(work).resolves.toMatchObject({ status: "completed", ok: true });
  });

  it("keeps the original caller pending and retryable when terminal journaling fails", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver();
    const result = f.body(first.envelope, { accepted: true });

    await rm(f.root, { recursive: true, force: true });
    await writeFile(f.root, "temporarily-not-a-directory");
    expect((await f.post("/android/v1/result", result)).status).toBe(500);
    expect(f.controller.lookup(first.id)).toMatchObject({ status: "dispatched", deliveryId: first.envelope.deliveryId });
    expect(f.controller.status("phone-example")).toMatchObject({ activeCommandId: first.id });

    await rm(f.root, { force: true });
    await mkdir(f.root, { recursive: true });
    expect((await f.post("/android/v1/result", result)).status).toBe(200);
    await expect(first.work).resolves.toMatchObject({ status: "completed", ok: true });
    expect(f.controller.lookup(first.id)).toMatchObject({ status: "completed" });
  });

  it("keeps an already-aborted caller attached until queued cancellation is durable", async () => {
    const f = await setup(); await f.connect();
    const internal = f.controller as any;
    const originalPersist = internal.persist.bind(internal);
    let persistCalls = 0;
    internal.persist = (candidate: unknown) => {
      persistCalls++;
      if (persistCalls === 2) throw new Error("injected-cancel-persist-failure");
      return originalPersist(candidate);
    };

    const abort = new AbortController();
    abort.abort();
    const commandId = crypto.randomUUID();
    const work = f.controller.execute(
      commandId, { operation: "global_action", action: "home" }, Date.now() + 30_000, abort.signal,
    );

    expect(f.controller.lookup(commandId)).toMatchObject({ status: "queued" });
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 1, activeCommandId: null });

    internal.persist = originalPersist;
    await expect(work).resolves.toMatchObject({ commandId, status: "cancelled", ok: false });
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 0, activeCommandId: null });
    expect((await (await f.poll()).json()).command).toBeNull();
  });

  it("invalidates a session immediately when its outstanding long poll disconnects", async () => {
    const f = await setup(); await f.connect();
    const internal = f.controller as any;
    internal.pollWaitMs = 5_000;
    const pollAbort = new AbortController();
    const waiting = fetch(f.base + "/android/v1/poll", {
      method: "POST",
      signal: pollAbort.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ version: 1, device: "phone-example", sessionId: f.sessionId, state }),
    });
    const device = internal.find("phone-example");
    await expect.poll(() => Boolean(device.poll), { interval: 5, timeout: 1_000 }).toBe(true);

    pollAbort.abort();
    await expect(waiting).rejects.toThrow();
    await expect.poll(() => (f.controller.status("phone-example") as any).online, { interval: 5, timeout: 1_000 }).toBe(false);

    const commandId = crypto.randomUUID();
    expect(() => f.controller.execute(
      commandId, { operation: "global_action", action: "home" }, Date.now() + 30_000,
    )).toThrow(/no recent authenticated poll/i);
    expect(f.controller.lookup(commandId)).toBeNull();
  });

  it("does not dispatch a second command after an expired head consumes the waiting poll", async () => {
    const f = await setup(); await f.connect();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const thirdId = crypto.randomUUID();
    const first = f.controller.execute(firstId, { operation: "global_action", action: "home" }, Date.now() + 30_000);
    const second = f.controller.execute(secondId, { operation: "global_action", action: "back" }, Date.now() + 30_000);
    const third = f.controller.execute(thirdId, { operation: "global_action", action: "recents" }, Date.now() + 30_000);

    const internal = f.controller as any;
    const device = internal.find("phone-example");
    const firstCommand = device.commands.get(firstId);
    clearTimeout(firstCommand.timer);
    firstCommand.expiresAt = Date.now() - 1;

    const envelope = (await (await f.poll()).json()).command;
    expect(envelope.commandId).toBe(secondId);
    await expect(first).resolves.toMatchObject({ status: "expired", ok: false });
    expect(f.controller.lookup(thirdId)).toMatchObject({ status: "queued" });
    expect(f.controller.status("phone-example")).toMatchObject({ activeCommandId: secondId, queuedCommands: 1 });

    expect((await f.post("/android/v1/result", f.body(envelope))).status).toBe(200);
    await expect(second).resolves.toMatchObject({ status: "completed", ok: true });

    const thirdEnvelope = (await (await f.poll()).json()).command;
    expect(thirdEnvelope.commandId).toBe(thirdId);
    expect((await f.post("/android/v1/result", f.body(thirdEnvelope))).status).toBe(200);
    await expect(third).resolves.toMatchObject({ status: "completed", ok: true });
  });

  it("restores queued membership when cancellation cannot persist", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver();
    const secondId = crypto.randomUUID();
    const second = f.controller.execute(secondId, { operation: "global_action", action: "back" }, Date.now() + 30_000);
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 1, activeCommandId: first.id });

    const internal = f.controller as any;
    const device = internal.find("phone-example");
    const queued = device.commands.get(secondId);
    await rm(f.root, { recursive: true, force: true });
    await writeFile(f.root, "temporarily-not-a-directory");

    expect(() => internal.cancelQueued(device, queued, "cancelled")).toThrow();
    expect(queued.status).toBe("queued");
    expect(device.queue).toContain(secondId);
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 1, activeCommandId: first.id });

    await rm(f.root, { force: true });
    await mkdir(f.root, { recursive: true });
    internal.cancelQueued(device, queued, "cancelled");
    await expect(second).resolves.toMatchObject({ status: "cancelled", ok: false });
    expect(f.controller.status("phone-example")).toMatchObject({ queuedCommands: 0, activeCommandId: first.id });

    expect((await f.post("/android/v1/result", f.body(first.envelope))).status).toBe(200);
    await expect(first.work).resolves.toMatchObject({ status: "completed" });
  });

  it("always closes the Android listener even when shutdown persistence fails", async () => {
    const f = await setup(); await f.connect();
    const commandId = crypto.randomUUID();
    void f.controller.execute(commandId, { operation: "global_action", action: "home" }, Date.now() + 30_000);
    expect(f.controller.lookup(commandId)).toMatchObject({ status: "queued" });

    await rm(f.root, { recursive: true, force: true });
    await writeFile(f.root, "temporarily-not-a-directory");

    await expect(f.controller.close()).rejects.toThrow();
    expect(f.controller.address()).toBeNull();
    expect(f.controller.lookup(commandId)).toMatchObject({ status: "queued" });
    await expect(fetch(f.base + "/android/v1/poll", {
      method: "POST",
      signal: AbortSignal.timeout(1000),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ version: 1, device: "phone-example", sessionId: f.sessionId, state }),
    })).rejects.toThrow();
  });

  it("finishes queued and dispatched callers truthfully during shutdown", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver();
    const second = f.controller.execute(crypto.randomUUID(), { operation: "global_action", action: "back" }, Date.now() + 5000);
    await f.controller.close();
    await expect(first.work).resolves.toMatchObject({ status: "outcome_unknown" });
    await expect(second).resolves.toMatchObject({ status: "cancelled" });
    expect(f.controller.status("phone-example")).toMatchObject({ online: false, queuedCommands: 0 });
  });

  it("preserves completion digest after restart and rejects altered result replay", async () => {
    const f = await setup(); await f.connect();
    const first = await f.deliver(); const result = f.body(first.envelope, { accepted: true });
    await f.post("/android/v1/result", result); await first.work; await f.controller.close();
    const resumed = await setup(f.root);
    expect((await resumed.post("/android/v1/result", result)).status).toBe(200);
    expect((await resumed.post("/android/v1/result", { ...result, result: { accepted: false } })).status).toBe(409);
    expect(resumed.controller.lookup(first.id)).toMatchObject({ status: "completed" });
  });

  it("does not reinterpret cancelled commands as executed after restart", async () => {
    const f = await setup(); await f.connect(); const abort = new AbortController(); abort.abort();
    const id = crypto.randomUUID();
    await f.controller.execute(id, { operation: "global_action", action: "home" }, Date.now() + 5000, abort.signal);
    await f.controller.close(); const resumed = await setup(f.root);
    expect(resumed.controller.lookup(id)).toMatchObject({ status: "cancelled" });
  });

  it("refuses a corrupt command journal rather than silently forgetting a tombstone", async () => {
    const f = await setup(); await f.connect(); const first = await f.deliver();
    await f.controller.close(); await first.work;
    const file = (await readdir(f.root)).find(name => name.endsWith(".json"))!;
    await writeFile(path.join(f.root, file), JSON.stringify({ version: 1, commands: [{ commandId: first.id, fingerprint: "corrupt", status: "completed" }] }));
    expect(() => new AndroidController(f.config)).toThrow(/Invalid Android command journal/);
  });

  it("stores no screen, credential or typed-text payload and handles results larger than 4MiB", async () => {
    const f = await setup(); await f.connect(); const first = await f.deliver();
    const marker = "private-output-not-to-persist";
    const response = await f.post("/android/v1/result", f.body(first.envelope, { payload: marker + "x".repeat(5 * 1024 * 1024) }));
    expect(response.status).toBe(200); await first.work;
    const journal = await readFile(path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".json"))!), "utf8");
    expect(journal).not.toContain(marker); expect(journal).not.toContain(token); expect(journal.length).toBeLessThan(2048);
  });

  it("requires valid snapshot metadata for a successful observation", async () => {
    const f = await setup(); await f.connect(); const first = await f.deliver({ operation: "observe", image: false, tree: true });
    expect((await f.post("/android/v1/result", f.body(first.envelope, { noSnapshot: true }))).status).toBe(400);
    expect(f.controller.lookup(first.id)).toMatchObject({ status: "dispatched" });
    await f.controller.close(); await expect(first.work).resolves.toMatchObject({ status: "outcome_unknown" });
  });

  it("rejects shared/invalid phone credentials and accidental public listeners", () => {
    expect(() => parseAndroidControllerConfig({ host: "0.0.0.0", port: 45236, stateDir: path.resolve("/tmp/example"), devices: [{ name: "phone", token }] })).toThrow(/loopback or a literal Tailscale/);
    expect(() => parseAndroidControllerConfig({ host: "127.0.0.1", port: 45236, stateDir: path.resolve("/tmp/example"), devices: [{ name: "phone", token }, { name: "phone2", token }] })).toThrow(/independent credentials/);
    expect(() => parseAndroidControllerConfig({ host: "127.0.0.1", port: 45236, stateDir: path.resolve("/tmp/example"), devices: [{ name: "phone example", token }] })).toThrow();
    expect(() => parseAndroidControllerConfig({ host: "127.0.0.1", port: 45236, stateDir: path.resolve("/tmp/example"), devices: [{ name: "phone", token: "0123456789abcdef 0123456789abcdef" }] })).toThrow();
  });
});
