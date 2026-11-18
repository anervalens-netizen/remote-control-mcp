import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { capabilityReport } from "../apps/mcp-server/src/capability-tools.ts";
import { endpointVersionEvidence, readVersionInventory } from "../apps/mcp-server/src/version-evidence.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);

async function inventory(contents: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc26-version-evidence-"));
  roots.push(root);
  const file = path.join(root, "version-claims.json");
  await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  vi.stubEnv("RCMCP_VERSION_EVIDENCE_FILE", file);
  return file;
}

function fixture() {
  const agent = new AgentClient([{ name: "synthetic-primary", aliases: ["primary-alias"],
    url: "http://127.0.0.1:1", userUrl: "http://127.0.0.1:2" }]);
  const probe = vi.spyOn(agent, "info").mockImplementation(async (_device, context) => ({
    hostname: "synthetic", platform: "linux",
    runtime: { ready: true, sha: context === "system" ? a : b,
      releaseIdentity: { sha: context === "system" ? a : b, shaBinding: "pinned_manifest",
        release: { validation: "pinned_integrity" } } },
  }));
  return { agent, probe };
}

it("shows observed runtime SHA with missing desired/installed/startup declarations kept unknown", async () => {
  const { agent, probe } = fixture();
  const row = (await capabilityReport(agent, ["primary-alias"], 1))[0]!;
  expect(row.device).toBe("synthetic-primary");
  expect(row.versions).toMatchObject({
    root: { desired: { sha: null }, installed: { sha: null }, startupTarget: { sha: null },
      running: { sha: a, provenance: "agent_runtime", validation: "pinned_integrity" },
      comparisons: { desiredToRunning: "unknown", startupTargetToRunning: "unknown" },
      inventory: { state: "unconfigured", role: "unknown" } },
  });
  expect(probe).toHaveBeenCalledTimes(2);
});

it("separates operator claims from observed root/owner runtimes and exposes mismatches without overstating proof", async () => {
  await inventory({ version: 1, devices: {
    "synthetic-primary": {
      role: "primary",
      root: { recordedAt: "2026-11-18T00:00:00.000Z",
        desiredSha: a, installedSha: b, startupTargetSha: c },
      owner: { recordedAt: "2026-11-18T00:00:00.000Z",
        desiredSha: b, installedSha: b, startupTargetSha: b },
    },
  } });
  const { agent } = fixture();
  const row = (await capabilityReport(agent, ["primary-alias"]))[0]!;
  expect(row.versions).toMatchObject({
    root: {
      desired: { sha: a, provenance: "operator_declaration", independentlyVerified: false },
      installed: { sha: b, independentlyVerified: false },
      startupTarget: { sha: c },
      running: { sha: a, locallyPinnedAtStartup: true, independentlyVerified: false, upstreamVerified: false },
      comparisons: { desiredToRunning: "match", installedToRunning: "mismatch", startupTargetToRunning: "mismatch" },
      inventory: { state: "valid", role: "primary" },
    },
    owner: {
      desired: { sha: b }, running: { sha: b },
      comparisons: { desiredToRunning: "match", installedToRunning: "match", startupTargetToRunning: "match" },
    },
  });
  expect(JSON.stringify(row.versions)).not.toContain("127.0.0.1");
});

it("fails closed for malformed, oversized, and symlink inventory sources without reflecting their contents", async () => {
  const file = await inventory("PRIVATE_FIXTURE_VALUE");
  const malformed = readVersionInventory();
  expect(malformed).toEqual({ state: "invalid", value: null });
  const result = endpointVersionEvidence({ ok: false, error: "PRIVATE_FIXTURE_VALUE" }, malformed, "fixture", "root");
  expect(result.running.sha).toBeNull();
  expect(result.comparisons.desiredToRunning).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE_VALUE");

  await writeFile(file, "x".repeat(65537));
  expect(readVersionInventory().state).toBe("invalid");

  const link = file + "-link";
  await symlink(file, link);
  vi.stubEnv("RCMCP_VERSION_EVIDENCE_FILE", link);
  expect(readVersionInventory().state).toBe("invalid");
});

it("does not manufacture runtime success when a peer is unreachable or its SHA is unrecognized", async () => {
  await inventory({ version: 1, devices: { fixture: { role: "retired",
    root: { recordedAt: "2026-11-18T00:00:00.000Z", desiredSha: a } } } });
  const read = readVersionInventory();
  const unavailable = endpointVersionEvidence({ ok: false, error: "offline" }, read, "fixture", "root");
  expect(unavailable).toMatchObject({
    running: { sha: null, independentlyVerified: false },
    comparisons: { desiredToRunning: "unknown" },
    inventory: { expectedAvailabilityHint: "retired_should_not_be_continuous" },
  });
  const invalidSha = endpointVersionEvidence({ ok: true, info: {
    runtime: { sha: "invalid-value", releaseIdentity: { release: { validation: "rejected" } } },
  } }, read, "fixture", "root");
  expect(invalidSha.running).toMatchObject({ sha: null, validation: "rejected", independentlyVerified: false });
  expect(invalidSha.comparisons.desiredToRunning).toBe("unknown");
  const unbound = endpointVersionEvidence({ ok: true, info: { runtime: {
    sha: a, releaseIdentity: { sha: b, shaBinding: "pinned_manifest",
      release: { validation: "pinned_integrity" } },
  } } }, read, "fixture", "root");
  expect(unbound.running.locallyPinnedAtStartup).toBe(false);
  expect(unbound.running.independentlyVerified).toBe(false);

});
