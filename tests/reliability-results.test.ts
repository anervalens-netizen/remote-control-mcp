import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify from 'fastify';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentClient } from '../apps/mcp-server/src/agent-client.ts';
import { registerTools } from '../apps/mcp-server/src/all-tools.ts';
import { createMcpHttpServer } from '../apps/mcp-server/src/http-server.ts';
import { fsRead, fsWrite, isValidBase64Data } from '../apps/agent/src/filesystem.ts';
import { installDefaultToolOutputContracts, TOTAL_RESULT_MAX_BYTES } from '../apps/mcp-server/src/tool-contract-defaults.ts';
import { diagnosticsFor, ToolDiagnostics, toolOutcome } from '../apps/mcp-server/src/tool-diagnostics.ts';
import { settledExecution } from '../apps/mcp-server/src/settled-execution.ts';
import { summarizeExecution } from '../packages/protocol/src/execution-outcome.ts';

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
const legacy = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);
async function temporary() { const dir = await mkdtemp(path.join(os.tmpdir(), 'result-fixture-')); close.push(() => rm(dir, { recursive: true, force: true })); return dir; }
function receipt(command: string) {
  const stdout = command === 'big' ? 'x'.repeat(8192) : command === 'huge' ? '😀'.repeat(2621440) : 'ok';
  return { code: ['signal', 'unknown', 'timeout', 'cancel'].includes(command) ? null : command === 'fail' ? 7 : 0,
    signal: command === 'signal' ? 'SIGTERM' : null, stdout, stderr: command === 'huge' ? stdout : 'diagnostic', durationMs: 1,
    timedOut: command === 'timeout', ...(command === 'cancel' ? { cancellationRequested: true, terminationVerified: false } : {}),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: command === 'huge' ? Buffer.byteLength(stdout) : 10, stdoutTruncated: false, stderrTruncated: false };
}
async function harness(http = false, options?: ConstructorParameters<typeof Client>[1]) {
  let calls = 0;
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
  app.post('/v1/exec', async (req, reply) => { calls++; const command = (req.body as any).command; if (command === 'exception') return reply.code(403).send({ code: 'EACCES', error: 'synthetic denied', credentials: 'must-not-leak' }); return receipt(command); });
  app.get('/v1/info', async () => ({ runtime: { capabilities: ['utf8-byte-pages-v1'] } }));
  app.post('/v1/fs/read', async req => fsRead(req.body as any));
  app.post('/v1/fs/write', async req => fsWrite(req.body as any));
  const jobBytes = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251));
  app.post('/v1/jobs/output', async req => {
    const input = req.body as any, offset = Math.max(0, input.offset ?? 0);
    const length = Math.min(input.length ?? 64 * 1024, jobBytes.length - offset);
    const chunk = jobBytes.subarray(offset, offset + Math.max(0, length));
    return { id: input.id, stream: input.stream ?? 'stdout', offset, nextOffset: offset + chunk.length,
      totalBytes: jobBytes.length, eof: offset + chunk.length >= jobBytes.length,
      data: input.encoding === 'base64' ? chunk.toString('base64') : chunk.toString('utf8') };
  });
  const rows = [{ id: 'first', state: 'completed', startedAt: '2026-01-03', command: '😀'.repeat(70000) }, { id: 'second', state: 'completed', startedAt: '2026-01-02', command: 'small' }];
  app.get('/v1/jobs/history', async req => { const cursor = (req.query as any).cursor; return { items: cursor ? rows.slice(1) : rows.slice(0, 1), nextCursor: cursor ? null : Buffer.from(JSON.stringify({ id: 'first', startedAt: '2026-01-03' })).toString('base64url'), partial: false, corruptCount: 0, unreadableCount: 0 }; });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  close.push(async () => { app.server.closeAllConnections(); await app.close(); });
  const agent = new AgentClient([{ name: 'fixture', url, userUrl: url }]);
  const client = new Client({ name: 'result-fixture', version: '1' }, options);
  if (http) {
    const server = createMcpHttpServer(agent, { token: 'synthetic-token' });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as any).port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer synthetic-token' } } });
    await client.connect(transport);
    close.push(async () => { await transport.terminateSession(); await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  } else {
    const server = new McpServer({ name: 'result-fixture', version: '1' }); registerTools(server, agent);
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
    close.push(async () => { await client.close(); await server.close(); });
  }
  const catalog = await client.listTools(); expect(catalog.tools.find(t => t.name === 'batch_exec')!.outputSchema).toBeDefined();
  return { client, calls: () => calls, diagnostics: diagnosticsFor(agent) };
}
async function recover(client: Client, id: string) {
  let offset = 0; const parts: Buffer[] = [];
  while (true) {
    const result: any = await client.callTool({ name: 'result_recover', arguments: { id, offset } });
    expect(result.isError).not.toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(TOTAL_RESULT_MAX_BYTES);
    const page = result.structuredContent, bytes = Buffer.from(page.data, 'base64'); expect(isValidBase64Data(page.data)).toBe(true);
    expect(bytes.length).toBe(page.bytesRead); expect(page.nextOffset).toBe(offset + bytes.length);
    parts.push(bytes); offset = page.nextOffset; if (page.eof) break;
  }
  return JSON.parse(Buffer.concat(parts).toString());
}

it.each([false, true])('real SDK accepts large/small batches, complete summaries and exact recovery (HTTP=%s)', async http => {
  const h = await harness(http);
  const items = Array.from({ length: 64 }, (_, i) => ({ device: 'fixture', identity: 'owner', command: i === 63 ? 'fail' : 'big' }));
  const r: any = await h.client.callTool({ name: 'batch_exec', arguments: { mode: "legacy", items, concurrency: 4 } });
  expect(r.isError).not.toBe(true); expect(h.calls()).toBe(64);
  expect(r.structuredContent.summary).toMatchObject({ total: 64, exit_zero: 63, exit_nonzero: 1, requestErrors: 0, effectVerification: 'unverified', clientAcceptance: 'unknown' });
  expect(r.structuredContent).toMatchObject({ partial: false, executionPartial: true, totalItems: 64, structuredContentTruncated: true });
  expect(r.structuredContent.items.some((i: any) => i.index === 63)).toBe(false);
  expect(legacy(r)).toEqual(r.structuredContent);
  expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(TOTAL_RESULT_MAX_BYTES);
  const full = await recover(h.client, r.structuredContent.resultRecovery.id);
  expect(full.structuredContent.items).toHaveLength(64); expect(full.structuredContent.items[63].result.code).toBe(7); expect(h.calls()).toBe(64);
  const small: any = await h.client.callTool({ name: 'batch_exec', arguments: { mode: "legacy", items: [{ device: 'fixture', command: 'small' }] } });
  expect(small.isError).not.toBe(true); expect(small.structuredContent.summary.exit_zero).toBe(1);
  expect(h.diagnostics.snapshot().series.find(s => s.tool === 'batch_exec')).toMatchObject({ count: 2, partial: 1, errors: 0 });
}, 20000);

it('distinguishes execution, request failures and unverified effects over the SDK', async () => {
  const h = await harness();
  const commands = ['small', 'fail', 'signal', 'timeout', 'unknown', 'cancel', 'exception'];
  const r: any = await h.client.callTool({ name: 'batch_exec', arguments: { mode: "legacy", items: commands.map(command => ({ device: 'fixture', command })) } });
  expect(r.isError).not.toBe(true);
  expect(r.structuredContent.summary).toEqual({ total: 7, requestSucceeded: 6, requestErrors: 1, exit_zero: 1, exit_nonzero: 1, signal: 1, timeout: 1, cancelled: 0, uncertain: 3, not_started: 0, effectVerification: 'unverified', clientAcceptance: 'unknown' });
  expect(r.structuredContent.errors[0]).toMatchObject({ index: 6, kind: 'http', status: 403, agentCode: 'EACCES', executionOutcome: 'uncertain' });
  expect(JSON.stringify(r)).not.toContain('must-not-leak');
  for (const command of commands.slice(0, 6)) await h.client.callTool({ name: 'exec', arguments: { device: 'fixture', command } });
  expect(h.diagnostics.snapshot().series.find(s => s.tool === 'exec')).toMatchObject({ count: 6, errors: 5, execution: { exit_zero: 1, exit_nonzero: 1, signal: 1, timeout: 1, uncertain: 2 } });
  expect(toolOutcome({}, { code: 7, state: 'completed' }, undefined, 'job_status')).toBe('success');
});

it('retains settled and unstarted slots after cancellation, without replay', async () => {
  const abort = new AbortController(); let effects = 0;
  const results = await settledExecution([1, 2, 3], async () => { effects++; abort.abort(); return receipt('small'); }, 1, abort.signal);
  expect(effects).toBe(1); expect(summarizeExecution(results)).toMatchObject({ total: 3, exit_zero: 1, not_started: 2 });
  const stopped = await settledExecution([1], async () => { throw new Error('must not execute'); }, 1, abort.signal);
  expect(summarizeExecution(stopped).not_started).toBe(1);
});

it('recovers a client-rejected result using an ID reserved before dispatch', async () => {
  let reject = false;
  const h = await harness(false, { jsonSchemaValidator: { getValidator: <T>() => (value: unknown) => reject ? { valid: false as const, errorMessage: 'Synthetic client rejection', data: undefined } : { valid: true as const, data: value as T, errorMessage: undefined } } });
  const reserved: any = await h.client.callTool({ name: 'result_recovery_prepare', arguments: {} });
  const id = reserved.structuredContent.id;
  reject = true;
  await expect(h.client.callTool({ name: 'exec', arguments: { device: 'fixture', command: 'small' }, _meta: { resultRecoveryId: id } })).rejects.toThrow('Synthetic client rejection');
  reject = false;
  const original = await recover(h.client, id); expect(original.structuredContent.code).toBe(0);
  const duplicate: any = await h.client.callTool({ name: 'exec', arguments: { device: 'fixture', command: 'small' }, _meta: { resultRecoveryId: id } });
  expect(duplicate.isError).toBe(true); expect(h.calls()).toBe(1);
});

it('base64 job_output compaction preserves decoded byte cursors even when an old agent omits encoding', async () => {
  const h = await harness();
  let offset = 0, sawCompacted = false; const parts: Buffer[] = [];
  while (offset < 64 * 1024) {
    const r: any = await h.client.callTool({ name: 'job_output', arguments: { device: 'fixture', identity: 'owner', id: 'synthetic-job', offset, length: 64 * 1024, encoding: 'base64' } });
    expect(r.isError).not.toBe(true);
    const s = r.structuredContent, decoded = Buffer.from(s.data, 'base64');
    expect(s.encoding).toBe('base64');
    if (s.bytesRead !== undefined) expect(decoded.length).toBe(s.bytesRead);
    expect(s.nextOffset).toBe(offset + decoded.length);
    if (s.structuredContentTruncated) { sawCompacted = true; expect(legacy(r)).toEqual(s); }
    parts.push(decoded);
    expect(s.nextOffset).toBeGreaterThan(offset);
    offset = s.nextOffset;
    if (s.eof) break;
  }
  expect(sawCompacted).toBe(true);
  expect(Buffer.concat(parts)).toEqual(Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251)));
});

it('binary pages and strict writer rebuild all 61,440 bytes coherently', async () => {
  const h = await harness(), root = await temporary(); const source = path.join(root, 'source'), target = path.join(root, 'target');
  const bytes = Buffer.from(Array.from({ length: 61440 }, (_, i) => i % 251)); await writeFile(source, bytes);
  for (const length of [61440, 4096]) {
    let offset = 0; const parts: Buffer[] = [];
    while (offset < bytes.length) {
      const r: any = await h.client.callTool({ name: 'fs_read', arguments: { device: 'fixture', path: source, offset, length, encoding: 'base64' } });
      expect(r.isError).not.toBe(true); const s = r.structuredContent, data = Buffer.from(s.data, 'base64');
      expect(isValidBase64Data(s.data)).toBe(true); expect(data.length).toBe(s.bytesRead); expect(s.nextOffset).toBe(offset + data.length);
      expect(legacy(r).data).toBe(s.data); expect(legacy(r).nextOffset).toBe(s.nextOffset);
      parts.push(data); offset = s.nextOffset;
    }
    expect(Buffer.concat(parts)).toEqual(bytes);
  }
  const write: any = await h.client.callTool({ name: 'fs_write', arguments: { device: 'fixture', path: target, encoding: 'base64', data: bytes.toString('base64') } });
  expect(write.isError).not.toBe(true); expect(await readFile(target)).toEqual(bytes);
  const bad: any = await h.client.callTool({ name: 'fs_write', arguments: { device: 'fixture', path: target, encoding: 'base64', data: 'YWJj [clipped]' } });
  expect(bad.isError).toBe(true); expect(await readFile(target)).toEqual(bytes);
});

it('UTF-8 tiny pages and large previews preserve codepoint boundaries', async () => {
  const h = await harness(), root = await temporary(), source = path.join(root, 'utf8');
  const data = '¢€😀'.repeat(5); await writeFile(source, data);
  for (const length of [1, 2, 3, 4, 7]) {
    let offset = 0, restored = '';
    while (offset < Buffer.byteLength(data)) {
      const r = await fsRead({ path: source, offset, length }); expect(r.data).not.toContain('\ufffd');
      expect(Buffer.byteLength(r.data)).toBe(r.bytesRead); expect(r.nextOffset).toBeGreaterThan(offset); restored += r.data; offset = r.nextOffset;
    }
    expect(restored).toBe(data);
  }
  const large = '¢€😀'.repeat(9000); await writeFile(source, large);
  const r: any = await h.client.callTool({ name: 'fs_read', arguments: { device: 'fixture', path: source, length: Buffer.byteLength(large) } });
  expect(r.structuredContent.data).not.toContain('\ufffd'); expect(Buffer.byteLength(r.structuredContent.data)).toBe(r.structuredContent.bytesRead);
  expect((await recover(h.client, r.structuredContent.resultRecovery.id)).structuredContent.data).toBe(large);
});

it('a 70k history command preserves ID, details and navigation to the next row', async () => {
  const h = await harness();
  const r: any = await h.client.callTool({ name: 'job_history', arguments: { device: 'fixture', limit: 1 } });
  expect(r.isError).not.toBe(true); expect(r.structuredContent.items[0]).toMatchObject({ id: 'first', commandTruncated: true }); expect(legacy(r)).toEqual(r.structuredContent);
  expect((await recover(h.client, r.structuredContent.resultRecovery.id)).structuredContent.items[0].command).toBe('😀'.repeat(70000));
  const next: any = await h.client.callTool({ name: 'job_history', arguments: { device: 'fixture', cursor: r.structuredContent.nextCursor } });
  expect(next.structuredContent.items[0].id).toBe('second'); expect(next.structuredContent.nextCursor).toBeNull();
});

it('final JSON Schema failure is typed, diagnosed and recoverable instead of hidden by Zod stripping', async () => {
  const server = new McpServer({ name: 'invalid-fixture', version: '1' }); const diagnostics = new ToolDiagnostics(); installDefaultToolOutputContracts(server, diagnostics);
  const { z } = await import('zod'); let effects = 0;
  server.registerTool('fixture_effect', { outputSchema: { count: z.number() } }, async () => { effects++; return { content: [{ type: 'text', text: '{}' }], structuredContent: { count: 1, undeclared: 'retained evidence' } }; });
  const client = new Client({ name: 'invalid-fixture', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]); close.push(async () => { await client.close(); await server.close(); }); await client.listTools();
  const r: any = await client.callTool({ name: 'fixture_effect', arguments: {} });
  expect(r.isError).toBe(true); expect(r.structuredContent.code).toBe('result_validation_failed');
  expect((await recover(client, r.structuredContent.resultRecovery.id)).structuredContent.undeclared).toBe('retained evidence'); expect(effects).toBe(1);
  expect(diagnostics.snapshot().series.find(s => s.tool === 'fixture_effect')).toMatchObject({ errors: 1, finalValidationFailures: 1 });
});

it('bounds a 10 MiB result in each stream while retaining exact owner-accessible output', async () => {
  const h = await harness();
  const r: any = await h.client.callTool({ name: 'exec', arguments: { device: 'fixture', command: 'huge' } });
  expect(r.isError).not.toBe(true); expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(TOTAL_RESULT_MAX_BYTES);
  expect(r.structuredContent).toMatchObject({ stdoutTruncated: true, stderrTruncated: true, stdoutBytes: 10 * 1024 * 1024, stderrBytes: 10 * 1024 * 1024 });
  expect(r.structuredContent.stdout).not.toContain('\ufffd'); expect(legacy(r)).toEqual(r.structuredContent);
  const full = await recover(h.client, r.structuredContent.resultRecovery.id);
  expect(full.structuredContent.stdout).toBe('😀'.repeat(2621440)); expect(full.structuredContent.stderr).toBe(full.structuredContent.stdout);
  expect(h.calls()).toBe(1);
}, 30000);

it('retains serialization-failure evidence and never leaves a settled callback marked running', async () => {
  const server = new McpServer({ name: 'serialization-fixture', version: '1' }); installDefaultToolOutputContracts(server);
  const { z } = await import('zod'); let effects = 0;
  server.registerTool('non_json_effect', { outputSchema: { id: z.string() } }, async () => { effects++; return { content: [{ type: 'text', text: '{}' }], structuredContent: { id: 'fixture-operation', invalid: 1n } }; });
  const client = new Client({ name: 'serialization-fixture', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]); close.push(async () => { await client.close(); await server.close(); }); await client.listTools();
  const r: any = await client.callTool({ name: 'non_json_effect', arguments: {} }); expect(r.isError).toBe(true);
  const retained = await recover(client, r.structuredContent.resultRecovery.id);
  expect(retained).toMatchObject({ serializationFailed: true, inspection: { structuredContent: { id: 'fixture-operation', invalid: { nonJsonType: 'bigint', decimal: '1' } } } }); expect(effects).toBe(1);
});

it('makes omitted legacy media explicit and retains the complete original result', async () => {
  const server = new McpServer({ name: 'media-fixture', version: '1' }); installDefaultToolOutputContracts(server);
  const { z } = await import('zod'); const payload = Buffer.alloc(300000, 42).toString('base64');
  server.registerTool('media_fixture', { outputSchema: { captured: z.boolean() } }, async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: payload }], structuredContent: { captured: true } }));
  const client = new Client({ name: 'media-fixture', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]); close.push(async () => { await client.close(); await server.close(); }); await client.listTools();
  const r: any = await client.callTool({ name: 'media_fixture', arguments: {} }); expect(r.isError).not.toBe(true); expect(r.structuredContent.contentTruncated).toBe(true);
  expect(legacy(r)).toEqual(r.structuredContent); expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(TOTAL_RESULT_MAX_BYTES);
  expect((await recover(client, r.structuredContent.resultRecovery.id)).content[0].data).toBe(payload);
});

it('recovery expiry, release, eviction and a new controller fail closed for old IDs', async () => {
  const { ResultRecoveryStore } = await import('../apps/mcp-server/src/result-recovery.ts');
  const { vi } = await import('vitest');
  const store = new ResultRecoveryStore(); const active = store.begin();
  const completed = store.begin(); store.finish(completed.id, { code: 0 });
  expect(() => store.begin(completed.id)).toThrow(/already used/);
  store.release(completed.id); expect(() => store.begin(completed.id)).toThrow(/unavailable/);
  expect(() => new ResultRecoveryStore().begin(active.id)).toThrow(/unavailable/);
  const pending = store.prepare(); const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + store.retentionMs + 1);
  try {
    expect(() => store.begin(pending.id)).toThrow(/unavailable/);
    expect(store.read(active.id)).toMatchObject({ state: 'running' });
  } finally { clock.mockRestore(); }
  store.finish(active.id, { code: 0 });
  for (let i = 0; i < store.maxEntries; i++) { const slot = store.begin(); store.finish(slot.id, { index: i }); }
  expect(() => store.begin(active.id)).toThrow(/unavailable/);
  const pinned = new ResultRecoveryStore(); for (let i = 0; i < pinned.maxEntries; i++) pinned.prepare();
  expect(() => pinned.begin()).toThrow(/No dispatch occurred/);
});

it('distinguishes verified cancellation and two active calls from undispatched slots', async () => {
  const abort = new AbortController(); let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const promise = settledExecution([0, 1, 2, 3], async (_, index) => {
    calls++; if (calls === 2) { abort.abort(); release(); }
    await gate;
    return index === 0 ? { ...receipt('cancel'), cancelled: true, terminationVerified: true } : receipt('cancel');
  }, 2, abort.signal);
  const results = await promise; expect(calls).toBe(2);
  expect(summarizeExecution(results)).toMatchObject({ total: 4, cancelled: 1, uncertain: 1, not_started: 2 });
});

it('discovers and recovers a rejected response even without a pre-reserved ID', async () => {
  let reject = true;
  const h = await harness(false, { jsonSchemaValidator: { getValidator: <T>() => (value: unknown) => reject ? { valid: false as const, errorMessage: 'Rejected whole response', data: undefined } : { valid: true as const, data: value as T, errorMessage: undefined } } });
  await expect(h.client.callTool({ name: 'exec', arguments: { device: 'fixture', command: 'small' } })).rejects.toThrow('Rejected whole response');
  reject = false;
  const index: any = await h.client.callTool({ name: 'result_recover', arguments: {} });
  expect(index.isError).not.toBe(true); expect(index.structuredContent.total).toBe(1);
  const entry = index.structuredContent.items[0]; expect(entry).toMatchObject({ state: 'complete', invocation: { tool: 'exec', requestIdHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(JSON.stringify(index)).not.toContain('stdout');
  expect((await recover(h.client, entry.id)).structuredContent.code).toBe(0); expect(h.calls()).toBe(1);
});

it('bounds the recovery index even when JSON escaping expands request IDs', async () => {
  const { ResultRecoveryStore } = await import('../apps/mcp-server/src/result-recovery.ts');
  const store = new ResultRecoveryStore();
  for (let i = 0; i < store.maxEntries; i++) {
    const slot = store.begin(undefined, { tool: 'batch_exec', requestId: '\u0000'.repeat(200) + i, sessionId: 'synthetic-session' });
    store.finish(slot.id, { code: 0 });
  }
  const index = store.list(); expect(index.total).toBe(64);
  expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(65536);
  expect(index.items[0]!.invocation!.requestId).toBeUndefined();
  expect(index.items[0]!.invocation!.requestIdHash).toMatch(/^[a-f0-9]{64}$/);
});
