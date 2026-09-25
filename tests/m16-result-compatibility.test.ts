import { expect, it } from "vitest";
import { summarizeDockerSnapshot } from "../packages/protocol/src/filtering.ts";
import { toolResultSchemas } from "../apps/mcp-server/src/semantic-result-schemas.ts";
import { compactStructuredContent, STRUCTURED_CONTENT_MAX_BYTES } from "../apps/mcp-server/src/tool-contract-defaults.ts";

it("validates actual compact Docker summaries instead of confusing them with snapshots", () => {
  const summary={device:"fixture",...summarizeDockerSnapshot({available:true,version:{},containers:[{Names:"fixture",State:"running",Status:"healthy",Image:"fixture:1",Ports:""}],images:[{}],compose:[],errors:[]})};
  expect(toolResultSchemas.docker_summary.safeParse(summary).success).toBe(true);
  expect(toolResultSchemas.docker_summary.safeParse({...summary,images:[]}).success).toBe(false);
});
it("validates settled repository comparison entries and browser outcome presence", () => {
  expect(toolResultSchemas.repo_compare.safeParse({items:[{index:0,ok:true,result:{device:"fixture",path:"/fixture",head:null,clean:true}},{index:1,ok:false,error:"offline"}]}).success).toBe(true);
  expect(toolResultSchemas.repo_compare.safeParse({items:[{device:"fixture",path:"/fixture"}]}).success).toBe(false);
  expect(toolResultSchemas.browser_session.safeParse({context:"user"}).success).toBe(false);
  expect(toolResultSchemas.browser_session.safeParse({context:"user",sessions:[]}).success).toBe(true);
});

it("preserves Windows telemetry, created searches and truthful degraded outcomes", () => {
  expect(toolResultSchemas.process_list.safeParse({items:[{ProcessId:0,Name:"System Idle Process"}]}).success).toBe(true);
  expect(toolResultSchemas.process_list.safeParse({items:[{ProcessId:-1}]}).success).toBe(false);
  expect(toolResultSchemas.gpu_snapshot.safeParse({controllers:[{Name:"Fixture GPU"}],activeEngines:[]}).success).toBe(true);
  expect(toolResultSchemas.gpu_snapshot.safeParse({activeEngines:[]}).success).toBe(false);
  expect(toolResultSchemas.search_start.safeParse({id:"session",status:"running",createdAt:new Date().toISOString()}).success).toBe(true);
  expect(toolResultSchemas.desktop_keyboard.safeParse({ok:false,typed:true,clipboardRestored:false,error:"dummy failure"}).success).toBe(true);
  expect(toolResultSchemas.pty_terminate.safeParse({ok:true,id:"session",state:"lost",exited:false,terminationVerified:false}).success).toBe(true);
});

it("keeps complete legacy payloads while bounding duplicated structuredContent", () => {
  const payload = { stdout: "x".repeat(256 * 1024), stderr: "", items: Array.from({ length: 200 }, (_, index) => ({ index, value: "y".repeat(1024) })) };
  const compact = compactStructuredContent(payload);
  expect(compact.structuredContentTruncated).toBe(true);
  expect(compact.structuredContentOriginalBytes).toBeGreaterThan(STRUCTURED_CONTENT_MAX_BYTES);
  expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThan(STRUCTURED_CONTENT_MAX_BYTES + 4096);
  expect((compact.stdout as string).length).toBeLessThan(payload.stdout.length);
  expect(payload.stdout).toHaveLength(256 * 1024);
});
