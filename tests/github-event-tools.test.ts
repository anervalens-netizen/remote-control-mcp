import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it, vi } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerGithubEventTools } from "../apps/mcp-server/src/github-event-tools.ts";
import { classifyToolEffect } from "../apps/mcp-server/src/tool-effects.ts";
const pr="https://github.com/example/project/pull/123";
const receipt=(stdout:string,code=0)=>({code,stdout,stderr:"",timedOut:false,signal:null,stdoutTruncated:false});
it("registers native gateway tools, binds owner identity and preserves timeout semantics",async()=>{
  const exec=vi.fn().mockResolvedValueOnce(receipt('{"healthy":true,"cursor":4}')).mockResolvedValueOnce(receipt('[]',8)).mockResolvedValueOnce(receipt('{"manual_tracking":true}'));
  const agent={configuredContexts:()=>({user:true,system:true}),exec} as unknown as AgentClient;
  const server=new McpServer({name:"gateway-fixture",version:"1"});
  const client=new Client({name:"fixture",version:"1"});
  registerGithubEventTools(server,agent);
  const [a,b]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    const catalog=await client.listTools();
    expect(catalog.tools).toHaveLength(5);
    const status=await client.callTool({name:"github_event_status",arguments:{device:"fixture"}});
    expect(status.structuredContent).toEqual({device:"fixture",timedOut:false,data:{healthy:true,cursor:4}});
    expect(exec.mock.calls[0]![2]).toBe("user");
    expect(exec.mock.calls[0]![1].command).toBe("\"$HOME/.local/bin/github-event-gateway\" 'status'");
    const timeout=await client.callTool({name:"github_pr_wait",arguments:{device:"fixture",pr,after:4,timeoutSeconds:1}});
    expect(timeout.structuredContent).toEqual({device:"fixture",timedOut:true,data:[]});
    const invalid=await client.callTool({name:"github_pr_snapshot",arguments:{device:"fixture",pr:pr+";echo bad"}});
    expect(invalid.isError).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    const tracking=await client.callTool({name:"github_pr_track",arguments:{device:"fixture",pr}});
    expect(tracking.isError).not.toBe(true);
    expect(classifyToolEffect("github_pr_wait")).toBe("read");
    expect(classifyToolEffect("github_pr_track")).toBe("effectful");
  } finally {await client.close();await server.close();}
});
it("fails closed on truncation, bad JSON and missing owner endpoint",async()=>{
  const exec=vi.fn().mockResolvedValueOnce({...receipt("{}"),stdoutTruncated:true}).mockResolvedValueOnce(receipt("not JSON"));
  const configuredContexts=vi.fn().mockReturnValue({user:true,system:true});
  const server=new McpServer({name:"gateway-fixture",version:"1"});
  const client=new Client({name:"fixture",version:"1"});
  registerGithubEventTools(server,{configuredContexts,exec} as unknown as AgentClient);
  const [a,b]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    for(let i=0;i<2;i++)expect((await client.callTool({name:"github_event_status",arguments:{device:"fixture"}})).isError).toBe(true);
    configuredContexts.mockReturnValue({user:false,system:true});
    expect((await client.callTool({name:"github_event_status",arguments:{device:"fixture"}})).isError).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  } finally {await client.close();await server.close();}
});

