import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerDesktopTools } from "../apps/mcp-server/src/desktop-tools.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function harness() {
  let launchInput: unknown;
  let batchInput: unknown;
  let batchSignal: AbortSignal | undefined;
  const session = {
    agentPid: 111,
    agentSessionId: 2,
    activeConsoleSessionId: 2,
    interactiveSession: true,
    inputDesktop: { accessible: true, name: "Default", error: null },
    consentProcesses: [],
    secureDesktopLikely: false,
    uacPromptPossible: false,
    captureMayMissSecureDesktop: false,
    captureBoundaryNote: "Windows UAC can switch to Secure Desktop.",
  };
  const fake = {
    desktopSessionStatus: async () => session,
    desktopBatch: async (_device: string, input: unknown, signal?: AbortSignal) => {
      batchInput = input; batchSignal = signal;
      return { ok: false, executed: 2, skipped: 1, results: [
        { index: 0, kind: "screenshot", ok: true, result: { data: "cG5n", mimeType: "image/png", bytes: 3, width: 1, height: 1 } },
        { index: 1, kind: "focus", ok: false, error: "window not found" },
      ] };
    },
    desktopLaunch: async (_device: string, input: unknown) => {
      launchInput = input;
      return {
        ok: true,
        launchAccepted: true,
        verified: true,
        verificationStatus: "window",
        target: "notepad.exe",
        pid: 222,
        processVerified: true,
        agentSessionId: 2,
        activeConsoleSessionId: 2,
        processSessionId: 2,
        interactiveSessionMatched: true,
        windowVerified: true,
        window: { pid: 222, process: "notepad", title: "Untitled", handle: 1234, visible: true, rect: { x: 0, y: 0, width: 800, height: 600 } },
        waitForWindowMs: 500,
        requireWindow: true,
        uac: { secureDesktopPromptPossible: true, secureDesktopLikely: false, uacPromptPossible: false, captureMayMissSecureDesktop: false, inputDesktop: session.inputDesktop, consentProcesses: [], note: session.captureBoundaryNote },
      };
    },
  } as unknown as AgentClient;

  const server = new McpServer({ name: "test", version: "1" });
  registerDesktopTools(server, fake);
  const client = new Client({ name: "client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return { client, session, getLaunchInput: () => launchInput, getBatchInput: () => batchInput, getBatchSignal: () => batchSignal };
}

describe("desktop session/UAC observability", () => {
  it("forwards batches, reports partial failure, and returns screenshots as images", async () => {
    const { client, getBatchInput, getBatchSignal } = await harness();
    const actions = [{ kind: "screenshot", scale: 0.5 }, { kind: "focus", title: "missing" }, { kind: "wait", ms: 1 }];
    const response = await client.callTool({ name: "desktop_batch", arguments: { device: "pc", actions } });
    expect(getBatchSignal()).toBeInstanceOf(AbortSignal);
    expect(response.isError).toBe(true); expect(getBatchInput()).toEqual({ actions, stopOnError: undefined });
    const blocks = response.content as Array<{ type: string; text?: string; data?: string }>;
    expect(blocks[1]).toMatchObject({ type: "image", data: "cG5n" });
    expect(blocks[0]?.text).not.toContain("cG5n");
    expect(JSON.parse(blocks[0]!.text!)).toMatchObject({ skipped: 1, results: [{ result: { imageIndex: 0 } }, { ok: false }] });
  });

  it("snapshots native clipboard formats before temporary keyboard paste", () => {
    const desktop = readFileSync("apps/agent/src/desktop.ts", "utf8");
    for (const marker of [
      "Copy-RcmcpClipboardData",
      "GetFormats($false)",
      "System.IO.MemoryStream",
      "System.Drawing.Image",
      "SetDataObject($backup,$true,1,0)",
      "clipboardFormatsRestored",
      "clipboardRestored",
      "clipboardRestoreAttempts",
      "clipboardRestoreError",
      "clipboardSnapshotCaptured",
      "for($attempt=1;$attempt -le 6;$attempt++)",
    ]) expect(desktop).toContain(marker);
    expect(desktop).not.toContain("SetDataObject($old,$true)");
    expect(desktop).toContain("clipboard snapshot missing format data:");
    expect(desktop).toContain("clipboard snapshot missing copied format:");
    expect(desktop).toContain("clipboard snapshot incomplete:");
    const snapshot = desktop.slice(
      desktop.indexOf("function Copy-RcmcpClipboardData"),
      desktop.indexOf("if($i.action -eq 'type')"),
    );
    expect(snapshot).not.toContain("catch {}");
    expect(desktop).not.toContain("} catch {}\\n  }\\n  [pscustomobject]@{ok=$true;chars=");
  });

  it("keeps explicit Secure Desktop and session/window verification signals in the implementation", () => {
    const desktop = readFileSync("apps/agent/src/desktop.ts", "utf8");
    const routes = readFileSync("apps/agent/src/desktop-routes.ts", "utf8");
    const runtime = readFileSync("apps/agent/src/runtime.ts", "utf8");

    for (const marker of [
      "WTSGetActiveConsoleSessionId",
      "OpenInputDesktop",
      "GetUserObjectInformation",
      "Get-Process -Name consent",
      "interactiveSessionMatched",
      "windowVerified",
      "secureDesktopPromptPossible",
      "noninteractive_agent_session",
    ]) expect(desktop).toContain(marker);
    expect(routes).toContain('/v1/desktop/session');
    expect(routes).toContain("waitForWindowMs");
    expect(routes).toContain("requireWindow");
    expect(runtime).toContain('"desktop-session"');
  });

  it("advertises session status as structured read-only output and forwards strict launch verification options", async () => {
    const { client, session, getLaunchInput } = await harness();
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));

    expect(tools.get("desktop_session_status")?.outputSchema).toBeTruthy();
    expect(tools.get("desktop_session_status")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.get("desktop_launch")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

    const status = await client.callTool({ name: "desktop_session_status", arguments: { device: "pc" } });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toEqual(session);

    const launched = await client.callTool({
      name: "desktop_launch",
      arguments: { device: "pc", target: "notepad.exe", waitForWindowMs: 500, requireWindow: true },
    });
    expect(launched.isError).not.toBe(true);
    expect(getLaunchInput()).toEqual({ target: "notepad.exe", waitForWindowMs: 500, requireWindow: true });
    const content = launched.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(content[0]?.text ?? "null")).toMatchObject({
      verified: true,
      interactiveSessionMatched: true,
      windowVerified: true,
      uac: { secureDesktopPromptPossible: true },
    });
  });
});
