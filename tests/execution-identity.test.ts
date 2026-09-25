import { describe, expect, it } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { executionLabel, resolveExecutionContext } from "../apps/mcp-server/src/execution-identity.ts";

function client(configured = { system: true, user: true, desktop: true }) {
  return { configuredContexts: () => configured } as unknown as AgentClient;
}

describe("execution identity v2", () => {
  it("keeps core auto execution on root while owner-aware tools can default owner", () => {
    expect(resolveExecutionContext(client(), "pc", { identity: "auto", elevation: "auto" }, "system")).toBe("system");
    expect(resolveExecutionContext(client(), "pc", { identity: "auto", elevation: "auto" }, "user")).toBe("user");
  });

  it("maps explicit owner/root/interactive identities without fallback", () => {
    expect(resolveExecutionContext(client(), "pc", { identity: "root" }, "user")).toBe("system");
    expect(resolveExecutionContext(client(), "pc", { identity: "owner" }, "system")).toBe("user");
    expect(resolveExecutionContext(client(), "pc", { identity: "interactive" }, "system")).toBe("desktop");
    expect(executionLabel("desktop")).toBe("interactive");
  });

  it("supports elevation routing explicitly", () => {
    expect(resolveExecutionContext(client(), "pc", { identity: "auto", elevation: "root" }, "user")).toBe("system");
    expect(resolveExecutionContext(client(), "pc", { identity: "auto", elevation: "never" }, "system")).toBe("user");
  });

  it("lets canonical identity override legacy context while still rejecting elevation conflicts and unavailable identities", () => {
    expect(resolveExecutionContext(client(), "pc", { context: "user", identity: "root" }, "system")).toBe("system");
    expect(resolveExecutionContext(client(), "pc", { context: "system", identity: "owner" }, "system")).toBe("user");
    expect(() => resolveExecutionContext(client(), "pc", { identity: "root", elevation: "never" }, "system")).toThrow("Conflicting elevation=never");
    expect(() => resolveExecutionContext(client(), "pc", { context: "system", elevation: "never" }, "system")).toThrow("Conflicting elevation=never");
    expect(() => resolveExecutionContext(client(), "pc", { context: "user", elevation: "root" }, "user")).toThrow("Conflicting elevation=root and context=user");
    expect(() => resolveExecutionContext(client({ system: true, user: false, desktop: false }), "pc", { identity: "owner" }, "system")).toThrow("owner identity is not configured");
    expect(() => resolveExecutionContext(client({ system: true, user: true, desktop: false }), "pc", { identity: "interactive" }, "system")).toThrow("interactive identity is not configured");
  });
});
