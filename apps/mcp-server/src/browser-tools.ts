import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { browserSessionSchema,browserActionSchema,browserExecutionSchema,browserActionResultSchema,browserExecutionResultSchema } from "../../../packages/protocol/src/browser.ts";
const target={device:z.string().min(1),context:z.enum(["user","system"]).optional()};
const text=(value:unknown)=>({type:"text" as const,text:JSON.stringify(value)});
const legacyBrowserReceiptSchema=browserActionResultSchema.pick({sessionId:true,ok:true,executed:true,results:true,pages:true});
function normalizeBrowserReceipt(value:unknown){
  const modern=browserActionResultSchema.safeParse(value);
  if(modern.success)return modern.data;
  // Upgrade a known legacy response after effects, never discard its evidence
  // because an older/rolled-back agent lacks the additive receipt fields.
  if(value&&typeof value==="object"&&"executionId" in value)throw modern.error;
  const legacy=legacyBrowserReceiptSchema.parse(value);
  return browserActionResultSchema.parse({...legacy,executionId:randomUUID(),
    status:legacy.ok?"completed":"failed",activeStepIndex:null,outcome:"settled",
    receiptScope:"legacy-response-only"});
}
export function registerBrowserTools(server:McpServer,client:AgentClient){
  server.registerTool("browser_session",{
    description:"Start, connect, list, inspect or close persistent browser automation sessions. Defaults to owner context and headless Chromium, auto-detecting installed Chrome/Edge. Select engine/channel/executablePath, userDataDir and native launch/contextOptions freely. Connect via CDP or Playwright endpoint. Closing an attached session disconnects; closing an owned session closes its browser. Sessions are agent-local; reuse returned context/sessionId/pageId.",
    inputSchema:browserSessionSchema.safeExtend(target),
  },async({device,context="user",...input},extra)=>{
    const parsed=browserSessionSchema.parse(input);
    const result=await client.requestRoute(device,"/v1/browser/session",parsed,context,{signal:extra.signal,timeoutMs:parsed.timeoutMs===0?0:(parsed.timeoutMs??30000)+5000}) as object;
    return {content:[text({context,...result})]};
  });
  server.registerTool("browser_execution",{
    description:"Read retained browser execution receipts after timeout or caller disconnect; omit executionId for a compact index, then specify an ID for retained step details. Agent-local, at most 128 receipts for 15 minutes and 32 KiB per receipt; large history payloads are explicitly omitted, full immediate results are unchanged; absence means unavailable, never safe to replay. An in-flight step remains outcome_unknown until it settles.",
    inputSchema:browserExecutionSchema.extend(target),outputSchema:browserExecutionResultSchema.extend({context:target.context}),
  },async({device,context="user",...input})=>{
    const result=browserExecutionResultSchema.parse(await client.requestRoute(device,"/v1/browser/executions",input,context));
    return {content:[text({...result,context})],structuredContent:{...result,context}};
  });
  server.registerTool("browser_action",{
    description:"Execute ordered Playwright actions in one browser session. Use pages/newPage to select pageId; locator accepts selector, role+name, label, text, testId, nth and iframe selector. Actions auto-wait; no implicit retries of completed effects. snapshot returns AI accessibility tree; maxChars=-1 reads all. evaluate runs page JavaScript, cdp sends unrestricted native CDP methods, upload uses device paths. Partial failures retain completed results. Timeout/cancellation never replays actions; session status reports work still pending. Close session to stop unresponsive work.",
    inputSchema:browserActionSchema.safeExtend(target),outputSchema:browserActionResultSchema.extend({context:target.context}),
  },async({device,context="user",...input},extra)=>{
    const parsed=browserActionSchema.parse(input);
    const result=normalizeBrowserReceipt(await client.requestRoute(device,"/v1/browser/actions",parsed,context,{signal:extra.signal,timeoutMs:parsed.timeoutMs===0?0:(parsed.timeoutMs??60000)+5000}));
    const images:Array<{type:"image";data:string;mimeType:string}>=[];
    const results=result.results.map((r:any)=>{
      if(r.action!=="screenshot"||!r.ok)return r;
      const {data,...meta}=r.result,imageIndex=images.length;images.push({type:"image",data,mimeType:meta.mimeType});return {...r,result:{...meta,imageIndex}};
    });
    const receipt=browserActionResultSchema.parse({...result,results});
    return {isError:!result.ok,content:[text({...receipt,context}),...images],structuredContent:{...receipt,context}};
  });
}
