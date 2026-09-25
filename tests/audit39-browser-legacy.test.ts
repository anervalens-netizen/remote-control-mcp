import { expect,it } from "vitest";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import type {AgentClient} from "../apps/mcp-server/src/agent-client.ts";
import {registerBrowserTools} from "../apps/mcp-server/src/browser-tools.ts";
import {installDefaultToolOutputContracts} from "../apps/mcp-server/src/tool-contract-defaults.ts";

it.each([true,false])("retains legacy browser effects over actual SDK calls (ok=%s)",async ok=>{
 let effects=0;
 const agent={requestRoute:async()=>{effects++;return {sessionId:"legacy",ok,executed:1,
  results:[{index:0,action:"evaluate",ok,...(ok?{result:{value:1}}:{error:"already affected page"})}],pages:[]}}} as unknown as AgentClient;
 const server=new McpServer({name:"audit39-legacy",version:"1"});installDefaultToolOutputContracts(server);registerBrowserTools(server,agent);
 const client=new Client({name:"audit39-test",version:"1"});const [st,ct]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(st),client.connect(ct)]);
 try{
  const result=await client.callTool({name:"browser_action",arguments:{device:"fixture",sessionId:"legacy",actions:[{action:"evaluate",expression:"1"}]}});
  expect(result.structuredContent).toMatchObject({sessionId:"legacy",ok,executed:1,status:ok?"completed":"failed",outcome:"settled",receiptScope:"legacy-response-only"});
  expect((result.structuredContent as any).results[0]).toMatchObject({index:0,ok});
  expect(effects).toBe(1);expect(result.isError).toBe(!ok);
 }finally{await client.close();await server.close()}
});
