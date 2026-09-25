package eu.astancu.rcmcp.android;

import java.util.concurrent.TimeUnit;

final class ShellDispatchGate {
    private String activeExecutionId;

    synchronized boolean acquire(String executionId, long waitMs) throws InterruptedException {
        long boundedWaitMs = Math.max(0L, waitMs);
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(boundedWaitMs);
        while (activeExecutionId != null) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0L) return false;
            TimeUnit.NANOSECONDS.timedWait(this, remaining);
        }
        activeExecutionId = executionId;
        return true;
    }

    synchronized void release(String executionId) {
        if (executionId != null && executionId.equals(activeExecutionId)) {
            activeExecutionId = null;
            notifyAll();
        }
    }

    synchronized String activeExecutionId() {
        return activeExecutionId;
    }

    synchronized void clear() {
        activeExecutionId = null;
        notifyAll();
    }
}
