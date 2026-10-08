import { createServer } from "node:http";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { afterEach, expect, it } from "vitest";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
const executablePath = process.env.RCMCP_TEST_BROWSER ?? [chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/google-chrome"].find(p => existsSync(p));
it.skipIf(!executablePath)("renders two isolated panels through the official bridge, preserves stale state and treats output as text", async () => {
  const scopes = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const traceId = "33333333-3333-4333-8333-333333333333";
  const data = scopes.map(diagnosticScopeId => ({ diagnosticScopeId, observedAt: new Date().toISOString(),
    fleet: { devices: [{ device: "lab-fixture", identity: "root", online: true, connectivity: "reachable", readiness: "ready", observedAt: new Date().toISOString() }] },
    operations: { items: [{ tool: "fixture-operation", traceId, state: "returned", startedAt: new Date().toISOString(), jobCount: 1 }], nextCursor: null, coverage: { partial: false } }, jobs: null }));
  const host = await build({ stdin: { contents: `
    import {AppBridge, PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
    window.calls=[]; window.fail=false;
    const fixtures=${JSON.stringify(data)};
    (async()=>{for(let i=0;i<2;i++){
      const frame=document.createElement('iframe');frame.id='panel-'+i;document.body.append(frame);
      const bridge=new AppBridge(null,{name:'synthetic-host',version:'1'},{serverTools:{},updateModelContext:{}},{hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen'],theme:'light'}});
      bridge.oncalltool=async(params)=>{
        window.calls.push({panel:i,...params});
        if(window.fail)throw new Error('synthetic disconnected');
        let value;
        if(params.name==='dashboard_snapshot')value={...fixtures[i],...(params.arguments.includeFleet===false?{fleet:null}:{})};
        else if(params.arguments.reference.traceId)value={observedAt:new Date().toISOString(),reference:params.arguments.reference,observation:{state:'returned',events:[],jobs:[{device:'lab-fixture',identity:'root',jobId:'fixture-job'}]},output:null,coverage:'Observed metadata only'};
        else value={observedAt:new Date().toISOString(),reference:params.arguments.reference,observation:{id:'fixture-job',state:'completed',code:7},output:params.arguments.output?{stream:'stdout',data:'<img src=x onerror="window.__injected=true">',nextOffset:45,eof:true}:null,coverage:'Fresh agent observation'};
        return {content:[],structuredContent:value};
      };
      bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult({content:[],structuredContent:fixtures[i]});};
      await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/console';
    }})();`, resolveDir: process.cwd(), loader: "js" }, bundle: true, write: false, format: "iife", minify: true });
  const html = await readFile("apps/console/dist/console.html", "utf8");
  const http = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/console" ? html : `<html><body><style>iframe{width:48%;height:850px;border:0}</style><script>${host.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  closers.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] }); closers.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(http.address() as { port: number }).port}`);
  const first = page.frameLocator("#panel-0"), second = page.frameLocator("#panel-1");
  await first.getByText(scopes[0]!, { exact: true }).waitFor();
  await second.getByText(scopes[1]!, { exact: true }).waitFor();
  expect(await page.evaluate(() => (window as any).calls.length)).toBe(0);
  await first.getByRole("button", { name: "fixture-operation", exact: true }).click();
  await first.getByRole("button", { name: /fixture-job/ }).click();
  await first.getByRole("button", { name: "Read stdout", exact: true }).click();
  await first.locator("pre").waitFor();
  expect(await first.locator("pre").innerText()).toContain("<img");
  expect(await first.locator("pre img").count()).toBe(0);
  expect(await second.getByRole("complementary").count()).toBe(0);
  await first.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => { (window as any).fail = true; });
  await first.getByRole("button", { name: "Refresh", exact: true }).click();
  await first.getByRole("alert").waitFor();
  expect(await first.getByRole("alert").innerText()).toContain("may be old");
  expect(await first.locator(".device-title").innerText()).toContain("lab-fixture");
  expect(await first.locator(".device-title .badge").innerText()).toBe("STALE");
  const evidence = process.env.RCMCP_UI_EVIDENCE_DIR ?? await mkdtemp(path.join(os.tmpdir(), "rcmcp-console-ui-"));
  if (!process.env.RCMCP_UI_EVIDENCE_DIR) closers.push(() => rm(evidence, { recursive: true, force: true }));
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, "console.png"), fullPage: true });
  expect(errors).toEqual([]);
}, 20_000);
