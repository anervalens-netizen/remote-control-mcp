import { executionSummarySchema } from "../../../packages/protocol/src/execution-outcome.ts";
import { z } from "zod";
import { createRequire } from "node:module";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
// SDK 1.30's AJV declaration uses an incompatible default-import namespace with
// NodeNext. Keep that third-party typing defect isolated; use its real validator.
const { AjvJsonSchemaValidator } = createRequire(import.meta.url)("@modelcontextprotocol/sdk/validation/ajv") as { AjvJsonSchemaValidator: new () => jsonSchemaValidator };
import { resultMetadataFields, recoveryReferenceSchema } from "./result-recovery.ts";

const jsonValidator = new AjvJsonSchemaValidator();
const failure = z.object({ ok: z.literal(false), error: z.string() }).passthrough();
const contracts = new WeakMap<object, z.ZodType>();

/** The SDK expects an object root, while clients may also validate isError
 * structured content. Advertise the same success/error alternatives that the
 * runtime validates, without weakening any required success fields. */
export function withErrorOutputContract(input: z.ZodType | z.ZodRawShape): z.ZodType {
  const cached = contracts.get(input);
  if (cached) return cached;
  const success = typeof (input as z.ZodType).safeParse === "function" ? input as z.ZodType : z.object(input as z.ZodRawShape);
  const omitted = z.object({ resultOmitted: z.literal(true), summary: executionSummarySchema.optional(), ...resultMetadataFields, resultRecovery: recoveryReferenceSchema });
  const alternatives = z.union([success, failure, omitted]);
  const json = z.toJSONSchema(alternatives, { target: "draft-07" });
  if (!Array.isArray(json.anyOf)) throw new Error("Success/error JSON Schema must retain explicit alternatives");
  const metadata = z.toJSONSchema(z.object(resultMetadataFields), { target: "draft-07" }).properties;
  const addMetadata = (node: any) => {
    if (node.type === "object" || node.properties) node.properties = { ...node.properties, ...metadata };
    for (const alternative of node.anyOf ?? []) addMetadata(alternative);
    for (const alternative of node.oneOf ?? []) addMetadata(alternative);
  };
  for (const alternative of json.anyOf) addMetadata(alternative);
  let validate: ReturnType<jsonSchemaValidator["getValidator"]> | undefined;
  const schema = z.object({}).passthrough().superRefine((value, context) => {
    // Registration and schema advertisement need no compiled validator. Compile
    // synchronously on the first result, then reuse it for this cached contract.
    validate ??= jsonValidator.getValidator(json as any);
    if (!alternatives.safeParse(value).success || !validate(value).valid) context.addIssue({ code: "custom", message: "Result must match its success contract or an explicit error receipt" });
  }).meta({ ...json, type: "object" });
  contracts.set(input, schema);
  return schema;
}
