import { expect, it } from "vitest";
import { compactHistoryPage } from "../apps/mcp-server/src/tool-contract-defaults.ts";
it("compacts whole history items and never skips the unreturned tail", () => {
  const all=Array.from({length:200},(_,i)=>({id:'fixture-'+i,startedAt:'2026-01-01',command:'x'.repeat(1024),state:'completed'}));
  let remaining=all; const seen:string[]=[];
  while(remaining.length) {
    const page=compactHistoryPage({items:remaining,nextCursor:null,partial:false,corruptCount:0,unavailableCount:0});
    const items=page.items as typeof all;
    expect(items.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
    seen.push(...items.map(item=>item.id));
    if(items.length<remaining.length) {
      const cursor=JSON.parse(Buffer.from(page.nextCursor as string,'base64url').toString());
      expect(cursor).toEqual({id:items.at(-1)!.id,startedAt:items.at(-1)!.startedAt});
    } else expect(page.nextCursor).toBeNull();
    remaining=remaining.slice(items.length);
  }
  expect(seen).toEqual(all.map(item=>item.id));
});
it("delivers a bounded oversized row with its ID and a usable cursor",()=>{
 const page=compactHistoryPage({items:[{id:'fixture',state:'completed',startedAt:'2026-01-01',command:'x'.repeat(70000)}],nextCursor:null});
 expect(page.items).toMatchObject([{id:'fixture',state:'completed',commandTruncated:true,detailsOmitted:true,detailsTool:'job_status'}]);
 expect(page.nextCursor).toBeNull();
 expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
});
