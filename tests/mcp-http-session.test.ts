import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentClient } from '../apps/mcp-server/src/agent-client.ts';
import { createMcpHttpServer } from '../apps/mcp-server/src/http-server.ts';
import { registerDesktopRoutes } from '../apps/agent/src/desktop-routes.ts';
const closers: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close();});
async function harness(){
 const agent=Fastify();registerDesktopRoutes(agent);const agentUrl=await agent.listen({host:'127.0.0.1',port:0});
 closers.push(async()=>{agent.server.closeAllConnections();await agent.close();});
 const http=createMcpHttpServer(new AgentClient([{name:'pc',url:agentUrl,desktopUrl:agentUrl}]),{token:'test-only-token'});
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
 const address=http.address() as {port:number},url=new URL(`http://127.0.0.1:${address.port}/mcp`);
 closers.push(async()=>{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));});
 async function connect(){
  const client=new Client({name:'session-test',version:'1'}),transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer test-only-token'}}});
  await client.connect(transport);
  closers.push(async()=>{await transport.terminateSession();await client.close();});
  return {client,transport};
 }
 return {connect,url};
}
describe('production MCP HTTP sessions',()=>{
 it('cancels a long desktop sequence through the SDK and immediately releases the lane',async()=>{
  const {connect}=await harness(),{client,transport}=await connect();expect(transport.sessionId).toBeTruthy();
  const controller=new AbortController();
  const abandoned=client.callTool({name:'desktop_batch',arguments:{device:'pc',actions:[{kind:'wait',ms:10000},{kind:'wait',ms:10000}]}},undefined,{signal:controller.signal});
  void abandoned.catch(()=>{});await new Promise(r=>setTimeout(r,100));controller.abort();await expect(abandoned).rejects.toThrow();
  const next=await client.callTool({name:'desktop_batch',arguments:{device:'pc',actions:[{kind:'wait',ms:1}]}},undefined,{timeout:1500});expect(next.isError).not.toBe(true);
 },5000);
 it('isolates equal request IDs across clients and retains legacy stateless calls',async()=>{
  const {connect,url}=await harness(),a=await connect(),b=await connect();expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
  const ca=new AbortController();
  const first=a.client.callTool({name:'desktop_batch',arguments:{device:'pc',actions:[{kind:'wait',ms:10000}]}},undefined,{signal:ca.signal});void first.catch(()=>{});
  const second=b.client.callTool({name:'desktop_batch',arguments:{device:'pc',actions:[{kind:'wait',ms:100}]}},undefined,{timeout:1500});
  await new Promise(r=>setTimeout(r,100));ca.abort();await expect(first).rejects.toThrow();expect((await second).isError).not.toBe(true);
  const legacy=await fetch(url,{method:'POST',headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:42,method:'tools/list'})});
  expect(legacy.status).toBe(200);expect(await legacy.text()).toContain('desktop_batch');
  const forbidden=await fetch(url,{method:'DELETE',headers:{'mcp-session-id':a.transport.sessionId!}});expect(forbidden.status).toBe(401);
  const unknown=await fetch(url,{method:'DELETE',headers:{Authorization:'Bearer test-only-token','mcp-session-id':'unknown'}});expect(unknown.status).toBe(404);
 },5000);
});
