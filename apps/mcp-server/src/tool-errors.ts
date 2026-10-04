import { utf8Preview } from "./result-text.ts";
import { OperationReceiptError } from "./operation-receipt-error.ts";
import { AgentRequestError } from "./agent-client.ts";

export function toolErrorDetails(error: unknown) {
  return {
    ...(error instanceof OperationReceiptError ? error.receipt : {}),
    error: utf8Preview(redactDiagnostic(error instanceof Error ? error.message : "Request failed"), 2048),
    requestSucceeded: false,
    clientAcceptance: "unknown" as const,
    ...(error instanceof Error && "resultRecovery" in error ? { resultRecovery: error.resultRecovery } : {}),
    ...(error instanceof Error && "code" in error && typeof error.code === "string" && /^(?:E[A-Z0-9_]+)$/.test(error.code) ? { agentCode: error.code } : {}),
    ...(error instanceof AgentRequestError ? {
      device: error.device, context: error.context, route: error.route, kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.agentCode ? { agentCode: error.agentCode } : {}),
      ...(error.recovery ? { recovery: error.recovery } : {}),
      ...(error.coordinationConflict ? { coordinationConflict: error.coordinationConflict } : {}),
      ...(error.jobStartFailure ? error.jobStartFailure : {}),
      ...(error.responseBodyTruncated ? { responseBodyTruncated: true } : {}),
    } : {}),
  };
}

/** The SDK otherwise reduces thrown exceptions to unstructured text. */
export async function withToolErrors<T>(run: () => Promise<T>) {
  try { return await run(); }
  catch (error) {
    const value = { ok: false, ...toolErrorDetails(error) };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
  }
}

/** Redact common credential assignments and bearer/URL credentials without
 * serializing arbitrary exception properties, causes, stacks or response bodies. */
function redactDiagnostic(message: string): string {
  return message.replace(/(bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:password|passwd|secret|token|credentials?|api[_-]?key|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}
