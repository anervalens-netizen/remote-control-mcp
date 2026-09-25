import { describe, expect, it } from "vitest";
import { runtimeStatus } from "../apps/agent/src/runtime.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { capabilityReport } from "../apps/mcp-server/src/capability-tools.ts";

describe("capability handshake", () => {
  it("reports privilege/elevation/interactive identity details on the local runtime", () => {
    const runtime = runtimeStatus();
    expect(["root", "system", "admin", "owner", "user"]).toContain(runtime.privilege);
    expect(typeof runtime.elevationAvailable).toBe("boolean");
    expect(typeof runtime.interactiveSessionAvailable).toBe("boolean");
    expect(runtime.checks).toHaveProperty("identity.privilege");
    expect(runtime.checks).toHaveProperty("identity.elevationAvailable");
    expect(runtime.capabilities).toContain("exec");
  });

  it("returns per-endpoint partial results instead of discovering missing capabilities by failure later", async () => {
    const fake = {
      devices: [{ name: "pc", url: "system", userUrl: "owner", desktopUrl: "desktop" }],
      configuredContexts: () => ({ system: true, user: true, desktop: true }),
      info: async (_device: string, context: string) => {
        if (context === "desktop") throw new Error("desktop endpoint unavailable");
        return { runtime: { context, sha: "abc", capabilities: context === "system" ? ["exec", "filesystem", "elevation"] : ["exec", "filesystem"] } };
      },
    } as unknown as AgentClient;
    const [report] = await capabilityReport(fake);
    expect(report?.configured).toEqual({ system: true, user: true, desktop: true });
    expect(report?.endpoints.system).toMatchObject({ ok: true });
    expect(report?.endpoints.user).toMatchObject({ ok: true });
    expect(report?.endpoints.desktop).toEqual({ ok: false, error: "desktop endpoint unavailable" });
  });
});
