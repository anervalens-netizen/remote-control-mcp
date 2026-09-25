package eu.astancu.rcmcp.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public final class ShellDispatchGateTest {
    @Test public void nextExecutionWaitsForCancelledExecutionDrainThenAcquires() throws Exception {
        ShellDispatchGate gate = new ShellDispatchGate();
        assertTrue(gate.acquire("old", 100));

        CompletableFuture<Boolean> next = CompletableFuture.supplyAsync(() -> {
            try {
                return gate.acquire("new", 2_000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        });

        Thread.sleep(50);
        assertFalse(next.isDone());
        gate.release("old");
        assertTrue(next.get(1, TimeUnit.SECONDS));
        gate.release("new");
    }

    @Test public void waitingExecutionExpiresWithoutStarting() throws Exception {
        ShellDispatchGate gate = new ShellDispatchGate();
        assertTrue(gate.acquire("old", 100));
        assertFalse(gate.acquire("new", 20));
        gate.release("old");
    }
}
