import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { scrubErrorEvent } from '../apps/mcp-server/src/error-reporting.js';
test('removes sensitive payloads and preserves actionable stack and correlation', () => {
 const event: Parameters<typeof scrubErrorEvent>[0] = {type:undefined,message:'private',request:{data:'private'},user:{email:'private'},extra:{command:'private'},contexts:{custom:{secret:'private'}},breadcrumbs:[{message:'private'}],transaction:'private',tags:{application:'test',component:'backend','glitchtip.synthetic':'true','validation.run':'test',token:'private'},exception:{values:[{type:'Error',value:'private',stacktrace:{frames:[{filename:'app.js',function:'handler',lineno:12,vars:{secret:'private'},pre_context:['private'],post_context:['private'],context_line:'private'}]}}]}};
 const result = scrubErrorEvent(event);
 assert.ok(!JSON.stringify(result).includes('"private"'));
 assert.equal(result.exception?.values?.[0]?.stacktrace?.frames?.[0]?.lineno,12);
 assert.equal(result.tags?.['glitchtip.synthetic'],'true');
});
