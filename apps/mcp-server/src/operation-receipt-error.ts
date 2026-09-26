/** An interrupted multi-step effect needs a typed receipt, not a success value
 * or a generic exception that hides already-completed work. Only construct
 * details from operational metadata; never include payload/file bytes. */
export class OperationReceiptError extends Error {
  readonly receipt: Record<string, unknown>;
  constructor(message: string, receipt: Record<string, unknown>, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = cause instanceof Error && ["AbortError", "TimeoutError"].includes(cause.name) ? cause.name : "OperationReceiptError";
    this.receipt = receipt;
  }
}
