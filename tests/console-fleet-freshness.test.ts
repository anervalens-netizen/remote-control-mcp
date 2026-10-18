import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { afterEach, expect, it } from "vitest";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
const executablePath = process.env.RCMCP_TEST_BROWSER ?? [chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/google-chrome"].find(p => existsSync(p));

it.skipIf(!executablePath).each([
  { mode: "manual", clockSkewMs: 0, clockJumpMs: 0, withSelection: false },
  { mode: "automatic", clockSkewMs: 0, clockJumpMs: 0, withSelection: false },
  { mode: "automatic", clockSkewMs: 120_000, clockJumpMs: 0, withSelection: false },
  { mode: "automatic", clockSkewMs: -120_000, clockJumpMs: 0, withSelection: false },
  { mode: "automatic", clockSkewMs: 0, clockJumpMs: -120_000, withSelection: false },
  { mode: "automatic", clockSkewMs: 0, clockJumpMs: 0, withSelection: true },
])("keeps $mode fleet refreshes with cached openers, $clockSkewMs ms skew, $clockJumpMs ms clock jump and selection=$withSelection", async ({ mode, clockSkewMs, clockJumpMs, withSelection }) => {
  const scope = "22222222-2222-4222-8222-222222222222";
  const opener = {
    ...(withSelection ? { selected: { job: { device: "synthetic-device", identity: "owner", jobId: "synthetic-job" } } } : {}),
    observedAt: new Date(Date.now() + clockSkewMs - 14 * 60_000).toISOString(),
    fleet: { totalConfigured: 1, devices: [{ device: "synthetic-device", identity: "owner", connectivity: "reachable", readiness: "ready", observedAt: new Date(Date.now() + clockSkewMs - 14 * 60_000).toISOString(), runtime: { sha: "cached-probe" } }] },
    operations: { items: [], coverage: { partial: false } }, jobs: null,
  };
  const host = await build({ stdin: { contents: `
    import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
    const opener=${JSON.stringify(opener)};
    window.clockSkew=${clockSkewMs};
    const controllerNow=()=>new Date(Date.now()+window.clockSkew).toISOString();
    window.calls=[];window.fleetReads=0;
    const frame=document.createElement('iframe');frame.id='panel';document.body.append(frame);
    const bridge=new AppBridge(null,{name:'synthetic-mobile-host',version:'1'},{serverTools:{},updateModelContext:{}},{hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen'],platform:'mobile'}});
    bridge.oncalltool=async params=>{
      if(params.name==='operation_inspect')return {content:[],structuredContent:{observedAt:controllerNow(),observation:{state:'completed',code:0}}};
      if(params.name!=='dashboard_snapshot')throw new Error('Unexpected tool '+params.name);
      window.calls.push(params);
      // Some hosts rebroadcast the stored opener alongside tool-call results.
      // The object is cloned by transport, even though its observations are old.
      await bridge.sendToolResult({content:[],structuredContent:structuredClone(opener)});
      const observedAt=controllerNow();
      const fleet=params.arguments.includeFleet
        ? {...opener.fleet,devices:opener.fleet.devices.map(row=>({...row,observedAt,runtime:{sha:'fresh-'+(++window.fleetReads)}}))}
        : null;
      return {content:[],structuredContent:{observedAt,...(params.arguments.diagnosticScopeId ? {diagnosticScopeId:params.arguments.diagnosticScopeId}:{}),operations:opener.operations,fleet,jobs:null}};
    };
    bridge.oninitialized=async()=>{
      await bridge.sendToolInput({arguments:{}});
      await bridge.sendToolResult({content:[],structuredContent:structuredClone(opener)});
    };
    window.replayOpener=()=>bridge.sendToolResult({content:[],structuredContent:structuredClone(opener)});
    window.activateCachedScope=async()=>{
      const cached={...opener,diagnosticScopeId:${JSON.stringify(scope)},suggestedDiagnosticScopeId:${JSON.stringify(scope)}};
      delete cached.selected;
      await bridge.sendToolInput({arguments:{diagnosticScopeId:${JSON.stringify(scope)}}});
      await bridge.sendToolResult({content:[],structuredContent:cached});
    };
    bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow)).then(()=>{frame.src='/console'});
  `, resolveDir: process.cwd(), loader: "js" }, bundle: true, write: false, format: "iife", minify: true });
  const html = await readFile("apps/console/dist/console.html", "utf8");
  const http = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/console" ? html : `<html><body><style>iframe{width:390px;height:850px;border:0}</style><script>${host.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  closers.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] }); closers.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  await page.clock.install();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(http.address() as { port: number }).port}`);
  const panel = page.frameLocator("#panel");
  await panel.getByText("cached-probe", { exact: true }).waitFor();
  if (withSelection) {
    await panel.getByRole("complementary").getByText("Exit code: 0", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
  }
  if (mode === "manual") await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  else await page.clock.runFor(6000);
  await panel.getByText("fresh-1", { exact: true }).waitFor();
  if (clockJumpMs) await page.evaluate(jump => { (window as any).clockSkew += jump; }, clockJumpMs);
  const before = await page.evaluate(() => (window as any).calls.length);
  await page.clock.fastForward(6000);
  await expect.poll(() => page.evaluate(() => (window as any).calls.length)).toBeGreaterThan(before);
  await panel.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  expect(await panel.locator(".device-meta code").innerText()).toBe("fresh-1");
  expect(await panel.getByRole("complementary").count()).toBe(0);
  expect(await page.evaluate(() => (window as any).calls.at(-1).arguments.includeFleet)).toBe(false);
  await page.clock.fastForward(31_000);
  await panel.getByText("fresh-2", { exact: true }).waitFor({ timeout: 3000 });
  await page.evaluate(() => (window as any).replayOpener());
  expect(await panel.locator(".device-meta code").innerText()).toBe("fresh-2");
  await page.evaluate(() => (window as any).activateCachedScope());
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1).arguments.diagnosticScopeId)).toBe(scope);
  await panel.getByText("fresh-3", { exact: true }).waitFor({ timeout: 3000 });
  expect(await panel.getByRole("complementary").count()).toBe(0);
  expect(await panel.locator("h2").first().innerText()).toContain("1 shown · 1 configured");
  expect(errors).toEqual([]);
}, 20000);
