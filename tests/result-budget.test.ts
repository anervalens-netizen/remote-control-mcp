import { expect, it } from 'vitest';
import { assertAggregateBudget } from '../apps/mcp-server/src/result-budget.ts';
import { fsReadFields } from '../packages/protocol/src/execution.ts';
import { fsRead } from '../apps/agent/src/filesystem.ts';

it('rejects the maximum legacy batch before serialization or effects', () => {
  expect(() => assertAggregateBudget(Array(64).fill(2 * 4 * 1024 * 1024))).toThrow(/no dispatch/);
  expect(() => assertAggregateBudget([8192, 8192])).not.toThrow();
  expect(() => assertAggregateBudget([100], 17583)).toThrow();
  expect(assertAggregateBudget([100], 17584)).toBe(17584);
});
it('bounds file pages in both protocol and agent entrypoint', async () => {
  expect(fsReadFields.length.safeParse(1024 ** 3).success).toBe(false);
  await expect(fsRead({ path: 'never-opened', length: 1024 ** 3 })).rejects.toThrow(/page budget/);
});
