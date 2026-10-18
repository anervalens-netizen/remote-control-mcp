import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { afterEach, expect, it } from "vitest";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
const executablePath = process.env.RCMCP_TEST_BROWSER ?? [chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/google-chrome"].find(p => existsSync(p));

it.skipIf(!executablePath).each(["missing", "selection-only", "snapshot-selection"])("loads and refreshes global observations with a %s opener", async mode => {
  const snapshot = { observedAt: new Date().toISOString(),
    fleet: { totalConfigured: 1, devices: [{ device: "synthetic-device", identity: "owner", connectivity: "reachable", readiness: "ready", observedAt: new Date().toISOString() }] },
    operations: { items: [{ tool: "synthetic-operation", traceId: "11111111-1111-4111-8111-111111111111", state: "returned", startedAt: new Date().toISOString(), jobCount: 0 }], coverage: { partial: false } }, jobs: null };
  const host = await build({ stdin: { contents: `
    import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
    window.calls=[];
    const fixture=${JSON.stringify(snapshot)};
    const selected={job:{device:'synthetic-device',identity:'owner',jobId:'synthetic-job'}};
    const selectedOpener=${JSON.stringify(mode)}==='snapshot-selection' ? {...fixture,selected} : {selected};
    const frame=document.createElement('iframe');frame.id='panel';document.body.append(frame);
    const bridge=new AppBridge(null,{name:'synthetic-mobile-host',version:'1'},{serverTools:{},updateModelContext:{}},{hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen'],platform:'mobile'}});
    bridge.oncalltool=async params=>{
      window.calls.push(params);
      if(params.name==='dashboard_snapshot')return {content:[],structuredContent:{...fixture,observedAt:new Date().toISOString(),fleet:params.arguments.includeFleet ? fixture.fleet : null}};
      if(params.name==='operation_inspect')return {content:[],structuredContent:{observedAt:new Date().toISOString(),observation:{state:'completed',code:0},coverage:'Synthetic terminal observation'}};
      throw new Error('Unexpected tool '+params.name);
    };
    bridge.oninitialized=async()=>{
      await bridge.sendToolInput({arguments:{}});
      if(${JSON.stringify(mode)}!=='missing')await bridge.sendToolResult({content:[],structuredContent:structuredClone(selectedOpener)});
    };
    window.sendPartial=async()=>{
      await bridge.sendToolInput({arguments:{reference:selected}});
      await bridge.sendToolResult({content:[],structuredContent:structuredClone(selectedOpener)});
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
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(http.address() as { port: number }).port}`);
  const panel = page.frameLocator("#panel");
  await panel.getByRole("button", { name: "synthetic-operation", exact: true }).waitFor({ timeout: 6000 });
  expect(await panel.locator(".device-title").innerText()).toContain("synthetic-device");
  expect(await panel.locator(".freshness").innerText()).not.toContain("Not observed");
  if (mode !== "missing") {
    await panel.getByRole("complementary").getByText("Exit code: 0", { exact: true }).waitFor({ timeout: 3000 });
    await panel.getByRole("button", { name: "Close", exact: true }).click();
  }
  const before = await page.evaluate(() => (window as any).calls.filter((x: any) => x.name === "dashboard_snapshot").length);
  await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((x: any) => x.name === "dashboard_snapshot").length)).toBeGreaterThan(before);
  await page.evaluate(() => (window as any).sendPartial());
  await panel.getByRole("complementary").getByText("Exit code: 0", { exact: true }).waitFor();
  expect(await panel.locator(".device-title").innerText()).toContain("synthetic-device");
  expect(await panel.getByRole("button", { name: "synthetic-operation", exact: true }).count()).toBe(1);
  const calls = await page.evaluate(() => (window as any).calls);
  const snapshots = calls.filter((x: any) => x.name === "dashboard_snapshot");
  expect(snapshots[0].arguments.includeFleet).toBe(true);
  expect(snapshots.every((x: any) => !x.arguments.diagnosticScopeId)).toBe(true);
  expect(calls.every((x: any) => ["dashboard_snapshot", "operation_inspect"].includes(x.name))).toBe(true);
  expect(errors).toEqual([]);
}, 15000);
