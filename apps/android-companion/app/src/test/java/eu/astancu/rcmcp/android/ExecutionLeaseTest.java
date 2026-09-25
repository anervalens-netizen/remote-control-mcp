package eu.astancu.rcmcp.android;

import org.junit.Test;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.Assert.*;

public final class ExecutionLeaseTest {
    @Test public void permitsOnlyLiveSessionBeforeDeadline() {
        AtomicLong now = new AtomicLong(10);
        AtomicBoolean active = new AtomicBoolean(true);
        ExecutionLease lease = new ExecutionLease(100, now::get, active::get);
        assertTrue(lease.mayRun());
        active.set(false);
        assertFalse(lease.mayRun());
        assertFalse(lease.beginEffect());
        assertFalse(lease.effectStarted());
    }
    @Test public void rejectsLateQueuedMainThreadActionWithoutEffect() {
        AtomicLong now = new AtomicLong(10);
        ExecutionLease lease = new ExecutionLease(100, now::get, () -> true);
        now.set(100);
        assertFalse(lease.beginEffect());
        assertFalse(lease.effectStarted());
    }
    @Test public void localStopCancelsBeforeEffect() {
        ExecutionLease lease = new ExecutionLease(100, () -> 10, () -> true);
        lease.cancel();
        assertFalse(lease.mayRun());
        assertFalse(lease.beginEffect());
    }
    @Test public void cancellationAfterDispatchKeepsUncertaintyEvidence() {
        ExecutionLease lease = new ExecutionLease(100, () -> 10, () -> true);
        assertTrue(lease.beginEffect());
        assertTrue(lease.cancelAndEffectStarted());
        assertTrue(lease.effectStarted());
        assertFalse(lease.mayRun());
    }

    @Test public void cancellationWinningDuringAdmissionPreventsTheEffectDeterministically() throws Exception {
        CountDownLatch enteredLivenessCheck = new CountDownLatch(1);
        CountDownLatch releaseLivenessCheck = new CountDownLatch(1);
        AtomicBoolean began = new AtomicBoolean(true);
        ExecutionLease lease = new ExecutionLease(100, () -> 10, () -> {
            enteredLivenessCheck.countDown();
            try {
                if (!releaseLivenessCheck.await(1, TimeUnit.SECONDS)) throw new AssertionError("test_latch_timeout");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError(interrupted);
            }
            return true;
        });
        Thread admission = new Thread(() -> began.set(lease.beginEffect()));
        admission.start();
        assertTrue(enteredLivenessCheck.await(1, TimeUnit.SECONDS));

        // beginEffect has checked the clock but has not committed effect admission.
        // Cancellation wins the atomic state transition while liveness is blocked.
        assertFalse(lease.cancelAndEffectStarted());
        releaseLivenessCheck.countDown();
        admission.join(1000);

        assertFalse(admission.isAlive());
        assertFalse(began.get());
        assertFalse(lease.effectStarted());
        assertFalse(lease.mayRun());
    }

    @Test public void replacingServiceSessionInvalidatesOldLease() {
        AtomicLong epoch = new AtomicLong(1);
        ExecutionLease lease = new ExecutionLease(100, () -> 10, () -> epoch.get() == 1);
        epoch.incrementAndGet();
        assertFalse(lease.beginEffect());
    }
}
