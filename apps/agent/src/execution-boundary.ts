import { AsyncLocalStorage } from "node:async_hooks";

/** Product-owned proof, kept out of transport error payloads so original typed
 * job/validation errors retain their public contract. Proofs are scoped to one
 * coordination invocation and cannot authorize settlement in a later call. */
export type NoEffectSubmittedProof = { readonly effectSubmitted: false; readonly invocation: symbol };
const invocation = new AsyncLocalStorage<symbol>();
const proofs = new WeakMap<object, NoEffectSubmittedProof>();
export function withExecutionProof<T>(scope: symbol, run: () => T): T { return invocation.run(scope, run); }
export function noEffectSubmittedProof(error: unknown, scope: symbol): NoEffectSubmittedProof | undefined {
  const proof = error !== null && typeof error === "object" ? proofs.get(error) : undefined;
  return proof?.invocation === scope ? proof : undefined;
}

export async function executionBoundary<T>(run: (submit: () => void) => Promise<T>): Promise<T> {
  let submitted = false;
  try { return await run(() => { submitted = true; }); }
  catch (cause) {
    const error = cause !== null && typeof cause === "object" ? cause : new Error(String(cause));
    const scope = invocation.getStore();
    if (!submitted && scope) proofs.set(error, { effectSubmitted: false, invocation: scope });
    else proofs.delete(error); // A nested preflight cannot erase an earlier effect.
    throw error;
  }
}
