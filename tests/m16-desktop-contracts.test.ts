import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { desktopMouseSchema, desktopKeyboardSchema, desktopFocusSchema, desktopBatchSchema } from "../packages/protocol/src/desktop.ts";
import { browserSessionSchema } from "../packages/protocol/src/browser.ts";
import { registerDesktopRoutes } from "../apps/agent/src/desktop-routes.ts";
import { registerDesktopTools } from "../apps/mcp-server/src/desktop-tools.ts";
import { registerBrowserTools } from "../apps/mcp-server/src/browser-tools.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { desktopMouse } from "../apps/agent/src/desktop.ts";

describe("M16 desktop and browser intent validation", () => {
  it("rejects side effects disguised as a cursor query and validates action-specific inputs", () => {
    expect(desktopMouseSchema.safeParse({action:"position",x:0,y:0}).success).toBe(false);
    expect(desktopMouseSchema.safeParse({action:"move",x:0}).success).toBe(false);
    expect(desktopMouseSchema.parse({action:"move",x:0,y:-50})).toMatchObject({x:0,y:-50});
    expect(desktopMouseSchema.parse({action:"click",button:"right"}).action).toBe("click");
    expect(desktopMouseSchema.parse({action:"scroll",x:1,y:2,delta:-120}).delta).toBe(-120);
    expect(desktopKeyboardSchema.safeParse({action:"type"}).success).toBe(false);
    expect(desktopKeyboardSchema.safeParse({action:"press",text:"a"}).success).toBe(false);
    expect(desktopKeyboardSchema.safeParse({action:"hotkey",keys:[]}).success).toBe(false);
    expect(desktopKeyboardSchema.parse({action:"type",text:""}).text).toBe("");
    expect(desktopFocusSchema.safeParse({}).success).toBe(false);
    expect(desktopBatchSchema.safeParse({actions:[{kind:"mouse",action:"position",x:0,y:0}]}).success).toBe(false);
    expect(browserSessionSchema.safeParse({action:"connect",engine:"firefox",endpoint:"http://fixture",protocol:"cdp"}).success).toBe(false);
    expect(browserSessionSchema.safeParse({action:"connect",engine:"firefox",endpoint:"ws://fixture",protocol:"playwright"}).success).toBe(true);
  });
  it("validates direct calls and HTTP before any native desktop effects", async () => {
    await expect(desktopMouse({action:"position",x:0,y:0})).rejects.toThrow(/read-only/);
    const app=Fastify(); registerDesktopRoutes(app);
    try {
      for (const [route,body] of [["mouse",{action:"position",x:0,y:0}],["keyboard",{action:"type"}],["focus",{}]] as const) {
        const res=await app.inject({method:"POST",url:"/v1/desktop/"+route,payload:body});
        expect(res.statusCode).toBe(400);
      }
    } finally {await app.close();}
  });
  it("rejects contradictory MCP inputs before dispatch", async () => {
    let dispatched=0;
    const agent=new AgentClient([{name:"fixture",url:"http://127.0.0.1:1",desktopUrl:"http://127.0.0.1:1"}]);
    agent.requestRoute=async () => {dispatched++; throw new Error("must not dispatch");};
    const server=new McpServer({name:"m16-input-test",version:"1"});
    registerDesktopTools(server,agent); registerBrowserTools(server,agent);
    const client=new Client({name:"test",version:"1"}); const [st,ct]=InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st),client.connect(ct)]);
    try {
      for (const [name,input] of [["desktop_mouse",{action:"position",x:0,y:0}],["desktop_keyboard",{action:"hotkey"}],["desktop_focus",{}],["browser_session",{action:"connect",engine:"firefox",endpoint:"http://fixture",protocol:"cdp"}]] as const) {
        const result=await client.callTool({name,arguments:{device:"fixture",...input}});
        expect(result.isError).toBe(true);
      }
      expect(dispatched).toBe(0);
    } finally {await client.close(); await server.close();}
  });
});
