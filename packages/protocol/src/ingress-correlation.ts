import { z } from "zod";

/** Correlation is a caller claim. A shared bearer authenticates its holder, not
 * a controller process, a person, a ContextKeep task, or an effect identity. */
export const ingressCorrelationHeader = "x-rcmcp-correlation";
export const ingressReceiptHeader = "x-rcmcp-ingress";
export const ingressCorrelationSchema = z.object({
  version: z.literal(1),
  controllerInstanceId: z.string().uuid(),
  dispatchId: z.string().uuid(),
  httpRequestId: z.string().uuid().optional(),
  traceId: z.string().uuid().optional(),
  diagnosticScopeId: z.string().uuid().optional(),
  contextKeep: z.object({
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    runId: z.string().uuid(),
  }).strict().optional(),
}).strict();
export type IngressCorrelation = z.infer<typeof ingressCorrelationSchema>;

export const ingressReceiptSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().uuid(),
  sequence: z.number().int().positive().safe(),
  eventId: z.string().max(80),
  dispatchId: z.string().uuid().optional(),
}).strict().refine(value => value.eventId === value.instanceId + ":" + value.sequence, {
  message: "Ingress receipt identity does not match its instance and sequence",
});
export type IngressReceipt = z.infer<typeof ingressReceiptSchema>;

const maxHeaderBytes = 2048;
export function encodeIngressHeader(value: IngressCorrelation | IngressReceipt): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function parseHeader<T>(value: unknown, schema: z.ZodType<T>): { value?: T; invalid: boolean } {
  if (value === undefined || value === null) return { invalid: false };
  if (typeof value !== "string" || value.length < 1 || value.length > maxHeaderBytes ||
      !/^[A-Za-z0-9_-]+$/.test(value)) return { invalid: true };
  try {
    const bytes = Buffer.from(value, "base64url");
    // Reject ambiguous encodings instead of treating them as distinct IDs.
    if (bytes.toString("base64url") !== value) return { invalid: true };
    const parsed = schema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? { value: parsed.data, invalid: false } : { invalid: true };
  } catch { return { invalid: true }; }
}
export const parseIngressCorrelation = (value: unknown) => parseHeader(value, ingressCorrelationSchema);
export const parseIngressReceipt = (value: unknown) => parseHeader(value, ingressReceiptSchema);

/** Bounded live pages. Samples have stable IDs but offset pages are not snapshots. */
export const ingressQueryFields = {
  sampleOffset: z.number().int().min(0).max(256).optional(),
  sampleLimit: z.number().int().min(0).max(32).optional(),
  seriesOffset: z.number().int().min(0).max(256).optional(),
  seriesLimit: z.number().int().min(0).max(32).optional(),
  historyOffset: z.number().int().min(0).max(90).optional(),
  historyLimit: z.number().int().min(0).max(14).optional(),
};
// Agent HTTP accepts an additive cursor. Do not expose it through the legacy
// usage_report SDK input schema: older agents reject unknown keys with 400.
export const ingressQuerySchema = z.object({
  ...ingressQueryFields,
  sampleAfterSequence: z.number().int().nonnegative().safe().optional(),
}).strict();
