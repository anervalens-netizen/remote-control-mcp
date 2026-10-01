import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolDiagnostics, startToolProgress, toolOutcome } from '../apps/mcp-server/src/tool-diagnostics.ts';
afterEach(() => vi.useRealTimers());
describe('bounded tool observations', () => {
  it('bounds cardinality and samples without capturing arguments or arbitrary device names', () => {
    const d = new ToolDiagnostics(['fixture'], 2, 3);
    for (let i=1;i<=6;i++) d.record('exec', {device:'fixture',command:'private-command'}, i, i===3?'error':'success');
    d.record('exec',{device:'private-token-in-name'},7,'cancelled');d.record('search',{},8,'partial');
    const s=d.snapshot();expect(s.series).toHaveLength(2);expect(s.overflowCalls).toBe(1);
    expect(s.series[0]).toMatchObject({count:6,errors:1,sampledCalls:3,p50Ms:5,p95Ms:6});
    expect(JSON.stringify(s)).not.toMatch(/private-command|private-token-in-name/);
  });
  it('distinguishes functional failure and partial results from HTTP success',()=>{
    expect(toolOutcome({isError:true},{},undefined)).toBe('error');
    expect(toolOutcome({}, {code:1})).toBe('error');
    expect(toolOutcome({}, {partial:true})).toBe('partial');
    expect(toolOutcome({}, {devices:[{online:false}]})).toBe('partial');
    expect(toolOutcome({}, {ok:false,kind:'cancelled'})).toBe('cancelled');
    expect(toolOutcome({}, {ok:true})).toBe('success');
  });
});
describe('optional truthful progress',()=>{
  it('does not notify without a caller token',async()=>{
    vi.useFakeTimers();const sendNotification=vi.fn().mockResolvedValue(undefined);const stop=startToolProgress('job_wait',{sendNotification});
    await vi.advanceTimersByTimeAsync(5000);stop();expect(sendNotification).not.toHaveBeenCalled();
  });
  it('uses increasing elapsed progress and stops on completion/cancellation',async()=>{
    vi.useFakeTimers();const sendNotification=vi.fn().mockResolvedValue(undefined);const c=new AbortController();
    const stop=startToolProgress('job_wait',{_meta:{progressToken:0},sendNotification,signal:c.signal});
    await vi.advanceTimersByTimeAsync(2100);expect(sendNotification).toHaveBeenCalledTimes(3);
    const params=sendNotification.mock.calls.map(c=>c[0].params);expect(params.every(p=>p.progressToken===0&&p.total===undefined)).toBe(true);
    expect(params[1].progress).toBeGreaterThan(params[0].progress);expect(params[2].progress).toBeGreaterThan(params[1].progress);
    c.abort();stop();await vi.advanceTimersByTimeAsync(3000);expect(sendNotification).toHaveBeenCalledTimes(3);
  });
  it('does not queue unbounded notifications and tolerates notifier failure',async()=>{
    vi.useFakeTimers();const sendNotification=vi.fn(()=>new Promise<void>(()=>{}));const stop=startToolProgress('fleet_status',{_meta:{progressToken:'x'},sendNotification});
    await vi.advanceTimersByTimeAsync(5000);expect(sendNotification).toHaveBeenCalledTimes(1);stop();
    const throwing=vi.fn(()=>{throw Error('transport closed')});const close=startToolProgress('job_wait',{_meta:{progressToken:'y'},sendNotification:throwing});close();
    expect(throwing).toHaveBeenCalledTimes(1);
  });
});
