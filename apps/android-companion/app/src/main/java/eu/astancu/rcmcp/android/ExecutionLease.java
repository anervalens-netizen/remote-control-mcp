package eu.astancu.rcmcp.android;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

public final class ExecutionLease {
    private static final int OPEN = 0;
    private static final int EFFECT_STARTED = 1;
    private static final int CANCELLED_BEFORE_EFFECT = 2;
    private static final int CANCELLED_AFTER_EFFECT = 3;

    private final long deadline;
    private final LongSupplier clock;
    private final BooleanSupplier active;
    private final AtomicInteger state = new AtomicInteger(OPEN);

    public ExecutionLease(long deadline, LongSupplier clock, BooleanSupplier active) {
        this.deadline = deadline;
        this.clock = clock;
        this.active = active;
    }

    public boolean mayRun() {
        int current = state.get();
        return (current == OPEN || current == EFFECT_STARTED)
                && clock.getAsLong() < deadline
                && active.getAsBoolean();
    }

    /**
     * Atomically admits the first device-side effect against cancellation.
     * If cancellation wins the CAS race, no later caller can start an effect.
     */
    public boolean beginEffect() {
        if (clock.getAsLong() >= deadline || !active.getAsBoolean()) return false;
        if (!state.compareAndSet(OPEN, EFFECT_STARTED)) return false;
        // Recheck external liveness after admission. A concurrent lease cancel
        // changes EFFECT_STARTED -> CANCELLED_AFTER_EFFECT, which is
        // conservatively reported as uncertain even if the device call has not
        // happened yet; it can never be mislabeled as definitely pre-effect.
        if (clock.getAsLong() >= deadline || !active.getAsBoolean()) {
            state.compareAndSet(EFFECT_STARTED, CANCELLED_BEFORE_EFFECT);
            return false;
        }
        return true;
    }

    public boolean effectStarted() {
        int current = state.get();
        return current == EFFECT_STARTED || current == CANCELLED_AFTER_EFFECT;
    }

    /**
     * Cancels and returns one atomic snapshot of whether effect admission won.
     */
    public boolean cancelAndEffectStarted() {
        while (true) {
            int current = state.get();
            if (current == CANCELLED_BEFORE_EFFECT) return false;
            if (current == CANCELLED_AFTER_EFFECT) return true;
            int next = current == EFFECT_STARTED ? CANCELLED_AFTER_EFFECT : CANCELLED_BEFORE_EFFECT;
            if (state.compareAndSet(current, next)) return current == EFFECT_STARTED;
        }
    }

    public void cancel() {
        cancelAndEffectStarted();
    }
}
