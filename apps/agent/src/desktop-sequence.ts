import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyReply, FastifyRequest } from 'fastify';

// A batch holds the same lane as individual actions, including waits.
const lane = new AsyncLocalStorage<boolean>();
const cancellation = new AsyncLocalStorage<AbortSignal>();
let tail: Promise<void> = Promise.resolve();
export const desktopCancellation = () => cancellation.getStore();
export function desktopRequestScope<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  return cancellation.run(signal, action);
}
export function desktopRequest<T>(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<T>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<T> => {
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(new Error('Desktop caller disconnected; remaining actions cancelled')); };
    reply.raw.once('close', disconnected); request.raw.once('aborted', disconnected);
    if (request.raw.aborted || reply.raw.destroyed) disconnected();
    try { return await desktopRequestScope(controller.signal, () => handler(request, reply)); }
    finally { reply.raw.off('close', disconnected); request.raw.off('aborted', disconnected); }
  };
}
export function desktopSequence<T>(action: () => Promise<T>): Promise<T> {
  const signal = desktopCancellation();
  signal?.throwIfAborted();
  if (lane.getStore()) return action();
  const result = tail.then(() => { signal?.throwIfAborted(); return lane.run(true, action); });
  tail = result.then(() => undefined, () => undefined);
  if (!signal) return result;
  // Reject callers promptly, but retain the queue slot until its turn, where it
  // is discarded. In-flight native effects finish; remaining actions never run.
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
