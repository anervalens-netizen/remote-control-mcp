import { describe, expect, it } from "vitest";
import { classifyToolEffect, isObservationFailureKind, observationFailureKind, toolEffectAnnotations, toolEffectContract } from "../apps/mcp-server/src/tool-effects.ts";

describe("explicit tool effect contracts", () => {
  it("covers observation families that previously drifted from their advertised hints", () => {
    for (const tool of ["desktop_observe", "desktop_windows", "desktop_screenshot", "fleet_status", "process_find", "repo_compare", "docker_summary", "browser_execution", "system_metrics", "secret_status", "job_input_hash"]) {
      expect(classifyToolEffect(tool)).toBe("read");
      expect(toolEffectAnnotations(tool)).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
    for (const tool of ["exec", "fs_write", "job_start", "search_start", "diagnostic_wait_report", "unknown_status", "toString"]) {
      expect(classifyToolEffect(tool, { action: "status", dryRun: true }, { readOnlyHint: true })).toBe("effectful");
      expect(toolEffectAnnotations(tool, { readOnlyHint: true }).readOnlyHint).toBe(false);
    }
  });

  it.each([
    ["fs_manage", { operation: "stat" }, { operation: "delete" }],
    ["service_manage", { action: "status" }, { action: "restart" }],
    ["resource_coordination", { action: "inspect" }, { action: "acquire" }],
    ["resource_coordination", { action: "inspect_recovery" }, { action: "reconcile" }],
    ["desktop_act", { mode: "status" }, { mode: "execute" }],
    ["desktop_uia", { action: "inspect" }, { action: "pattern", method: "GetValue" }],
    ["desktop_mouse", { action: "position" }, { action: "click" }],
    ["browser_session", { action: "status" }, { action: "connect" }],
    ["host_power", { dryRun: true }, { dryRun: "true" }],
    ["wake_on_lan", { dryRun: true }, { dryRun: false }],
  ])("classifies %s per parsed branch while advertising the whole tool conservatively", (tool, read, write) => {
    expect(toolEffectContract(tool)).toBe("mixed");
    expect(classifyToolEffect(tool, read, { readOnlyHint: false, destructiveHint: true })).toBe("read");
    expect(classifyToolEffect(tool, write)).toBe("effectful");
    expect(classifyToolEffect(tool)).toBe("effectful");
    expect(toolEffectAnnotations(tool, { readOnlyHint: true }).readOnlyHint).toBe(false);
  });

  it("handles the read-only UIA default but never guesses a package or browser action is safe", () => {
    expect(classifyToolEffect("desktop_uia", {})).toBe("read");
    expect(classifyToolEffect("desktop_uia", { action: "future_action" })).toBe("effectful");
    expect(classifyToolEffect("desktop_mouse", { action: "position", x: 20, y: 30 })).toBe("effectful");
    expect(classifyToolEffect("desktop_act", {})).toBe("effectful");
    expect(classifyToolEffect("resource_coordination", { action: "prepare_recovery" })).toBe("effectful");
    expect(classifyToolEffect("package_manage", { action: "list", manager: "winget" })).toBe("effectful");
    expect(classifyToolEffect("browser_action", { actions: [{ action: "evaluate", expression: "document.title" }] })).toBe("effectful");
  });

  it("requires every desktop batch action to be an audited observation", () => {
    const actions = [{ kind: "windows" }, { kind: "uia", action: "query" }, { kind: "mouse", action: "position" }, { kind: "screenshot" }];
    expect(classifyToolEffect("desktop_batch", { actions })).toBe("read");
    for (const action of [{ kind: "mouse", action: "click" }, { kind: "uia", action: "invoke" }, { kind: "future_action" }, null]) {
      expect(classifyToolEffect("desktop_batch", { actions: [...actions, action] })).toBe("effectful");
    }
    expect(classifyToolEffect("desktop_batch", { actions: [] })).toBe("effectful");
    expect(classifyToolEffect("desktop_batch", { actions: "windows" })).toBe("effectful");
    expect(toolEffectAnnotations("desktop_batch").readOnlyHint).toBe(false);
  });

  it("preserves explicit conservative metadata in both hints and classification", () => {
    const explicit = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    expect(toolEffectAnnotations("fs_read", explicit)).toEqual(explicit);
    expect(classifyToolEffect("fs_read", {}, explicit)).toBe("effectful");
    expect(classifyToolEffect("fs_read", {}, { destructiveHint: true })).toBe("effectful");
    expect(toolEffectAnnotations("fs_read", { destructiveHint: true }).readOnlyHint).toBe(false);
    expect(toolEffectAnnotations("fs_read", { idempotentHint: false, openWorldHint: false })).toMatchObject({ readOnlyHint: true, idempotentHint: false, openWorldHint: false });
  });
});

it("uses only bounded, versioned read-failure markers and preserves the full original category", () => {
  expect(observationFailureKind("domain_error")).toBe("observation_failed:v1:domain_error");
  expect(observationFailureKind("a".repeat(42))).toHaveLength(64);
  expect(observationFailureKind("a".repeat(43))).toBeUndefined();
  for (const value of [undefined, "", "private path", "domain:error"]) expect(observationFailureKind(value)).toBeUndefined();
  expect(isObservationFailureKind("observation_failed:v1:domain_error")).toBe(true);
  for (const value of ["domain_error", "observation_failed:v2:domain_error", "observation_failed:v1:", "observation_failed:v1:" + "a".repeat(43), null]) {
    expect(isObservationFailureKind(value)).toBe(false);
  }
});
