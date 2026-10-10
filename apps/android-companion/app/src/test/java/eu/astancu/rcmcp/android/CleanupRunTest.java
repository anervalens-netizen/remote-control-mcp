package eu.astancu.rcmcp.android;

import org.junit.Test;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public final class CleanupRunTest {
    @Test public void stoppingInterruptsWorkerAndSuppressesLateCompletion() throws Exception {
        AtomicInteger cancelled = new AtomicInteger(), finished = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(1), stopped = new CountDownLatch(1);
        CleanupRun run = new CleanupRun(cancelled::incrementAndGet);
        Thread worker = new Thread(() -> {
            started.countDown();
            try { new CountDownLatch(1).await(); }
            catch (InterruptedException expected) { stopped.countDown(); }
        });
        run.attach(worker); worker.start();
        assertTrue(started.await(2, TimeUnit.SECONDS));
        run.stop(); run.stop();
        assertTrue(stopped.await(2, TimeUnit.SECONDS));
        worker.join(2000);
        assertFalse(worker.isAlive());
        assertEquals(1, cancelled.get());
        assertFalse(run.finish(finished::incrementAndGet));
        assertEquals(0, finished.get());
    }
    @Test public void normalCompletionRunsOnceAndCannotLaterCancel() {
        AtomicInteger cancelled = new AtomicInteger(), finished = new AtomicInteger();
        CleanupRun run = new CleanupRun(cancelled::incrementAndGet);
        assertTrue(run.finish(finished::incrementAndGet));
        assertFalse(run.finish(finished::incrementAndGet));
        run.stop();
        assertEquals(1, finished.get()); assertEquals(0, cancelled.get());
    }
    @Test public void providerFailureStillInterruptsTheWorker() {
        Thread worker = new Thread(() -> {});
        CleanupRun run = new CleanupRun(() -> { throw new IllegalStateException("synthetic provider"); });
        run.attach(worker);
        assertThrows(IllegalStateException.class, run::stop);
        assertTrue(worker.isInterrupted());
        assertFalse(run.finish(() -> fail("stopped run")));
    }
    @Test public void stoppingOneRunDoesNotStopAnotherJob() {
        AtomicInteger finished = new AtomicInteger();
        CleanupRun startup = new CleanupRun(() -> {});
        CleanupRun periodic = new CleanupRun(() -> {});
        startup.stop();
        assertTrue(periodic.finish(finished::incrementAndGet));
        assertEquals(1, finished.get());
    }
}
