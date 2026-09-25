import { AgentClient } from '../apps/mcp-server/src/agent-client.ts';
import { writeFile, access } from 'node:fs/promises';
import { captureDesktopFile } from '../apps/agent/src/desktop-screenshot.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopHelper, desktopHelperPowerShell } from '../apps/agent/src/desktop-helper.ts';
import { desktopRequestScope, desktopSequence } from '../apps/agent/src/desktop-sequence.ts';
import { closeDesktopHelper, desktopBatch, desktopHelperStatus, desktopKeyboard, desktopMonitors, desktopScreenshot, desktopSessionStatus } from '../apps/agent/src/desktop.ts';
import Fastify from 'fastify';
import { registerDesktopRoutes } from '../apps/agent/src/desktop-routes.ts';

const helpers: DesktopHelper[] = [];
afterEach(() => { for (const helper of helpers.splice(0)) helper.close(); closeDesktopHelper(); });
function fake() {
  const code = `const {createInterface}=require('node:readline');
let count=0;
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);count++;
 if(r.script==='crash')process.exit(3);
 if(r.script==='hang')return;
 if(r.script==='malformed'){console.log('invalid frame');return;}
 const ok=r.script!=='error';
 console.log(JSON.stringify({id:r.id,ok,error:'request rejected',stdout:JSON.stringify({pid:process.pid,count,input:r.input})}));
});`;
  const helper = new DesktopHelper(process.execPath, ['-e', code]); helpers.push(helper); return helper;
}

describe('persistent desktop transport', () => {
  it('reuses one process and correlates concurrent Unicode inputs in order', async () => {
    const helper = fake();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => helper.request('echo', { i, text: 'Șță 😀\nquote"' }))) as Array<{ pid: number; count: number; input: { i: number; text: string } }>;
    expect(new Set(results.map(r => r.pid)).size).toBe(1);
    expect(results.map(r => r.count)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(results[11]?.input).toEqual({ i: 11, text: 'Șță 😀\nquote"' });
    expect(helper.status()).toMatchObject({ starts: 1, completed: 12, busy: false });
  });
  it('keeps request errors local and usable process alive', async () => {
    const helper = fake();
    await expect(helper.request('error')).rejects.toThrow('request rejected');
    const result = await helper.request('echo') as { count: number };
    expect(result.count).toBe(2); expect(helper.status().starts).toBe(1);
  });
  it.each(['crash', 'malformed', 'hang'])('recovers after %s without replaying the failed action', async (kind) => {
    const helper = fake();
    await expect(helper.request(kind, undefined, 300)).rejects.toThrow();
    const result = await helper.request('echo') as { count: number };
    expect(result.count).toBe(1); expect(helper.status().starts).toBe(2);
  });
  it('reports failed spawn and rejects calls after close without uncaught events', async () => {
    const helper = new DesktopHelper('rcmcp-nonexistent-desktop-helper', []); helpers.push(helper);
    await expect(helper.request('echo')).rejects.toThrow();
    helper.close(); await expect(helper.request('echo')).rejects.toThrow('closed');
  });
  it('closes an in-flight request and never executes an already queued request', async () => {
    const helper = fake(); await helper.request('echo');
    const hanging = helper.request('hang'); const queued = helper.request('echo');
    const assertions = Promise.all([expect(hanging).rejects.toThrow('closed'), expect(queued).rejects.toThrow('closed')]);
    await new Promise(resolve => setTimeout(resolve, 20)); helper.close(); await assertions;
    expect(helper.status()).toMatchObject({ running: false, completed: 1 });
  });
});

describe('desktop sequence routing', () => {
  it('holds the lane across nested actions and waits, and releases it on failure', async () => {
    const events: string[] = [];
    const batch = desktopSequence(async () => {
      events.push('batch1');
      await new Promise(resolve => setTimeout(resolve, 20));
      await desktopSequence(async () => { events.push('batch2'); });
      throw new Error('stop');
    });
    const single = desktopSequence(async () => { events.push('single'); });
    await expect(batch).rejects.toThrow('stop'); await single;
    expect(events).toEqual(['batch1', 'batch2', 'single']);
  });
  it('discards an aborted queue entry before effects and releases the next entry', async () => {
    let release!: () => void;
    const held = desktopSequence(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const controller = new AbortController(); let executed = false;
    const queued = desktopRequestScope(controller.signal, () => desktopSequence(async () => { executed = true; }));
    controller.abort(new Error('caller gone'));
    await expect(queued).rejects.toThrow('caller gone');
    release(); await held; await desktopSequence(async () => {});
    expect(executed).toBe(false);
  });
  it('cancels a real HTTP desktop batch wait on disconnect and skips its remaining actions', async () => {
    const app = Fastify(); registerDesktopRoutes(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const client = new AgentClient([{ name: 'pc', url: address, desktopUrl: address }], undefined, 2000);
      const abandoned = client.desktopBatch('pc', { stopOnError: false, actions: [{ kind: 'wait', ms: 10_000 }, { kind: 'wait', ms: 10_000 }] }, controller.signal);
      void abandoned.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 50)); controller.abort();
      await expect(abandoned).rejects.toMatchObject({ kind: "cancelled", context: "desktop" });
      const next = await fetch(address + '/v1/desktop/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actions: [{ kind: 'wait', ms: 1 }] }), signal: AbortSignal.timeout(2000) });
      expect(await next.json()).toMatchObject({ ok: true, executed: 1 });
    } finally { await app.close(); }
  });
  it('prevalidates all steps and exposes status without starting a process', async () => {
    const app = Fastify(); registerDesktopRoutes(app);
    try {
      const bad = await app.inject({ method: 'POST', url: '/v1/desktop/batch', payload: { actions: [{ kind: 'wait', ms: 1 }, { kind: 'focus' }] } });
      expect(bad.statusCode).toBe(400);
      const valid = await app.inject({ method: 'POST', url: '/v1/desktop/batch', payload: { actions: [{ kind: 'wait', ms: 1 }, { kind: 'wait', ms: 1 }] } });
      expect(valid.json()).toMatchObject({ ok: true, executed: 2, skipped: 0, helper: { running: false } });
    } finally { await app.close(); }
  });
  it.skipIf(process.platform === 'win32')('stops or continues after individual action errors with truthful partial results', async () => {
    const actions = [{ kind: 'wait' as const, ms: 1 }, { kind: 'monitors' as const }, { kind: 'wait' as const, ms: 1 }];
    expect(await desktopBatch({ actions })).toMatchObject({ ok: false, executed: 2, skipped: 1, stoppedOnError: true });
    expect(await desktopBatch({ actions, stopOnError: false })).toMatchObject({ ok: false, executed: 3, skipped: 0, stoppedOnError: false });
  });
});

describe.skipIf(process.platform !== 'win32' || process.env.RCMCP_TEST_INTERACTIVE === '0')('native PowerShell helper', () => {
  it('runs scripts in isolated scopes, preserves Unicode and survives script errors', async () => {
    const helper = new DesktopHelper('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(desktopHelperPowerShell, 'utf16le').toString('base64')]); helpers.push(helper);
    expect(await helper.request('$scriptLocal=42; $RcmcpInput|ConvertTo-Json -Compress', { text: 'Șță 😀\nquote"' })).toEqual({ text: 'Șță 😀\nquote"' });
    expect(await helper.request('@{isolated=($null -eq $scriptLocal);sta=([Threading.Thread]::CurrentThread.ApartmentState.ToString())}|ConvertTo-Json -Compress')).toEqual({ isolated: true, sta: 'STA' });
    await expect(helper.request("throw 'expected failure'")).rejects.toThrow('expected failure');
    expect(await helper.request('@{alive=$true}|ConvertTo-Json -Compress')).toEqual({ alive: true });
    expect(helper.status().starts).toBe(1);
  }, 15000);
  it('reuses compiled desktop types, serializes batches and recovers after helper loss', async () => {
    const first = await desktopBatch({ actions: [{ kind: 'session' }, { kind: 'windows' }, { kind: 'monitors' }, { kind: 'mouse', action: 'position' }] });
    expect(first.ok).toBe(true);
    const pid = desktopHelperStatus().pid!;
    const second = await desktopBatch({ actions: [{ kind: 'session' }, { kind: 'windows' }, { kind: 'monitors' }, { kind: 'mouse', action: 'position' }] });
    expect(second.ok).toBe(true); expect(desktopHelperStatus().pid).toBe(pid);
    await expect(desktopKeyboard({ action: 'hotkey', keys: ['CTRL', 'INVALID_RCMCP_KEY'] })).rejects.toThrow('unsupported key');
    process.kill(pid);
    // A request racing process exit is allowed to fail once; no replay is permitted.
    await new Promise(resolve => setTimeout(resolve, 200));
    await desktopMonitors(); expect(desktopHelperStatus().pid).not.toBe(pid);
  }, 20000);
  it('captures valid PNG bytes through the same helper in an interactive session', async context => {
    const session = await desktopSessionStatus() as { interactiveSession: boolean; inputDesktop: { accessible: boolean } };
    if (!session.interactiveSession || !session.inputDesktop.accessible) {
      if (process.env.RCMCP_TEST_INTERACTIVE === '1') throw new Error('Interactive CI profile requires an accessible Windows input desktop');
      context.skip();
      return;
    }
    const pid = desktopHelperStatus().pid;
    const shot = await desktopScreenshot({ scale: 0.1 }) as { data: string; bytes: number; width: number };
    const bytes = Buffer.from(shot.data, 'base64');
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); expect(bytes.length).toBe(shot.bytes); expect(shot.width).toBeGreaterThan(0);
    expect(desktopHelperStatus().pid).toBe(pid);
  }, 15000);
});

describe('screenshot payload capacity', () => {
  it('keeps PNG bytes beyond the JSON frame cap in a temporary file, then removes it', async () => {
    let target = '';
    const shot = await captureDesktopFile(async destination => {
      target = destination; await writeFile(destination, Buffer.alloc(49 * 1024 * 1024, 0x55));
      return { width: 8192, height: 8192 };
    });
    expect(shot.bytes).toBe(49 * 1024 * 1024);
    expect(shot.data.length).toBeGreaterThan(64 * 1024 * 1024);
    expect(shot.data.slice(0, 16)).toBe('VVVVVVVVVVVVVVVV');
    await expect(access(target)).rejects.toThrow();
  });
  it('removes partial screenshot data after capture failure', async () => {
    let target = '';
    await expect(captureDesktopFile(async destination => {
      target = destination; await writeFile(destination, 'partial'); throw new Error('capture failed');
    })).rejects.toThrow('capture failed');
    await expect(access(target)).rejects.toThrow();
  });
});
