import { expect, it } from 'vitest';
import { z } from 'zod';
import { withErrorOutputContract } from '../apps/mcp-server/src/error-output-contract.ts';
import { compactStructuredContent, STRUCTURED_CONTENT_MAX_BYTES } from '../apps/mcp-server/src/tool-contract-defaults.ts';
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

it('compacts oversized errors without dropping their required failure fields',()=>{
 const contract=withErrorOutputContract(toolResultSchemas.job_start);
 const result=compactStructuredContent({ok:false,error:'synthetic failure '.repeat(12000),code:'job_start_uncertain',jobId:'00000000-0000-4000-8000-000000000001'},STRUCTURED_CONTENT_MAX_BYTES,contract);
 expect(contract.safeParse(result).success).toBe(true);
 expect(result).toMatchObject({ok:false,code:'job_start_uncertain',jobId:'00000000-0000-4000-8000-000000000001',structuredContentTruncated:true});
 expect(typeof result.error).toBe('string');
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(STRUCTURED_CONTENT_MAX_BYTES);
});
