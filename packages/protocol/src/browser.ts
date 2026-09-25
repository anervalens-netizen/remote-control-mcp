import { z } from "zod";
import { timeoutMsField } from "./deadline.ts";
const timeoutMs=timeoutMsField.optional();
export const browserSessionSchema=z.object({
  action:z.enum(["start","connect","list","status","close"]),
  sessionId:z.string().min(1).optional(),
  engine:z.enum(["chromium","firefox","webkit"]).optional(),
  channel:z.string().optional(),executablePath:z.string().optional(),headless:z.boolean().optional(),
  userDataDir:z.string().optional(),args:z.array(z.string()).optional(),
  endpoint:z.string().optional(),protocol:z.enum(["cdp","playwright"]).optional(),
  launchOptions:z.record(z.string(),z.unknown()).optional(),contextOptions:z.record(z.string(),z.unknown()).optional(),
  timeoutMs,
}).superRefine((v,c)=>{
  if(["status","close"].includes(v.action)&&!v.sessionId)c.addIssue({code:"custom",message:"sessionId is required"});
  if(v.action==="connect"&&!v.endpoint)c.addIssue({code:"custom",message:"endpoint is required"});
  if(v.action==="connect"&&v.protocol!=="playwright"&&v.engine&&v.engine!=="chromium")c.addIssue({code:"custom",message:"CDP requires engine=chromium; use protocol=playwright for Firefox/WebKit"});
});
export const browserLocatorSchema=z.object({
  selector:z.string().optional(),role:z.string().optional(),name:z.string().optional(),
  text:z.string().optional(),label:z.string().optional(),testId:z.string().optional(),
  exact:z.boolean().optional(),nth:z.number().int().optional(),frame:z.string().optional(),
});
export const browserStepSchema=z.object({
  action:z.enum(["pages","newPage","closePage","goto","back","forward","reload","snapshot","content","click","dblclick","fill","press","select","check","hover","wait","evaluate","screenshot","cdp","upload"]),
  pageId:z.string().optional(),locator:browserLocatorSchema.optional(),url:z.string().optional(),
  value:z.string().optional(),values:z.array(z.string()).optional(),checked:z.boolean().optional(),
  expression:z.string().optional(),arg:z.unknown().optional(),method:z.string().optional(),
  params:z.record(z.string(),z.unknown()).optional(),scope:z.enum(["page","browser"]).optional(),
  paths:z.array(z.string()).optional(),timeoutMs,
  waitUntil:z.enum(["commit","domcontentloaded","load","networkidle"]).optional(),
  state:z.enum(["attached","detached","visible","hidden"]).optional(),
  fullPage:z.boolean().optional(),path:z.string().optional(),depth:z.number().int().nonnegative().optional(),
  maxChars:z.number().int().min(-1).optional(),force:z.boolean().optional(),
}).superRefine((v,c)=>{
  const required=(ok:boolean,message:string)=>{if(!ok)c.addIssue({code:"custom",message})};
  if(v.action==="goto")required(!!v.url,"url is required for goto");
  if(v.action==="evaluate")required(!!v.expression,"expression is required for evaluate");
  if(v.action==="cdp")required(!!v.method,"method is required for cdp");
  if(["fill","press"].includes(v.action))required(v.value!==undefined,"value is required");
  if(v.action==="upload")required(!!v.paths,"paths is required for upload");
  if(v.action==="select")required(v.values!==undefined||v.value!==undefined,"value or values is required for select");
  if(["click","dblclick","fill","press","select","check","hover","wait","upload"].includes(v.action))required(!!v.locator&&(!!v.locator.selector||!!v.locator.role||v.locator.text!==undefined||v.locator.label!==undefined||v.locator.testId!==undefined),"locator requires selector, role, text, label or testId");
});
export const browserActionSchema=z.object({
  sessionId:z.string().min(1),pageId:z.string().optional(),
  actions:z.array(browserStepSchema).min(1),stopOnError:z.boolean().optional(),timeoutMs,
});
export type BrowserSessionInput=z.infer<typeof browserSessionSchema>;
export type BrowserActionInput=z.infer<typeof browserActionSchema>;
export type BrowserStep=z.infer<typeof browserStepSchema>;

// Receipts describe observed settlement, never proof that an interrupted step stopped.
export const browserActionResultSchema=z.object({
  sessionId:z.string(),executionId:z.string(),ok:z.boolean(),executed:z.number().int().nonnegative(),
  results:z.array(z.object({index:z.number().int().nonnegative(),action:z.string(),ok:z.boolean(),result:z.unknown().optional(),error:z.string().optional()})),
  pages:z.array(z.object({pageId:z.string(),url:z.string()})),
  status:z.enum(["queued","running","completed","failed","interrupted"]),
  activeStepIndex:z.number().int().nonnegative().nullable().describe("Zero-based index of the dispatched step whose promise is still pending, or null."),
  outcome:z.enum(["settled","not_started","outcome_unknown"]).describe("settled means dispatched promises returned or failed, not that failed actions had no effects; outcome_unknown means a dispatched step is still pending. Never replay automatically."),
  interruption:z.enum(["timeout","cancelled"]).optional(),error:z.string().optional(),
  receiptScope:z.enum(["agent","legacy-response-only"]).optional(),
  receiptSummary:z.boolean().optional(),retentionTruncated:z.boolean().optional(),retentionLimitBytes:z.number().int().positive().optional(),
});
export type BrowserActionResult=z.infer<typeof browserActionResultSchema>;
export const browserExecutionSchema=z.object({sessionId:z.string().min(1),executionId:z.string().min(1).optional()});
export const browserExecutionResultSchema=z.object({executions:z.array(browserActionResultSchema),retentionLimit:z.number().int(),retentionMs:z.number().int(),indexOnly:z.boolean().optional()});
