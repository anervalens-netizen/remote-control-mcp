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
    static synchronized void stop() {
        stopEpoch++;
        if (active != null) active.cancel();
    }

    static synchronized Job start(ContentResolver resolver, Uri uri, Consumer<ConfigurationImport> result) {
        if (active != null) return null;
        Job job = new Job(resolver, uri, result);
        active = job;
        WORKER.execute(() -> {
            try { job.future.run(); }
            finally { job.workerFinished(); }
        });
        return job;
    }

    static final class Job {
        private final CancellationSignal signal = new CancellationSignal();
        private volatile AssetFileDescriptor descriptor;
        private volatile InputStream input;
        private volatile boolean cancelled;
        private boolean workerDone;
        private int cleanupPending;
        private final FutureTask<Void> future;

        Job(ContentResolver resolver, Uri uri, Consumer<ConfigurationImport> result) {
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
                if (!cancelled) result.accept(parsed);
                return null;
            });
        }

        void cancel() {
            synchronized (BackgroundConfigurationImport.class) {
                if (cancelled) return;
                cancelled = true;
                if (workerDone) return;
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
            if (workerDone && cleanupPending == 0 && active == this) active = null;
        }
        private static void close(Closeable resource) {
            if (resource != null) try { resource.close(); } catch (java.io.IOException | RuntimeException ignored) { }
        }
    }
}
