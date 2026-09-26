import { AgentRequestError } from "./agent-client.ts";

export function toolErrorDetails(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof AgentRequestError ? {
      device: error.device, context: error.context, route: error.route, kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.recovery ? { recovery: error.recovery } : {}),
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
