package eu.astancu.rcmcp.android;

import android.content.ContentResolver;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.CancellationSignal;
import java.io.Closeable;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** One process-wide import, including across Activity recreation and ignored cancellation. */
final class BackgroundConfigurationImport {
    static final long TIMEOUT_MS = 5000L;
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();
    // Provider cancellation/close can themselves block: keep those off the UI thread too.
    private static final ExecutorService CLEANUP = Executors.newFixedThreadPool(2);
    private static Job active;
    private static long stopEpoch;

    static synchronized long stopEpoch() { return stopEpoch; }
    static synchronized boolean busy() { return active != null; }
    static synchronized Job current() {
        return active != null && !active.cancelled ? active : null;
    }
    static synchronized void stop() {
        stopEpoch++;
        if (active != null) active.cancel();
    }

    static synchronized Job start(ContentResolver resolver, Uri uri) {
        if (active != null) return null;
        Job job = new Job(resolver, uri, stopEpoch);
        active = job;
        WORKER.execute(() -> {
            try { job.future.run(); }
            finally { job.workerFinished(); }
        });
        return job;
    }

    static final class Job {
        private final CancellationSignal signal = new CancellationSignal();
        private final long epoch;
        private final long startedAtNanos = System.nanoTime();
        private volatile AssetFileDescriptor descriptor;
        private volatile InputStream input;
        private volatile boolean cancelled;
        private boolean workerDone;
        private int cleanupPending;
        private Object observerOwner;
        private Consumer<ConfigurationImport> observer;
        private boolean completionReady;
        private ConfigurationImport completedResult;
        private final FutureTask<Void> future;

        Job(ContentResolver resolver, Uri uri, long epoch) {
            this.epoch = epoch;
            future = new FutureTask<>(() -> {
                ConfigurationImport parsed = null;
                try {
                    descriptor = resolver.openAssetFileDescriptor(uri, "r", signal);
                    if (!cancelled && descriptor != null) {
                        try (java.io.InputStream opened = descriptor.createInputStream()) {
                            input = opened;
                            if (!cancelled) parsed = ConfigurationImport.read(input);
                        }
                    }
                } catch (java.io.IOException | RuntimeException invalid) {
                    // Never expose provider exceptions, URI or credential contents.
                } finally {
                    close(input);
                    close(descriptor);
                }

                Consumer<ConfigurationImport> callback = null;
                synchronized (BackgroundConfigurationImport.class) {
                    if (!cancelled) {
                        // Keep the parsed result process-local until the owner explicitly
                        // saves/replaces/cancels it. This lets a recreated Activity reattach
                        // without placing the bearer credential in instance state.
                        completedResult = parsed;
                        completionReady = true;
                        callback = observer;
                    }
                }
                if (callback != null) callback.accept(parsed);
                return null;
            });
        }

        boolean attach(Object owner, Consumer<ConfigurationImport> result) {
            ConfigurationImport replay = null;
            boolean notify = false;
            synchronized (BackgroundConfigurationImport.class) {
                if (cancelled || active != this) return false;
                observerOwner = owner;
                observer = result;
                if (completionReady) {
                    replay = completedResult;
                    notify = true;
                }
            }
            if (notify) result.accept(replay);
            return true;
        }

        void detach(Object owner) {
            synchronized (BackgroundConfigurationImport.class) {
                if (observerOwner == owner) {
                    observerOwner = null;
                    observer = null;
                }
            }
        }

        long epoch() { return epoch; }

        boolean completed() {
            synchronized (BackgroundConfigurationImport.class) {
                return completionReady;
            }
        }

        long remainingTimeoutMs() {
            synchronized (BackgroundConfigurationImport.class) {
                if (completionReady) return TIMEOUT_MS;
            }
            long elapsedNanos = Math.max(0L, System.nanoTime() - startedAtNanos);
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(elapsedNanos);
            return Math.max(0L, TIMEOUT_MS - elapsedMs);
        }

        void cancel() {
            synchronized (BackgroundConfigurationImport.class) {
                if (cancelled) return;
                cancelled = true;
                observerOwner = null;
                observer = null;
                completedResult = null;
                completionReady = false;
                if (workerDone) {
                    releaseIfFinished();
                    return;
                }
                cleanupPending = 2;
                future.cancel(true);
                CLEANUP.execute(() -> {
                    try { signal.cancel(); }
                    finally { cleanupFinished(); }
                });
                CLEANUP.execute(() -> {
                    try {
                        close(input);
                        close(descriptor);
                    } finally { cleanupFinished(); }
                });
            }
        }

        private void cleanupFinished() {
            synchronized (BackgroundConfigurationImport.class) {
                cleanupPending--;
                releaseIfFinished();
            }
        }

        void workerFinished() {
            synchronized (BackgroundConfigurationImport.class) {
                workerDone = true;
                releaseIfFinished();
            }
        }

        private void releaseIfFinished() {
            // A completed non-cancelled job intentionally stays active so its process-local
            // result can be replayed to a recreated Activity. Explicit owner action releases it.
            if (cancelled && workerDone && cleanupPending == 0 && active == this) active = null;
        }

        private static void close(Closeable resource) {
            if (resource != null) try { resource.close(); } catch (java.io.IOException | RuntimeException ignored) { }
        }
    }
}
