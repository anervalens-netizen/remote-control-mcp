import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { desktopSequence, desktopCancellation } from './desktop-sequence.ts';
import { semanticSession, loadSemanticManifest } from './semantic-desktop-env.ts';
import { semanticDesktop } from './semantic-desktop.ts';
import { captureDesktopFile } from './desktop-screenshot.ts';
import type { DesktopUiaInput, DesktopWindowsInput } from '../../../packages/protocol/src/desktop.ts';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const helperPath = fileURLToPath(new URL('./linux-desktop-helper.py', import.meta.url));
type Focus = { handle?: number | string; pid?: number; title?: string };
type Monitor = { deviceName: string; primary: boolean; bounds: { x: number; y: number; width: number; height: number }; scale: number };
async function context(allowLocked = false) {
  const session = await semanticSession();
  const { stdout: id } = await exec('loginctl', ['show-user', String(process.getuid!()), '-p', 'Display', '--value'], { timeout: 3000 });
  const { stdout } = await exec('loginctl', ['show-session', id.trim(), '-p', 'LockedHint', '--value'], { timeout: 3000 });
  const locked = stdout.trim() === 'yes';
  if (locked && !allowLocked) throw new Error('desktop_session_locked');
  return { ...session, locked, kde: /kde/i.test(session.env.XDG_CURRENT_DESKTOP ?? ''), wayland: session.env.XDG_SESSION_TYPE === 'wayland' || Boolean(session.env.WAYLAND_DISPLAY) };
}
async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return (await exec(command, args, { env, timeout: 15000, maxBuffer: 8 * 1024 * 1024, signal: desktopCancellation() })).stdout.trim();
}
async function helper(input: unknown, env: NodeJS.ProcessEnv): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helperPath], { env, stdio: ['pipe', 'pipe', 'pipe'], signal: desktopCancellation() });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 12000);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 8 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-1000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); try { const value = JSON.parse(stdout); if (code || value.ok === false) reject(new Error(value.error ?? 'linux_helper_failed')); else resolve(value); } catch (error) { reject(code ? new Error('linux_helper_failed: ' + stderr) : error); } });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
async function native(args: string[], env: NodeJS.ProcessEnv): Promise<any> {
  const manifest = loadSemanticManifest();
  let stdout: string;
  try { stdout = await run(manifest.binary, args, env); }
  catch (error) { stdout = (error as { stdout?: string }).stdout ?? ''; if (!stdout) throw error; }
  const value = JSON.parse(stdout);
  if (value.version !== manifest.jsonVersion || !value.ok) throw new Error(JSON.stringify(value.error ?? { code: 'native_contract_mismatch' }));
  return value.data;
}
export function parseKscreen(value: any): Monitor[] {
  return value.outputs.filter((o: any) => o.connected && o.enabled).map((o: any) => {
    const mode = o.modes.find((m: any) => m.id === o.currentModeId);
    if (!mode || !(o.scale > 0)) throw new Error('display_geometry_unavailable');
    const rotated = o.rotation === 2 || o.rotation === 8;
    return { deviceName: o.name, primary: o.priority === 1, scale: o.scale, bounds: { x: o.pos.x, y: o.pos.y, width: (rotated ? mode.size.height : mode.size.width) / o.scale, height: (rotated ? mode.size.width : mode.size.height) / o.scale } };
  });
}
async function monitors(): Promise<Monitor[]> {
  const c = await context(true);
  if (c.kde) return parseKscreen(JSON.parse(await run('kscreen-doctor', ['-j'], c.env)));
  const rows = await native(['list-displays'], c.env);
  return rows.map((d: any) => ({ deviceName: d.id, primary: d.is_primary, bounds: d.bounds, scale: d.scale }));
}
export const linuxMonitors = () => desktopSequence(monitors);
async function windows(input: DesktopWindowsInput = {}) {
  const c = await context();
  let rows: any[];
  if (c.kde) rows = await helper({ operation: 'windows' }, c.env);
  else rows = (await native(['list-windows'], c.env)).map((w: any) => ({ ...w, handle: w.id, title: w.title ?? w.name ?? '', pid: w.pid ?? 0 }));
  return rows.filter(w => (input.includeHidden || !w.hidden) && (input.pid === undefined || w.pid === input.pid) && (input.title === undefined || w.title.includes(input.title)));
}
export const linuxWindows = (input: DesktopWindowsInput = {}) => desktopSequence(() => windows(input));
async function selected(input: Focus) {
  const rows = (await windows({ includeHidden: true, pid: input.pid, title: input.title })).filter(w => input.handle === undefined || String(w.handle) === String(input.handle));
  if (rows.length !== 1) throw new Error('window_selector_not_unique');
  return rows[0];
}
export const linuxFocus = (input: Focus) => desktopSequence(async () => {
  const c = await context(), target = await selected(input);
  if (c.kde) {
    await helper({ operation: 'focus', handle: target.handle }, c.env);
    for (let i = 0; i < 10; i++) {
      const current = (await windows()).find(w => w.active);
      if (current?.handle === target.handle) return { ok: true, handle: target.handle, foregroundHandle: current.handle };
      await delay(50);
    }
    throw new Error('focus_delivery_unverified');
  }
  const result = await native(['focus-window', '--window-id', String(target.handle), '--headed'], c.env);
  return { ...result, ok: true, handle: target.handle, foregroundHandle: target.handle };
});
async function position(c: Awaited<ReturnType<typeof context>>) {
  if (c.kde) return helper({ operation: 'position' }, c.env);
  if (c.wayland) throw new Error('pointer_position_requires_supported_compositor');
  const data = Object.fromEntries((await run('xdotool', ['getmouselocation', '--shell'], c.env)).split('\n').map(s => s.split('=')));
  return { x: Number(data.X), y: Number(data.Y) };
}
export const linuxMouse = (input: { action: string; x?: number; y?: number; button?: string; delta?: number }) => desktopSequence(async () => {
  const c = await context();
  if (input.action === 'position') return { ok: true, ...await position(c) };
  if (input.x !== undefined) {
    const displays = await monitors();
    if (!displays.some(m => input.x! >= m.bounds.x && input.x! < m.bounds.x + m.bounds.width && input.y! >= m.bounds.y && input.y! < m.bounds.y + m.bounds.height)) throw new Error('coordinates_outside_desktop');
    if (c.wayland && c.kde) await helper({ backend: 'eis', operation: 'move', x: input.x, y: input.y }, c.env);
    else if (!c.wayland) await run('xdotool', ['mousemove', '--sync', '--', String(input.x), String(input.y)], c.env);
    else throw new Error('physical_input_requires_supported_compositor');
    const actual = await position(c);
    if (Math.abs(actual.x - input.x) > 2 || Math.abs(actual.y - input.y!) > 2) throw new Error('pointer_move_unverified_no_click_delivered');
  }
  if (input.action === 'click' || input.action === 'doubleClick') {
    const count = input.action === 'doubleClick' ? 2 : 1;
    if (c.wayland && c.kde) await helper({ backend: 'eis', operation: 'click', button: { left: 272, right: 273, middle: 274 }[input.button ?? 'left'], count }, c.env);
    else if (!c.wayland) await run('xdotool', ['click', '--repeat', String(count), '--delay', '80', { left: '1', middle: '2', right: '3' }[input.button ?? 'left']!], c.env);
    else throw new Error('physical_input_requires_supported_compositor');
  } else if (input.action === 'scroll') {
    const delta = input.delta ?? 120;
    if (c.wayland && c.kde) await helper({ backend: 'eis', operation: 'scroll', delta: -delta }, c.env);
    else if (!c.wayland && delta) await run('xdotool', ['click', '--repeat', String(Math.max(1, Math.round(Math.abs(delta) / 120))), delta > 0 ? '4' : '5'], c.env);
    else if (c.wayland) throw new Error('physical_input_requires_supported_compositor');
  }
  return { ok: true, ...await position(c), delivery: 'delivered_unverified' };
});
const codes: Record<string, number> = { escape: 1, esc: 1, backspace: 14, tab: 15, enter: 28, return: 28, ctrl: 29, control: 29, shift: 42, alt: 56, space: 57, capslock: 58, home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109, insert: 110, delete: 111, del: 111, super: 125, win: 125, meta: 125, cmd: 125 };
for (const [letters, start] of [['qwertyuiop', 16], ['asdfghjkl', 30], ['zxcvbnm', 44]] as const) [...letters].forEach((key, i) => { codes[key] = start + i; });
for (let i = 1; i <= 9; i++) codes[String(i)] = i + 1;
codes['0'] = 11;
for (let i = 1; i <= 12; i++) codes['f' + i] = i <= 10 ? 58 + i : 76 + i;
export function keyCodes(keys: string[]) { return keys.map(key => { const code = codes[key.toLowerCase()]; if (code === undefined) throw new Error('unsupported_key: ' + key); return code; }); }
export const linuxKeyboard = (input: { action: string; text?: string; keys?: string[] }) => desktopSequence(async () => {
  const c = await context();
  if (input.action === 'type') {
    if (input.text?.includes('\0')) throw new Error('nul_text_unsupported');
    if (c.wayland && c.kde) await helper({ backend: 'eis', operation: 'type', text: input.text }, c.env);
    else if (!c.wayland) await run('xdotool', ['type', '--delay', '1', '--', input.text!], c.env);
    else throw new Error('physical_input_requires_supported_compositor');
  } else {
    const keys = input.keys!;
    if (c.wayland && c.kde) {
      const all = keyCodes(keys); // Validate every key before sending any input.
      for (const chord of input.action === 'hotkey' ? [all] : all.map(k => [k])) await helper({ backend: 'eis', operation: 'keys', codes: chord }, c.env);
    } else if (!c.wayland) {
      keyCodes(keys);
      const aliases: Record<string, string> = { enter: 'Return', return: 'Return', escape: 'Escape', esc: 'Escape', ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', win: 'super', super: 'super', meta: 'super', cmd: 'super', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', tab: 'Tab', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', insert: 'Insert', capslock: 'Caps_Lock' };
      const names = keys.map(k => aliases[k.toLowerCase()] ?? (/^f\d+$/i.test(k) ? k.toUpperCase() : k.toLowerCase()));
      await run('xdotool', ['key', '--', ...(input.action === 'hotkey' ? [names.join('+')] : names)], c.env);
    } else throw new Error('physical_input_requires_supported_compositor');
  }
  return { ok: true, keys: input.keys, delivery: 'delivered_unverified' };
});
export const linuxClipboardGet = () => desktopSequence(async () => {
  const c = await context();
  const result = await native(['clipboard-get'], c.env);
  return { text: typeof result === 'string' ? result : result.text ?? '' };
});
export const linuxClipboardSet = (input: { text: string }) => desktopSequence(async () => {
  const c = await context();
  await native(['clipboard-set', '--', input.text], c.env);
  const readback = await linuxClipboardGet();
  if (readback.text !== input.text) throw new Error('clipboard_write_unverified');
  return { ok: true as const, chars: input.text.length };
});
export const linuxSession = () => desktopSequence(async () => {
  let c: Awaited<ReturnType<typeof context>> | undefined;
  try { c = await context(true); } catch {}
  return { agentPid: process.pid, agentSessionId: null, activeConsoleSessionId: null, interactiveSession: Boolean(c), inputDesktop: { accessible: Boolean(c && !c.locked), name: c ? (c.wayland ? 'wayland' : 'x11') : null, error: null }, consentProcesses: [], secureDesktopLikely: c?.locked ?? false, uacPromptPossible: false, captureMayMissSecureDesktop: true, captureBoundaryNote: 'Linux owner session; lock screens are not automated. Wayland physical input requires a supported compositor.', platform: 'linux', compositor: c?.kde ? 'KWin' : 'other' };
});
export const linuxHelperStatus = () => ({ enabled: true, transport: 'oneshot' as const, running: false, pid: null as number | null, busy: false, starts: 0, completed: 0, lastError: null as string | null, backend: 'linux-owner-session', persistentHelperRequired: false });
export const linuxScreenshot = (input: { monitor?: number | 'all'; scale?: number }) => desktopSequence(async () => {
  const c = await context();
  const displays = await monitors();
  if (!displays.length) throw new Error('no_active_displays');
  const ordered = [...displays].sort((a, b) => Number(b.primary) - Number(a.primary));
  const chosen = input.monitor === 'all' ? null : ordered[input.monitor ?? 0];
  if (input.monitor !== 'all' && !chosen) throw new Error('monitor_index_out_of_range');
  const x = Math.min(...displays.map(d => d.bounds.x)), y = Math.min(...displays.map(d => d.bounds.y));
  const w = Math.max(...displays.map(d => d.bounds.x + d.bounds.width)) - x, h = Math.max(...displays.map(d => d.bounds.y + d.bounds.height)) - y;
  if (new Set(displays.map(d => d.scale)).size > 1) throw new Error('mixed_scale_capture_geometry_requires_qualification');
  return captureDesktopFile(async destination => {
    if (c.kde) await run('spectacle', ['--background', '--nonotify', '--fullscreen', '--output', destination], c.env);
    else await native(['screenshot', destination, '--screen', String(input.monitor ?? 0)], c.env);
    const raw = await readFile(destination), meta = await sharp(raw).metadata();
    if (!meta.width || !meta.height) throw new Error('screenshot_dimensions_missing');
    const ratio = meta.width / w;
    if (Math.abs(meta.height / h - ratio) > .02) throw new Error('capture_coordinate_mapping_unproven');
    const bounds = chosen?.bounds ?? { x, y, width: w, height: h };
    const crop = { left: Math.round((bounds.x - x) * ratio), top: Math.round((bounds.y - y) * ratio), width: Math.round(bounds.width * ratio), height: Math.round(bounds.height * ratio) };
    const width = Math.max(1, Math.round(crop.width * (input.scale ?? 1))), height = Math.max(1, Math.round(crop.height * (input.scale ?? 1)));
    await writeFile(destination, await sharp(raw).extract(crop).resize(width, height).png().toBuffer());
    return { originX: bounds.x, originY: bounds.y, sourceWidth: bounds.width, sourceHeight: bounds.height, width, height, scale: width / bounds.width, coordinateSpace: 'desktop-logical', platform: 'linux' };
  });
});
export const linuxLaunch = (input: { target: string; arguments?: string[]; waitForWindowMs?: number; requireWindow?: boolean }) => desktopSequence(async () => {
  const c = await context();
  const child = spawn(input.target, input.arguments ?? [], { env: c.env, detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  let found: any;
  const deadline = Date.now() + (input.waitForWindowMs ?? (input.requireWindow ? 3000 : 0));
  while (Date.now() < deadline) { found = (await windows({ pid: child.pid })).find(w => !w.hidden); if (found) break; await delay(100); }
  const verified = !input.requireWindow || Boolean(found);
  return { ok: verified, launchAccepted: true, verified, verificationStatus: found ? 'window_observed' : input.requireWindow ? 'window_not_observed' : 'process_started', target: input.target, pid: child.pid, window: found ?? null };
});
export const linuxBrowser = (input: { url: string; browser?: string; newWindow?: boolean }) => desktopSequence(async () => {
  const c = await context();
  if (!['http:', 'https:'].includes(new URL(input.url).protocol)) throw new Error('browser_requires_http_url');
  const candidates: Record<string, string[]> = { chrome: ['google-chrome', 'chromium'], edge: ['microsoft-edge'], brave: ['brave-browser', 'brave'], firefox: ['firefox'], auto: ['firefox', 'google-chrome', 'chromium', 'brave-browser'] };
  let executable: string | undefined;
  for (const candidate of candidates[input.browser ?? 'auto'] ?? []) { try { executable = await run('which', [candidate], c.env); break; } catch {} }
  if (!executable) throw new Error('supported_browser_not_found');
  await linuxLaunch({ target: executable, arguments: [executable.includes('firefox') ? (input.newWindow === false ? '--new-tab' : '--new-window') : (input.newWindow === false ? '--new-tab' : '--new-window'), input.url] });
  return { ok: true as const, browser: input.browser ?? 'auto', executable, url: input.url, pageLoadVerified: false };
});
export const linuxUia = (input: DesktopUiaInput) => desktopSequence(async () => {
  if (input.action === 'pattern') throw new Error('windows_uia_patterns_not_available_use_semantic_actions');
  if (input.elementId) {
    const [observationId, ref] = input.elementId.split('/');
    if (!observationId || !ref) throw new Error('invalid_linux_element_id');
    if (input.action === 'inspect') {
      const read = await semanticDesktop.observe({ kind: 'get', observationId, ref, property: 'value' });
      if (!read.ok) return read;
      return { element: { elementId: input.elementId, value: read.data }, backend: 'at-spi' };
    }
    const actions: Record<string, string> = { invoke: 'click', setValue: 'set-value', focus: 'focus', select: 'select', toggle: 'toggle', expand: 'expand', collapse: 'collapse' };
    if (!input.action || !actions[input.action]) throw new Error('unsupported_linux_uia_action');
    return semanticDesktop.act({ commandId: randomUUID(), observationId, ref, action: actions[input.action], value: input.value, headed: input.action === 'focus', observeAfter: false });
  }
  if (input.action && input.action !== 'query') throw new Error('linux_uia_requires_element_id');
  let windowId: string | undefined;
  if (input.handle !== undefined) {
    const target = await selected({ handle: input.handle });
    const c = await context();
    const nativeWindows = await native(['list-windows'], c.env);
    const candidates = nativeWindows.filter((w: any) => w.pid === target.pid && (w.title ?? w.name) === target.title);
    if (candidates.length !== 1) throw new Error('accessibility_window_selector_not_unique');
    windowId = candidates[0].id;
  }
  const obs = await semanticDesktop.observe({ kind: 'snapshot', windowId, skeleton: false, interactiveOnly: false, maxDepth: Math.max(1, Math.min(input.depth ?? 3, 30)) });
  if (!obs.ok) return obs;
  const elements: any[] = [];
  function walk(value: any) { if (!value || typeof value !== 'object') return; if (value.ref_id) { const row = { elementId: `${obs.observationId}/${value.ref_id}`, controlType: value.role, name: value.name, value: typeof value.value === 'string' && input.textLimit !== -1 ? value.value.slice(0, input.textLimit ?? 1000) : value.value, states: value.states, bounds: value.bounds, automationId: value.automation_id }; if ((!input.name || String(row.name ?? '').includes(input.name)) && (!input.controlType || String(row.controlType).toLowerCase() === input.controlType.toLowerCase()) && (!input.automationId || row.automationId === input.automationId)) elements.push(row); } Object.values(value).forEach(child => { if (typeof child === 'object') walk(child); }); }
  walk(obs.data);
  const offset = input.offset ?? 0, limit = Math.min(input.limit ?? 100, 1000);
  return { elements: elements.slice(offset, offset + limit), total: elements.length, offset, nextOffset: offset + limit < elements.length ? offset + limit : null, observationId: obs.observationId, backend: 'at-spi', complete: obs.data?.complete ?? false };
});
