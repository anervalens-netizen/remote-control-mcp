import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
describe('public CI isolation and truthful platform coverage', () => {
  it('keeps every public trigger hosted and reports omitted interactive coverage truthfully', () => {
    const hosts=[...workflow.matchAll(/^    runs-on: (.+)$/gm)].map(match=>match[1]!);
    expect(hosts).toHaveLength(2);
    expect(hosts[0]).toBe('ubuntu-latest');
    expect(workflow).not.toContain('vars.CI_EXECUTOR');
    expect(workflow).not.toContain('self-hosted');
    expect(hosts[1]).toBe('windows-latest');
    expect(workflow).not.toContain('inputs.runner');
    expect(workflow).not.toContain('vars.RCMCP_CI_RUNNER');
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).toMatch(/RCMCP_TEST_INTERACTIVE: '0'/);
    expect(workflow).toContain('Hosted Windows compatibility matrix: targeted native non-interactive');
    expect(workflow).toContain('full Windows suite are explicitly not certified here');
    expect(workflow).toContain('full native + interactive qualification runs separately on Gaming');
  });
  it('keeps untrusted pull requests on hosted runners and resolves actions to full commits', () => {
    const dir=new URL('../.github/workflows/',import.meta.url);
    for(const file of readdirSync(dir).filter(name=>name.endsWith('.yml'))){
      const source=readFileSync(new URL(file,dir),'utf8');
      expect(source,file).not.toContain('pull_request_target');
      const hosts=[...source.matchAll(/runs-on: (.+)$/gm)].map(match=>match[1]!);
      expect(hosts.length,file).toBeGreaterThan(0);
      for(const host of hosts) expect(['ubuntu-latest','windows-latest'],file).toContain(host);
      for(const action of source.matchAll(/uses: [\w.-]+\/[\w.-]+@([^\s]+)/g))expect(action[1],file).toMatch(/^[a-f0-9]{40}$/);
    }
  });
  it('fetches complete history and tests the publication checker independently', () => {
    const boundary=readFileSync(new URL('../.github/workflows/public-source.yml',import.meta.url),'utf8');
    expect(boundary).toContain('fetch-depth: 0');
    expect(boundary).toContain('github.event.pull_request.head.sha || github.sha');
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
