import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
describe('public CI isolation and truthful platform coverage', () => {
  it('pins both CI execution hosts independently of inputs and repository variables', () => {
    expect([...workflow.matchAll(/^    runs-on: (.+)$/gm)].map(match=>match[1])).toEqual(['ubuntu-latest','windows-latest']);
    expect(workflow).not.toContain('inputs.runner');
    expect(workflow).not.toContain('vars.RCMCP_CI_RUNNER');
    expect(workflow).not.toContain('self-hosted');
    expect(workflow).toMatch(/RCMCP_TEST_INTERACTIVE: '0'/);
    expect(workflow).toContain('Interactive UIA/desktop tests explicitly skipped (not passed)');
  });
  it('keeps every public workflow hosted and resolves actions to full commits', () => {
    const dir=new URL('../.github/workflows/',import.meta.url);
    for(const file of readdirSync(dir).filter(name=>name.endsWith('.yml'))){
      const source=readFileSync(new URL(file,dir),'utf8');
      const hosts=[...source.matchAll(/runs-on: (.+)$/gm)].map(match=>match[1]);
      expect(hosts.length,file).toBeGreaterThan(0);
      for(const host of hosts)expect(['ubuntu-latest','windows-latest'],file).toContain(host);
      for(const action of source.matchAll(/uses: [\w.-]+\/[\w.-]+@([^\s]+)/g))expect(action[1],file).toMatch(/^[a-f0-9]{40}$/);
    }
  });
  it('fetches complete history and tests the publication checker independently', () => {
    const boundary=readFileSync(new URL('../.github/workflows/public-source.yml',import.meta.url),'utf8');
    expect(boundary).toContain('fetch-depth: 0');
    expect(boundary).toContain('persist-credentials: false');
    expect(boundary).toContain('node .github/test-public-history.mjs');
    expect(boundary).toContain('node .github/check-public-data.mjs --history HEAD');
  });
  it('explains Android baseline versus optional shell accurately', () => {
    const activity=readFileSync(new URL('../apps/android-companion/app/src/main/java/eu/astancu/rcmcp/android/MainActivity.java',import.meta.url),'utf8');
    expect(activity).toContain('Baseline control needs no ADB or Shizuku');
    expect(activity).toContain('Optional shell uses Shizuku');
    expect(activity).not.toContain('No ADB, shell bridge, or MediaProjection is used');
    expect(activity).toContain('Enable Shizuku shell');
  });
});
