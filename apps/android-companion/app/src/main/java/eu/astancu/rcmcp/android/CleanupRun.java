package eu.astancu.rcmcp.android;

/** Owns one cleanup worker's cancellation and terminal callback. */
final class CleanupRun {
    private final Runnable cancelProvider;
    private Thread worker;
    private boolean stopped;

    CleanupRun(Runnable cancelProvider) { this.cancelProvider = cancelProvider; }

    synchronized void attach(Thread worker) {
        this.worker = worker;
        if (stopped) worker.interrupt();
    }

    void stop() {
        Thread current;
        synchronized (this) {
            if (stopped) return;
            stopped = true;
            current = worker;
        }
        try { cancelProvider.run(); }
        finally { if (current != null) current.interrupt(); }
    }

    synchronized boolean finish(Runnable completion) {
        if (stopped) return false;
        stopped = true;
        completion.run();
        return true;
    }
}
