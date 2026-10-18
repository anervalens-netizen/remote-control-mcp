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
  { mode: "manual", clockSkewMs: 0 },
  { mode: "automatic", clockSkewMs: 0 },
  { mode: "automatic", clockSkewMs: 120_000 },
  { mode: "automatic", clockSkewMs: -120_000 },
])("keeps $mode fleet refreshes with cached openers and $clockSkewMs ms controller clock skew", async ({ mode, clockSkewMs }) => {
  const opener = {
    observedAt: new Date(Date.now() + clockSkewMs - 14 * 60_000).toISOString(),
    fleet: { totalConfigured: 1, devices: [{ device: "synthetic-device", identity: "owner", connectivity: "reachable", readiness: "ready", observedAt: new Date(Date.now() + clockSkewMs - 14 * 60_000).toISOString(), runtime: { sha: "cached-probe" } }] },
    operations: { items: [], coverage: { partial: false } }, jobs: null,
  };
  const host = await build({ stdin: { contents: `
    import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
    const opener=${JSON.stringify(opener)};
    const controllerNow=()=>new Date(Date.now()+${clockSkewMs}).toISOString();
    window.calls=[];window.fleetReads=0;
    const frame=document.createElement('iframe');frame.id='panel';document.body.append(frame);
    const bridge=new AppBridge(null,{name:'synthetic-mobile-host',version:'1'},{serverTools:{},updateModelContext:{}},{hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen'],platform:'mobile'}});
    bridge.oncalltool=async params=>{
      if(params.name!=='dashboard_snapshot')throw new Error('Unexpected tool '+params.name);
      window.calls.push(params);
      // Some hosts rebroadcast the stored opener alongside tool-call results.
      // The object is cloned by transport, even though its observations are old.
      await bridge.sendToolResult({content:[],structuredContent:structuredClone(opener)});
      const observedAt=controllerNow();
      const fleet=params.arguments.includeFleet
        ? {...opener.fleet,devices:opener.fleet.devices.map(row=>({...row,observedAt,runtime:{sha:'fresh-'+(++window.fleetReads)}}))}
        : null;
      return {content:[],structuredContent:{observedAt,operations:opener.operations,fleet,jobs:null}};
    };
    bridge.oninitialized=async()=>{
      await bridge.sendToolInput({arguments:{}});
      await bridge.sendToolResult({content:[],structuredContent:structuredClone(opener)});
    };
    window.replayOpener=()=>bridge.sendToolResult({content:[],structuredContent:structuredClone(opener)});
    window.newOpener=()=>{
      const observedAt=controllerNow();
      return bridge.sendToolResult({content:[],structuredContent:{...opener,observedAt,fleet:{...opener.fleet,devices:opener.fleet.devices.map(row=>({...row,observedAt,runtime:{sha:'new-opener'}}))}}});
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
  if (mode === "manual") await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  else await page.clock.runFor(6000);
  await panel.getByText("fresh-1", { exact: true }).waitFor();
  const before = await page.evaluate(() => (window as any).calls.length);
  await page.clock.fastForward(6000);
  await expect.poll(() => page.evaluate(() => (window as any).calls.length)).toBeGreaterThan(before);
  await panel.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  expect(await panel.locator(".device-meta code").innerText()).toBe("fresh-1");
  expect(await page.evaluate(() => (window as any).calls.at(-1).arguments.includeFleet)).toBe(false);
  await page.clock.fastForward(31_000);
  await panel.getByText("fresh-2", { exact: true }).waitFor({ timeout: 3000 });
  await page.evaluate(() => (window as any).replayOpener());
  expect(await panel.locator(".device-meta code").innerText()).toBe("fresh-2");
  await page.evaluate(() => (window as any).newOpener());
  await panel.getByText("new-opener", { exact: true }).waitFor();
  expect(await panel.locator("h2").first().innerText()).toContain("1 shown · 1 configured");
  expect(errors).toEqual([]);
}, 20000);
