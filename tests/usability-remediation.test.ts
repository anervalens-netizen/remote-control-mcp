import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installDefaultToolOutputContracts, TOTAL_RESULT_MAX_BYTES } from "../apps/mcp-server/src/tool-contract-defaults.ts";
import { ResultRecoveryStore } from "../apps/mcp-server/src/result-recovery.ts";
import { operationContext, OperationObserver } from "../apps/mcp-server/src/operation-observer.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
it("delivers a real large PNG through the final SDK wrapper and retains exact original", async () => {
  const raw = Buffer.alloc(1920 * 1200 * 3);
  let seed = 123;
  for (let i=0; i<raw.length; i++) { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; raw[i] = seed >>> 24; }
  const png = await sharp(raw, {raw:{width:1920,height:1200,channels:3}}).png().toBuffer();
  expect(png.length).toBeGreaterThan(1024*1024);
  const server = new McpServer({name:"synthetic",version:"1"});
  installDefaultToolOutputContracts(server);
  const value = { image:{available:true,width:1920,height:1200}, snapshot:{width:1920,height:1200} };
  server.registerTool("synthetic_capture",{inputSchema:{}, outputSchema:z.object({image:z.record(z.string(),z.unknown()),snapshot:z.record(z.string(),z.unknown())})},
    async () => ({ content:[{type:"text" as const,text:JSON.stringify(value)},{type:"image" as const,data:png.toString("base64"),mimeType:"image/png"}],structuredContent:value }));
  const client=new Client({name:"fixture",version:"1"});
  const [a,b]=InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a),client.connect(b)]);
  closers.push(async()=>{await client.close();await server.close();});
  const result:any=await client.callTool({name:"synthetic_capture",arguments:{}});
  expect(result.isError).not.toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(TOTAL_RESULT_MAX_BYTES);
  const delivered=result.content.filter((c:any)=>c.type==="image");
  expect(delivered).toHaveLength(1);
  const info=await sharp(Buffer.from(delivered[0].data,"base64")).metadata();
  expect(info.width).toBeGreaterThanOrEqual(480);
  expect(result.structuredContent.imageDelivery[0]).toMatchObject({captured:true,delivered:true,transformed:true,original:"resultRecovery"});
  expect(result.structuredContent.snapshot).toEqual(value.snapshot);
  const chunks:Buffer[]=[]; let offset=0;
  do {
    const read:any=await client.callTool({name:"result_recover",arguments:{id:result.structuredContent.resultRecovery.id,offset}});
    chunks.push(Buffer.from(read.structuredContent.data,"base64"));offset=read.structuredContent.nextOffset;
    if(read.structuredContent.eof)break;
  } while(true);
  const original=JSON.parse(Buffer.concat(chunks).toString());
  expect(original.content.find((c:any)=>c.type==="image").data).toBe(png.toString("base64"));
},30000);

it("bounds retained payload bytes without making shed reservations replayable",()=>{
  const store=new ResultRecoveryStore(3,1,4096);
  const ids:string[]=[];
  for(let i=0;i<3;i++){const r=store.begin(); ids.push(r.id); store.finish(r.id,{data:"x".repeat(1800)});}
  expect(store.stats().retainedBytes).toBeLessThanOrEqual(4096);
  const shed:any=store.read(ids[0]!);
  expect(JSON.parse(Buffer.from(shed.data,"base64").toString())).toMatchObject({receiptUnavailable:true,noReplay:true});
  expect(()=>store.begin(ids[0])).toThrow(/already used/);
});

it.each(["fs_read","job_status","android_observe","android_command_status","batch_recover","pty_output","search_results","exec","fs_write"])("classifies failed %s without losing write uncertainty",async tool=>{
  const observer=new OperationObserver();
  const id=await observer.begin(tool,undefined);
  await observer.event(id!,{stage:"agent_dispatch",device:"fixture",identity:"owner"});
  await observer.finish(id!,{ok:false,kind:"http",agentCode:"ENOENT",status:404},false,true);
  expect(await observer.inspect(id!)).toMatchObject({state:!["exec","fs_write"].includes(tool)?"returned":"unknown",requestSucceeded:false,callerDisconnected:true,failure:{kind:"http",agentCode:"ENOENT",status:404}});
});

import Fastify from "fastify";
import { filesystemReadResponse } from "../apps/agent/src/filesystem-read-response.ts";
import { deliverImages } from "../apps/mcp-server/src/image-delivery.ts";

it.each([["ENOENT",404],["EACCES",403],["EISDIR",400]])("returns domain status for %s",async(code,status)=>{
  const app=Fastify();
  app.get("/read",async(_request,reply)=>filesystemReadResponse(async()=>{throw Object.assign(new Error("private path"),{code});},reply));
  const response=await app.inject({method:"GET",url:"/read"});
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({error:"filesystem_read_failed",code});
  await app.close();
});
it("marks a failed delivery explicitly and leaves the original metadata unchanged",async()=>{
  const original={image:{available:true}};
  const result=await deliverImages([{type:"image",data:"x".repeat(400000),mimeType:"image/png"}],original,250000);
  expect(result.content.filter(c=>c.type==="image")).toHaveLength(0);
  expect(result.structuredContent).toMatchObject({image:{available:false,captured:true,delivered:false},imageDelivery:[{delivered:false,reason:"image_delivery_failed"}]});
  expect(original.image.available).toBe(true);
});


it("remaps delivered image indices after a failed earlier preview", async () => {
  const result = await deliverImages([
    { type: "image", data: "x".repeat(400000), mimeType: "image/png" },
    { type: "image", data: "eA==", mimeType: "image/png" },
  ], { results: [{ imageIndex: 0 }, { imageIndex: 1 }] }, 250000);
  expect(result.structuredContent).toMatchObject({ results: [{ imageDelivered: false }, { imageIndex: 0, imageDelivered: true }] });
  expect((result.structuredContent as any).results[0]).not.toHaveProperty("imageIndex");
});
it("honors cancellation before image conversion", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await deliverImages([{ type: "image", data: "eA==", mimeType: "image/png" }], {}, 250000, controller.signal);
  expect(result.content.filter(c => c.type === "image")).toHaveLength(0);
});

it("reapplies the structured cap after image metadata and synchronizes the text", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  installDefaultToolOutputContracts(server);
  const value = { padding: "x".repeat(63 * 1024) };
  server.registerTool("synthetic_boundary", { inputSchema: {}, outputSchema: z.object({ padding: z.string() }) },
    async () => ({ content: Array.from({ length: 4 }, () => ({ type: "image" as const, data: "eA==", mimeType: "image/png;comment=" + "x".repeat(1000) })), structuredContent: value }));
  const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const result: any = await client.callTool({ name: "synthetic_boundary", arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(64 * 1024);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
});
it("does not advertise shed originals as recoverable", async () => {
  const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: "red" } }).png({ compressionLevel: 0 }).toBuffer();
  const result = await deliverImages([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], { resultRecovery: { payloadAvailable: false } }, 250000);
  expect(result.structuredContent.imageDelivery[0]).toMatchObject({ transformed: true, original: "unavailable" });
});


import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
it("does not record exec dispatch when capability probing fails", async () => {
  const app = Fastify(); let effects = 0;
  app.get("/v1/info", async () => ({ runtime: { capabilities: [] } }));
  app.post("/v1/exec", async () => { effects++; return {}; });
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  const observer = new OperationObserver(), id = await observer.begin("exec", undefined);
  const client = new AgentClient([{ name: "fixture", url }]);
  await expect(operationContext.run({ observer, traceId: id! }, () =>
    client.exec("fixture", { command: "must-not-run", execReceiptId: "00000000-0000-4000-8000-000000000001" }))).rejects.toThrow(/no exec dispatch/);
  await observer.finish(id!, undefined, false, false);
  const record = await observer.inspect(id!);
  expect(record).toMatchObject({ state: "returned" });
  expect(record?.events.some(event => event.stage === "agent_dispatch")).toBe(false);
  expect(effects).toBe(0);
});
