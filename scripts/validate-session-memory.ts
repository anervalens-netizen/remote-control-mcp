import assert from "node:assert/strict";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";

const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
assert(gc, "Run with node --expose-gc scripts/validate-session-memory.ts");
const http = createMcpHttpServer(new AgentClient([]), { token: "isolated-memory-validation", sessionIdleMs: 60_000 });
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(http.address() as {port:number}).port}`;
const ids: string[]=[];
async function initialize() {
  const response=await fetch(base+"/mcp",{method:"POST",headers:{authorization:"Bearer isolated-memory-validation","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"m16-memory",version:"1"}}})});
  assert.equal(response.status,200); await response.text(); const id=response.headers.get("mcp-session-id");assert(id);ids.push(id);
}
async function snapshot(){await new Promise(resolve=>setTimeout(resolve,50));gc!();return await(await fetch(base+"/health")).json() as any;}
try {
  await initialize(); const before=await snapshot();
  for(let i=0;i<100;i++)await initialize();
  const retained=await snapshot();
  assert.equal(retained.sessions.registered,101);assert.equal(retained.sessions.toolRegistryBuilds,1);
  const addedHeap=retained.memory.heapUsedBytes-before.memory.heapUsedBytes;
  assert(addedHeap<100*256*1024,`Session retained heap exceeds budget: ${addedHeap} bytes / 100 sessions`);
  for(const id of ids.splice(0)){
    const response=await fetch(base+"/mcp",{method:"DELETE",headers:{authorization:"Bearer isolated-memory-validation","mcp-session-id":id}});assert.equal(response.status,200);await response.text();
  }
  const deleted=await snapshot();assert.equal(deleted.sessions.registered,0);
  await initialize();
  const listed=await fetch(base+"/mcp",{method:"POST",headers:{authorization:"Bearer isolated-memory-validation","mcp-session-id":ids[0]!,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})});
  assert.equal(listed.status,200);assert((await listed.text()).includes('job_start'));
  console.log(JSON.stringify({isolated:true,sessionsCreated:102,toolRegistryBuilds:retained.sessions.toolRegistryBuilds,before:before.memory,retained:retained.memory,afterDelete:deleted.memory,addedHeapBytes:addedHeap,bytesPerAdditionalSession:Math.round(addedHeap/100),budgetPerSessionBytes:256*1024,postDeleteReuse:true},null,2));
} finally {
  for(const id of ids)await fetch(base+"/mcp",{method:"DELETE",headers:{authorization:"Bearer isolated-memory-validation","mcp-session-id":id}}).then(r=>r.text()).catch(()=>undefined);
  http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));
}
