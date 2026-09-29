package eu.astancu.rcmcp.android;

import java.util.concurrent.CompletableFuture;

/** One request and at most one encoder; timeout/STOP never waits for encoding. */
final class ScreenshotRequestSlot<T> {
    private CompletableFuture<T> pending;
    private boolean encoding;
    private boolean stopped;

    synchronized CompletableFuture<T> begin() {
        if (stopped || pending != null || encoding) return null;
        pending = new CompletableFuture<>();
        return pending;
    }

    synchronized CompletableFuture<T> pending() { return pending; }

    synchronized boolean claimEncoding(CompletableFuture<T> target) {
        if (stopped || encoding || target == null || pending != target || target.isDone()) return false;
        encoding = true;
        return true;
    }

    synchronized boolean finish(CompletableFuture<T> target, T value) {
        if (target == null || pending != target) return false;
        pending = null;
        target.complete(value);
        return true;
    }

    synchronized void releaseEncoder() { encoding = false; }

    synchronized void stop(T value) {
        stopped = true;
        finish(pending, value);
    }
}
