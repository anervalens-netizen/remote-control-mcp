import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Keep arbitrarily large PNGs outside the bounded PowerShell JSON frame. */
export async function captureDesktopFile(capture: (destination: string) => Promise<unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rcmcp-shot-'));
  const output = path.join(dir, 'shot.png');
  try {
    const metadata = await capture(output) as Record<string, unknown>;
    const data = await readFile(output);
    return { ...metadata, mimeType: 'image/png', data: data.toString('base64'), bytes: data.length };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
