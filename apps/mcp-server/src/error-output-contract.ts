import { z } from "zod";

const failure = z.object({ ok: z.literal(false), error: z.string() }).passthrough();
const contracts = new WeakMap<object, z.ZodType>();

/** The SDK expects an object root, while clients may also validate isError
 * structured content. Advertise the same success/error alternatives that the
 * runtime validates, without weakening any required success fields. */
export function withErrorOutputContract(input: z.ZodType | z.ZodRawShape): z.ZodType {
  const cached = contracts.get(input);
  if (cached) return cached;
  const success = typeof (input as z.ZodType).safeParse === "function" ? input as z.ZodType : z.object(input as z.ZodRawShape);
  const alternatives = z.union([success, failure]);
  const json = z.toJSONSchema(alternatives, { target: "draft-07" });
  if (!Array.isArray(json.anyOf)) throw new Error("Success/error JSON Schema must retain explicit alternatives");
  const schema = z.object({}).passthrough().superRefine((value, context) => {
    if (!alternatives.safeParse(value).success) context.addIssue({ code: "custom", message: "Result must match its success contract or an explicit error receipt" });
  }).meta({ ...json, type: "object" });
  contracts.set(input, schema);
  return schema;
}
