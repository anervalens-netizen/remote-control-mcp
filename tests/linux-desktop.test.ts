import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { AgentClient } from '../apps/mcp-server/src/agent-client.ts';
import { keyCodes, parseKscreen } from '../apps/agent/src/linux-desktop.ts';
import { desktopFocusSchema } from '../packages/protocol/src/desktop.ts';
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
it('uses logical display coordinates and rotation, excluding disabled outputs', () => {
  const monitor = { connected: true, enabled: true, name: 'Display-A', currentModeId: 'mode', scale: 2, rotation: 2, priority: 1, pos: { x: -600, y: 0 }, modes: [{ id: 'mode', size: { width: 1920, height: 1200 } }] };
  expect(parseKscreen({ outputs: [monitor, { ...monitor, enabled: false }] })).toEqual([{ deviceName: 'Display-A', primary: true, scale: 2, bounds: { x: -600, y: 0, width: 600, height: 960 } }]);
  expect(() => parseKscreen({ outputs: [{ ...monitor, currentModeId: 'missing' }] })).toThrow('geometry');
});
it('validates a complete chord and preserves Linux string window identities', () => {
  expect(keyCodes(['CTRL', 'a'])).toEqual([29, 30]);
  expect(() => keyCodes(['ctrl', 'unsupported'])).toThrow('unsupported_key');
  expect(desktopFocusSchema.parse({ handle: '{synthetic-window}' })).toEqual({ handle: '{synthetic-window}' });
});
async function fixture(platform: string, capable: boolean, explicit = false) {
  const calls: string[] = [];
  const app = Fastify();
  app.get('/v1/info', async () => { calls.push('info'); return { runtime: { platform, capabilities: capable ? ['linux-desktop-v1'] : [] } }; });
  app.get('/v1/desktop/monitors', async () => { calls.push('monitors'); return []; });
  const url = await app.listen({ host: '127.0.0.1', port: 0 }); close.push(() => app.close());
  const client = new AgentClient([{ name: 'fixture', url: 'http://127.0.0.1:1', userUrl: url, ...(explicit ? { desktopUrl: url } : {}) }]);
  return { calls, client };
}
it('routes Linux desktop tools to the verified owner capability, never root', async () => {
  const { client, calls } = await fixture('linux', true);
  expect(await client.desktopMonitors('fixture')).toEqual([]);
  expect(calls).toEqual(['info', 'monitors']);
});
it.each([['win32', true], ['linux', false]])('rejects owner fallback for %s capability=%s', async (platform, capability) => {
  const { client, calls } = await fixture(platform as string, capability as boolean);
  await expect(client.desktopMonitors('fixture')).rejects.toThrow('capability is unavailable');
  expect(calls).toEqual(['info']);
});
it('preserves an explicitly configured Windows desktop route without probing another identity', async () => {
  const { client, calls } = await fixture('win32', false, true);
  expect(await client.desktopMonitors('fixture')).toEqual([]);
  expect(calls).toEqual(['monitors']);
});
