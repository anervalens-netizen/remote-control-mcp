import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ResourceCoordinator, coordinationHash, coordinationToken } from "../apps/agent/src/coordination.ts";
const resource = (name = "repo", identity = "owner") => ({ device: coordinationHash("device"), identity: coordinationHash(identity), canonicalKey: coordinationHash(name), baseVersion: coordinationHash("base") });
function fixture(budget = 4) {
  const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "coord-"));
  let now = 1000;
  return { root, coordinator: new ResourceCoordinator(root, budget, () => now), advance: () => { now += 31_000; } };
}
describe("resource fencing", () => {
  it("shares writers across sessions/identities, fences expiry and stale generations", () => {
    const { root, coordinator: a, advance } = fixture();
    const b = new ResourceCoordinator(root, 4, () => 32_000);
    const first = a.acquire(resource());
    expect(() => a.acquire(resource("repo", "system"))).toThrow("writer_reserved");
    advance();
    expect(() => a.begin(coordinationToken(first), resource())).toThrow("lease_expired");
    const second = b.acquire(resource("repo", "system"));
    expect(second.generation).toBe(2);
    expect(() => a.begin(coordinationToken(first), resource())).toThrow("stale_writer");
    expect(() => a.release(coordinationToken(first))).toThrow("stale_writer");
    expect(() => b.begin(coordinationToken(second), resource())).toThrow("resource_or_identity_changed");
    b.begin(coordinationToken(second), resource("repo", "system"));
    expect(() => a.acquire(resource())).toThrow("active_or_uncertain_writer");
  });
  it("revalidates base including owner override and keeps bounded audit evidence", () => {
    const { coordinator: c } = fixture();
    const r = c.acquire(resource());
    const changed = { ...resource(), baseVersion: coordinationHash("external edit") };
    expect(() => c.begin(coordinationToken(r), changed)).toThrow("base_changed");
    expect(() => c.acquire(changed, 1000, { expectedGeneration: r.generation, expectedBaseVersion: r.baseVersion, reason: "owner_takeover" })).toThrow("override_base_changed");
    const newer = c.acquire(changed, 1000, { expectedGeneration: r.generation, expectedBaseVersion: changed.baseVersion, reason: "owner_takeover" });
    expect(newer.overrides).toEqual([{ operationId: newer.operationId, previousOperationId: r.operationId, at: newer.createdAt, reason: "owner_takeover" }]);
    expect(() => c.begin(coordinationToken(r), resource())).toThrow("stale_writer");
    expect(() => c.begin(coordinationToken(newer), resource())).toThrow("base_changed");
    c.begin(coordinationToken(newer), changed);
    expect(() => c.acquire(changed, 1000, { expectedGeneration: newer.generation, expectedBaseVersion: changed.baseVersion, reason: "owner_takeover" })).toThrow("active_or_uncertain_writer");
  });
  it("releases reservations/cancelled work safely and admits independent resources", () => {
    const { coordinator: c, advance } = fixture(2);
    const one = c.acquire(resource("one")); c.begin(coordinationToken(one), resource("one"));
    const two = c.acquire(resource("two"));
    expect(() => c.acquire(resource("three"))).toThrow("device_backpressure");
    expect(c.inspect(resource("one")).record?.state).toBe("active");
    c.release(coordinationToken(two));
    const three = c.acquire(resource("three"));
    advance();
    expect(() => c.acquire(resource("one"))).toThrow("active_or_uncertain_writer");
    c.settle(coordinationToken(one));
    expect(c.acquire(resource("one")).generation).toBe(2);
    expect(three.operationId).not.toBe(one.operationId);
  });
  it("retains active/uncertain evidence and fencing across restart; orphan lock fails closed", () => {
    const { root, coordinator: c } = fixture();
    const one = c.acquire(resource()); c.begin(coordinationToken(one), resource());
    const restarted = new ResourceCoordinator(root);
    expect(() => restarted.acquire(resource())).toThrow("active_or_uncertain_writer");
    expect(restarted.acquire(resource("other")).operationId).toBeTruthy();
    expect(() => restarted.release(coordinationToken(one))).toThrow("active_or_uncertain_writer");
    c.settle(coordinationToken(one), { uncertain: true });
    expect(restarted.inspect(resource()).record?.conflictReason).toBe("effect_or_termination_unverified");
    writeFileSync(path.join(root, one.resourceId + ".json.lock"), "");
    expect(() => restarted.acquire(resource())).toThrow("admission_locked");
    expect(restarted.acquire(resource("third")).operationId).toBeTruthy();
    expect(restarted.inspect(resource()).record?.state).toBe("uncertain");
    const stored = readdirSync(root).filter(f => f.endsWith(".json")).map(f => readFileSync(path.join(root, f), "utf8")).join("");
    expect(stored).not.toContain('"command"'); expect(stored).not.toContain('"env"');
  });
});

it("shares the four-slot device budget across concurrent processes and restart", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile), { root } = fixture();
  const script = `import {ResourceCoordinator} from ${JSON.stringify(new URL("../apps/agent/src/coordination.ts", import.meta.url).href)};
try { const record=new ResourceCoordinator(process.argv[1]).acquire(JSON.parse(process.argv[2]));process.stdout.write(JSON.stringify({record})); }
catch(error) { if(error.reason!=='device_backpressure')throw error;process.stdout.write(JSON.stringify({reason:error.reason})); }`;
  const results = await Promise.all(Array.from({ length: 6 }, async (_, i) => JSON.parse((await run(process.execPath,
    ["--input-type=module", "-e", script, root, JSON.stringify(resource(`process-${i}`))])).stdout)));
  expect(results.filter(r => r.record)).toHaveLength(4);
  expect(results.filter(r => r.reason === "device_backpressure")).toHaveLength(2);
  expect(new Set(results.filter(r => r.record).map(r => r.record.budgetSlot)).size).toBe(4);
  const restarted = new ResourceCoordinator(root);
  expect(() => restarted.acquire(resource("seventh"))).toThrow("device_backpressure");
  restarted.release(coordinationToken(results.find(r => r.record).record));
  expect(restarted.acquire(resource("seventh")).state).toBe("reserved");
});

it.each(["missing", "mismatched", "corrupt", "locked"])("isolates %s resource evidence without reclaiming its slot", kind => {
  const { root, coordinator: c, advance } = fixture();
  const orphan = c.acquire(resource("orphan")), journal = path.join(root, orphan.resourceId + ".json");
  if (kind === "missing") unlinkSync(journal);
  if (kind === "mismatched") writeFileSync(journal, JSON.stringify({ ...orphan, operationId: "00000000-0000-4000-8000-000000000001" }));
  if (kind === "corrupt") writeFileSync(journal, "{");
  if (kind === "locked") writeFileSync(journal + ".lock", "");
  advance();
  const slot = path.join(root, `slot-${orphan.device}-${orphan.budgetSlot}.json`), evidence = readFileSync(slot, "utf8");
  for (let i = 0; i < 3; i++) expect(c.acquire(resource(`independent-${i}`)).state).toBe("reserved");
  expect(() => c.acquire(resource("extra"))).toThrow("device_backpressure");
  expect(() => c.acquire(resource("orphan"))).toThrow(kind === "locked" ? "admission_locked" : kind === "corrupt" ? "state_invalid" : "orphan_resource_slot");
  expect(readFileSync(slot, "utf8")).toBe(evidence);
});

it("retains a corrupt budget slot while unrelated resources use the remaining capacity", () => {
  const { root, coordinator: c } = fixture();
  const file = path.join(root, `slot-${resource().device}-0.json`);
  writeFileSync(file, "{");
  for (let i = 0; i < 3; i++) expect(c.acquire(resource(`valid-${i}`)).budgetSlot).toBe(i + 1);
  expect(() => c.acquire(resource("extra"))).toThrow("device_backpressure");
  expect(readFileSync(file, "utf8")).toBe("{");
});

it("a crashed process leaves active evidence fenced after restart and independent resources can proceed", async () => {
  const { spawn } = await import("node:child_process");
  const { root, coordinator } = fixture();
  const script = `import {ResourceCoordinator,coordinationToken} from ${JSON.stringify(new URL("../apps/agent/src/coordination.ts", import.meta.url).href)};
const c=new ResourceCoordinator(process.argv[1]);const resource=JSON.parse(process.argv[2]);const r=c.acquire(resource);c.begin(coordinationToken(r),resource);process.stdout.write(JSON.stringify(coordinationToken(r))+'\\n');setInterval(()=>{},10000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, JSON.stringify(resource())], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const token = await new Promise<any>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", data => { output += data; if (output.includes("\n")) resolve(JSON.parse(output)); });
    child.once("error", reject); child.once("exit", code => { if (code !== null) reject(new Error(`fixture exited ${code}: ${stderr}`)); });
  });
  child.kill("SIGKILL"); await new Promise<void>(resolve => child.once("exit", () => resolve()));
  const restarted = new ResourceCoordinator(root);
  expect(() => restarted.acquire(resource())).toThrow("active_or_uncertain_writer");
  expect(() => restarted.begin(token, resource())).toThrow("writer_not_reserved");
  expect(coordinator.acquire(resource("independent")).operationId).toBeTruthy();
});
