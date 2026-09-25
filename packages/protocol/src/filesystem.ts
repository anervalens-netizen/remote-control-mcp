import { z } from "zod";
import { timeoutMsField } from "./deadline.ts";

// Internal transfer operations use the authenticated filesystem route; public
// fs_manage remains the existing six-operation tool.
export const fsManageSchema = z.object({
  operation: z.enum(["stat", "mkdir", "move", "copy", "delete", "times", "transfer-stage", "transfer-finalize"]),
  path: z.string().min(1), destination: z.string().optional(),
  recursive: z.boolean().optional(), force: z.boolean().optional(),
  modifiedAt: z.string().datetime().optional(), accessedAt: z.string().datetime().optional(),
  expectedDestination: z.string().min(1).optional(), expectedBytes: z.number().int().nonnegative().optional(),
  sourceMode: z.number().int().min(0).max(0o777).optional(), timeoutMs: timeoutMsField.optional(),
}).superRefine((input, ctx) => {
  if (input.operation !== "transfer-finalize") return;
  for (const field of ["destination", "expectedDestination", "expectedBytes"] as const) {
    if (input[field] === undefined || input[field] === "") ctx.addIssue({ code: "custom", path: [field], message: "Required for transfer finalization" });
  }
});
