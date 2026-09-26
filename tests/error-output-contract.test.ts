import { expect, it } from 'vitest';
import { z } from 'zod';
import { withErrorOutputContract } from '../apps/mcp-server/src/error-output-contract.ts';
import { toolResultSchemas } from '../apps/mcp-server/src/semantic-result-schemas.ts';
it('preserves required success fields and accepts explicit structured failures',()=>{
 const contract=withErrorOutputContract(toolResultSchemas.job_start);
 expect(contract.safeParse({}).success).toBe(false);
 expect(contract.safeParse({id:'fixture'}).success).toBe(false);
 expect(contract.safeParse({ok:true,error:'not a failure'}).success).toBe(false);
 expect(contract.safeParse({ok:false,error:'failure',code:'job_start_uncertain'}).success).toBe(true);
 const json=z.toJSONSchema(contract);
 expect(json.type).toBe('object');expect(json.anyOf).toHaveLength(2);
 expect(JSON.stringify(json.anyOf)).toContain('required');
 expect(withErrorOutputContract(toolResultSchemas.job_start)).toBe(contract);
});
it('accepts raw Zod output shapes without losing their validation',()=>{
 const contract=withErrorOutputContract({count:z.number().int().nonnegative()});
 expect(contract.safeParse({count:1}).success).toBe(true);
 expect(contract.safeParse({count:-1}).success).toBe(false);
 expect(contract.safeParse({ok:false,error:'failure'}).success).toBe(true);
});
