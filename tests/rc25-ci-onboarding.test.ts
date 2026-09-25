import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const expressions = [...workflow.matchAll(/runs-on:\s*\$\{\{\s*(.+?)\s*\}\}/g)].map(match => match[1]!);
const interactive = workflow.match(/RCMCP_TEST_INTERACTIVE:\s*\$\{\{\s*(.+?)\s*\}\}/)?.[1];
const cases = [
  { event: 'push default', input: undefined, variable: undefined, gaming: false },
  { event: 'pull request hosted switch', input: undefined, variable: 'github', gaming: false },
  { event: 'pull request gaming switch', input: undefined, variable: 'gaming', gaming: true },
  { event: 'dispatch auto default', input: 'auto', variable: undefined, gaming: false },
  { event: 'dispatch auto gaming', input: 'auto', variable: 'gaming', gaming: true },
  { event: 'dispatch github overrides gaming', input: 'github', variable: 'gaming', gaming: false },
  { event: 'dispatch gaming overrides hosted', input: 'gaming', variable: 'github', gaming: true },
  { event: 'invalid switch uses hosted', input: undefined, variable: 'unavailable', gaming: false },
];

describe('RC25 CI scheduling and truthful platform coverage', () => {
  it.each(cases)('$event', ({ input, variable, gaming }) => {
    // Evaluate only the repository's simple, reviewed Actions scheduling expressions.
    const context = { inputs: { runner: input ?? '' }, vars: { RCMCP_CI_RUNNER: variable ?? '' }, fromJSON: JSON.parse };
    expect(expressions).toHaveLength(2);
    const selected = expressions.map(expression => runInNewContext(expression, context, { timeout: 100 }));
    if (gaming) {
      expect(selected[0]).toEqual(['self-hosted', 'Linux', 'X64', 'gaming-ci', 'remote-control-mcp']);
      expect(selected[1]).toEqual(['self-hosted', 'Windows', 'X64', 'gaming-ci', 'remote-control-mcp', 'gaming-native']);
    } else {
      expect(selected).toEqual(['ubuntu-latest', 'windows-latest']);
    }
    expect(interactive).toBeDefined();
    expect(runInNewContext(interactive!, context, { timeout: 100 })).toBe(gaming ? '1' : '0');
  });
  it('explains Android baseline versus optional shell accurately', () => {
    const activity = readFileSync(new URL('../apps/android-companion/app/src/main/java/eu/astancu/rcmcp/android/MainActivity.java', import.meta.url), 'utf8');
    expect(activity).toContain('Baseline control needs no ADB or Shizuku');
    expect(activity).toContain('Optional shell uses Shizuku');
    expect(activity).not.toContain('No ADB, shell bridge, or MediaProjection is used');
    expect(activity).toContain('Enable Shizuku shell');
  });
});
