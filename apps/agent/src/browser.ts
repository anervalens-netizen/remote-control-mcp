import { retainBrowserReceipt } from "./browser-receipt-retention.ts";
import { createDeadline, NODE_TIMER_MAX_MS } from "../../../packages/protocol/src/deadline.ts";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type Locator, type CDPSession } from "playwright-core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { browserSessionSchema } from "../../../packages/protocol/src/browser.ts";
import type { BrowserSessionInput, BrowserActionInput, BrowserStep, BrowserActionResult } from "../../../packages/protocol/src/browser.ts";

type Session={id:string;browser:Browser|null;context?:BrowserContext;owned:boolean;persistent:boolean;engine:string;closed:boolean;pages:Map<string,Page>;tail:Promise<unknown>;pending:number;cdp:Map<Page|"browser",CDPSession>;createdAt:string};
const engines={chromium,firefox,webkit};
function errorText(e:unknown){return e instanceof Error?e.message:String(e)}
function abortError(signal:AbortSignal){return signal.reason instanceof Error?signal.reason:new Error("Browser request cancelled")}
function raceAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(abortError(signal));signal.addEventListener("abort",abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
    if(signal.aborted)abort();
  });
}
function deadline(timeout:number,signal?:AbortSignal){
  const controller=new AbortController();
  const parent=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const budget=createDeadline(timeout,parent);
  return {abort:(reason:Error)=>controller.abort(reason),signal:budget.signal!,clear:()=>budget.dispose()};
}
export class BrowserManager {
  private sessions=new Map<string,Session>();
  private receipts=new Map<string,{updatedAt:number;receipt:BrowserActionResult}>();
  private pruneReceipts(){
    for(const [id,entry] of this.receipts)if(Date.now()-entry.updatedAt>900000)this.receipts.delete(id);
    while(this.receipts.size>128)this.receipts.delete(this.receipts.keys().next().value!);
  }
  executions(input:{sessionId:string;executionId?:string}){
    this.pruneReceipts();
    const matches=[...this.receipts.values()].filter(({receipt})=>receipt.sessionId===input.sessionId&&(!input.executionId||receipt.executionId===input.executionId));
    const executions=matches.map(({receipt})=>input.executionId?structuredClone(receipt):({
      sessionId:receipt.sessionId,executionId:receipt.executionId,ok:receipt.ok,executed:receipt.executed,
      status:receipt.status,activeStepIndex:receipt.activeStepIndex,outcome:receipt.outcome,
      ...(receipt.interruption?{interruption:receipt.interruption}:{}),
      results:[],pages:[],receiptSummary:true,retentionTruncated:receipt.executed>0,
      retentionLimitBytes:32*1024,
    }));
    return {executions,retentionLimit:128,retentionMs:900000,indexOnly:!input.executionId};
  }
  private get(id:string){const s=this.sessions.get(id);if(!s||s.closed||(s.browser&&!s.browser.isConnected()))throw new Error("Browser session unavailable; list sessions and start/connect again");return s}
  private contexts(s:Session){return s.persistent?[s.context!]:s.browser!.contexts()}
  private async dispose(s:Session){if(s.persistent)await s.context!.close();else await s.browser!.close();s.closed=true;this.sessions.delete(s.id)}
  private pages(s:Session){
    const live=new Set(this.contexts(s).flatMap(c=>c.pages()));
    for(const [id,page]of s.pages)if(!live.has(page)||page.isClosed())s.pages.delete(id);
    for(const page of live)if(![...s.pages.values()].includes(page)){
      const id=randomUUID();s.pages.set(id,page);
      page.once("close",()=>{s.pages.delete(id);s.cdp.delete(page)});
    }
    return [...s.pages].map(([pageId,page])=>({pageId,url:page.url()}));
  }
  private describe(s:Session){return {sessionId:s.id,owned:s.owned,connected:!s.closed&&(s.browser?.isConnected()??true),engine:s.engine,createdAt:s.createdAt,pending:s.pending,pages:this.pages(s)}}
  private page(s:Session,id?:string){
    this.pages(s);
    if(id){const page=s.pages.get(id);if(!page)throw new Error("Page unavailable; use pages to select a current pageId");return page}
    if(s.pages.size!==1)throw new Error("Specify pageId when the session has zero or multiple pages; use pages or newPage");
    return [...s.pages.values()][0]!;
  }
  private locator(page:Page,input:BrowserStep["locator"]={}):Locator{
    const root=input.frame?page.frameLocator(input.frame):page;
    let locator:Locator;
    if(input.selector)locator=root.locator(input.selector);
    else if(input.role)locator=root.getByRole(input.role as Parameters<Page["getByRole"]>[0],{name:input.name,exact:input.exact});
    else if(input.label!==undefined)locator=root.getByLabel(input.label,{exact:input.exact});
    else if(input.text!==undefined)locator=root.getByText(input.text,{exact:input.exact});
    else if(input.testId!==undefined)locator=root.getByTestId(input.testId);
    else locator=root.locator("body");
    return input.nth===undefined?locator:locator.nth(input.nth);
  }
  async session(input:BrowserSessionInput,signal?:AbortSignal):Promise<unknown>{
    input=browserSessionSchema.parse(input);
    signal?.throwIfAborted();
    if(input.action==="list")return {sessions:[...this.sessions.values()].map(s=>this.describe(s))};
    if(input.action==="status")return this.describe(this.get(input.sessionId!));
    if(input.action==="close"){
      const s=this.sessions.get(input.sessionId!);if(!s)return {closed:true,alreadyClosed:true,sessionId:input.sessionId};
      await this.dispose(s);
      return {closed:true,sessionId:s.id,browserClosed:s.owned,disconnected:!s.owned};
    }
    const engine=engines[input.engine??"chromium"],timeout=Math.min(input.timeoutMs??30000,NODE_TIMER_MAX_MS);
    let browser:Browser|null|undefined,context:BrowserContext|undefined;
    try{
      if(input.action==="connect"){
        browser=input.protocol==="playwright"
          ?await engine.connect(input.endpoint!,{timeout})
          :await chromium.connectOverCDP(input.endpoint!,{timeout,noDefaults:true});
      }else{
        const options={...input.launchOptions,timeout,headless:input.headless??true,
          ...(input.channel?{channel:input.channel}:{}),...(input.executablePath?{executablePath:input.executablePath}:{}),...(input.args?{args:input.args}:{})};
        if(!options.channel&&!options.executablePath&&!input.engine&&!existsSync(chromium.executablePath())){
          const candidates=process.platform==="win32"?["C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]:["/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser"];
          const found=candidates.find(p=>existsSync(p));if(found)options.executablePath=found;
        }
        if(input.userDataDir){
          context=await engine.launchPersistentContext(input.userDataDir,{...input.contextOptions,...options});browser=context.browser();
        }else{
          browser=await engine.launch(options);context=await browser.newContext(input.contextOptions);
        }
        if(!context.pages().length)await context.newPage();
      }
      signal?.throwIfAborted();
      const s:Session={id:randomUUID(),browser:browser??null,context,owned:input.action==="start",persistent:input.action==="start"&&!!input.userDataDir,engine:browser?.browserType().name()??engine.name(),closed:false,pages:new Map(),tail:Promise.resolve(),pending:0,cdp:new Map(),createdAt:new Date().toISOString()};
      this.sessions.set(s.id,s);const closed=()=>{s.closed=true;this.sessions.delete(s.id)};browser?.once("disconnected",closed);if(s.persistent)context!.once("close",closed);
      return this.describe(s);
    }catch(e){if(input.userDataDir)await context?.close().catch(()=>{});await browser?.close().catch(()=>{});throw e}
  }
  async actions(input:BrowserActionInput,signal?:AbortSignal):Promise<unknown>{
    const s=this.get(input.sessionId),budget=deadline(input.timeoutMs??60000,signal);
    const receipt:BrowserActionResult={sessionId:s.id,executionId:randomUUID(),ok:false,executed:0,results:[],pages:this.pages(s),status:"queued",activeStepIndex:null,outcome:"not_started"};
    const retain=()=>{this.receipts.set(receipt.executionId,{updatedAt:Date.now(),receipt:retainBrowserReceipt(receipt)});this.pruneReceipts()};
    const interrupt=()=>{
      receipt.ok=false;receipt.status="interrupted";
      receipt.interruption??=signal?.aborted?"cancelled":"timeout";
      receipt.error??=errorText(abortError(budget.signal));
      receipt.outcome=receipt.activeStepIndex===null?(receipt.executed?"settled":"not_started"):"outcome_unknown";
      retain();
    };
    retain();s.pending++;
    const run=s.tail.then(async()=>{
      if(budget.signal.aborted){interrupt();return structuredClone(receipt)}
      receipt.status="running";retain();
      for(let index=0;index<input.actions.length;index++){
        if(budget.signal.aborted)break;
        const step=input.actions[index]!;
        receipt.activeStepIndex=index;receipt.outcome="outcome_unknown";retain();
        const stepDeadline=["evaluate","cdp","content","newPage","closePage"].includes(step.action)?createDeadline(step.timeoutMs??30000):undefined;
        const expire=()=>budget.abort(new Error("Browser action deadline exceeded; session may remain pending until the operation settles. No action is replayed."));
        stepDeadline?.signal?.addEventListener("abort",expire,{once:true});
        try{
          const result=await this.step(s,{...step,pageId:step.pageId??input.pageId},budget.signal);
          receipt.results.push({index,action:step.action,ok:true,result});
        }catch(e){receipt.results.push({index,action:step.action,ok:false,error:errorText(e)})}
        finally{stepDeadline?.signal?.removeEventListener("abort",expire);stepDeadline?.dispose()}
        receipt.executed=receipt.results.length;receipt.activeStepIndex=null;receipt.outcome="settled";retain();
        if(budget.signal.aborted||(!receipt.results.at(-1)!.ok&&input.stopOnError!==false))break;
      }
      if(budget.signal.aborted)interrupt();
      else {receipt.ok=receipt.results.every(r=>r.ok);receipt.status=receipt.ok?"completed":"failed"}
      try{receipt.pages=this.pages(s)}catch{/* Session may have been closed during the action. */}
      retain();return structuredClone(receipt);
    });
    s.tail=run.then(()=>undefined,()=>undefined).finally(()=>{s.pending--;budget.clear()});
    try{return await raceAbort(run,budget.signal)}
    catch(error){if(!budget.signal.aborted)throw error;interrupt();return structuredClone(receipt)}
    finally{if(!budget.signal.aborted)budget.clear()}
  }
  private async step(s:Session,input:BrowserStep,signal:AbortSignal):Promise<unknown>{
    signal.throwIfAborted();
    if(input.action==="pages")return this.pages(s);
    if(input.action==="newPage"){
      const context=s.context??s.browser!.contexts()[0]??await s.browser!.newContext();
      const page=await context.newPage();if(input.url)await page.goto(input.url,{timeout:Math.min(input.timeoutMs??30000,NODE_TIMER_MAX_MS),waitUntil:input.waitUntil??"domcontentloaded",signal});
      return this.pages(s).find(p=>s.pages.get(p.pageId)===page);
    }
    let cdp:CDPSession;
    if(input.action==="cdp"&&input.scope==="browser"){
      cdp=s.cdp.get("browser")??await (s.browser?s.browser.newBrowserCDPSession():s.context!.newCDPSession(this.page(s)));s.cdp.set("browser",cdp);
      return cdp.send(input.method as Parameters<CDPSession["send"]>[0],input.params);
    }
    const page=this.page(s,input.pageId),options={timeout:Math.min(input.timeoutMs??30000,NODE_TIMER_MAX_MS),signal};
    const locator=()=>this.locator(page,input.locator);
    const clipped=(text:string)=>{const max=input.maxChars??16000;return {text:max<0?text:text.slice(0,max),totalChars:text.length,truncated:max>=0&&text.length>max}};
    switch(input.action){
      case "closePage":await page.close();return {closed:true};
      case "goto": {const r=await page.goto(input.url!,{...options,waitUntil:input.waitUntil??"domcontentloaded"});return {url:page.url(),status:r?.status()??null}};
      case "back":case "forward":case "reload":{
        const nav={...options,waitUntil:input.waitUntil??"domcontentloaded"};
        const r=await (input.action==="back"?page.goBack(nav):input.action==="forward"?page.goForward(nav):page.reload(nav));return {url:page.url(),status:r?.status()??null};
      }
      case "snapshot":return clipped(await locator().ariaSnapshot({...options,depth:input.depth,mode:"ai"}));
      case "content":return clipped(await (input.locator?locator().innerText(options):page.content()));
      case "click":await locator().click({...options,force:input.force});break;
      case "dblclick":await locator().dblclick({...options,force:input.force});break;
      case "fill":await locator().fill(input.value!,{...options,force:input.force});break;
      case "press":await locator().press(input.value!,options);break;
      case "select":return {values:await locator().selectOption(input.values??input.value!,{...options,force:input.force})};
      case "check":await locator().setChecked(input.checked??true,{...options,force:input.force});break;
      case "hover":await locator().hover({...options,force:input.force});break;
      case "wait":await locator().waitFor({...options,state:input.state??"visible"});break;
      case "upload":await locator().setInputFiles(input.paths!,options);break;
      case "evaluate":return {value:await page.evaluate(input.expression!,input.arg)};
      case "screenshot":{const data=await page.screenshot({...options,path:input.path,fullPage:input.fullPage??false,type:"png"});return {mimeType:"image/png",bytes:data.length,data:data.toString("base64"),path:input.path??null}};
      case "cdp":cdp=s.cdp.get(page)??await page.context().newCDPSession(page);s.cdp.set(page,cdp);return cdp.send(input.method as Parameters<CDPSession["send"]>[0],input.params);
    }
    return {ok:true};
  }
  async close(){await Promise.allSettled([...this.sessions.values()].map(s=>this.dispose(s)));this.sessions.clear();this.receipts.clear()}
}
