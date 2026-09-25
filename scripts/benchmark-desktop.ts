import { performance } from 'node:perf_hooks';
import { closeDesktopHelper, desktopBatch, desktopHelperStatus, desktopMonitors, desktopMouse, desktopSessionStatus, desktopWindows } from '../apps/agent/src/desktop.ts';
if (process.platform !== 'win32') throw new Error('Run in the Windows interactive owner context');
const median = (xs: number[]) => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]!;
const actions = [{ kind: 'monitors' }, { kind: 'windows' }, { kind: 'mouse', action: 'position' }] as const;
const samples = Number(process.argv[2] ?? 5);
async function measure(fn: () => Promise<unknown>) {
  const times: number[] = [];
  for(let i=0;i<samples;i++){const start=performance.now();await fn();times.push(Number((performance.now()-start).toFixed(2)));}
  return { medianMs: median(times), samplesMs: times };
}
const original = process.env.RCMCP_DESKTOP_HELPER;
try {
  const report: Record<string, unknown> = {};
  for (const mode of ['oneshot','persistent']) {
    closeDesktopHelper(); process.env.RCMCP_DESKTOP_HELPER = mode === 'oneshot' ? '0' : '1';
    const started=performance.now(); await desktopSessionStatus();
    const coldMs=Number((performance.now()-started).toFixed(2));
    await desktopBatch({ actions: [...actions] });
    const individual=await measure(async () => { await desktopMonitors();await desktopWindows();await desktopMouse({action:'position'}); });
    const batch=await measure(async () => {const result=await desktopBatch({actions:[...actions]});if(!result.ok)throw new Error(JSON.stringify(result));});
    report[mode]={coldMs,individual,batch,helper:desktopHelperStatus()};
  }
  console.log(JSON.stringify(report,null,2));
} finally { closeDesktopHelper(); if(original===undefined)delete process.env.RCMCP_DESKTOP_HELPER;else process.env.RCMCP_DESKTOP_HELPER=original; }
