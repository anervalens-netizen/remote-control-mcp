package eu.astancu.rcmcp.android;

import org.junit.Test;

import static org.junit.Assert.*;

public final class TimeoutDispositionTest {
    @Test public void timeoutBeforeAdmissionIsDefiniteErrorAndBlocksLaterEffect() {
        ExecutionLease lease = new ExecutionLease(100, () -> 10, () -> true);
        TimeoutDisposition disposition = TimeoutDisposition.cancel(lease);

        assertFalse(disposition.uncertain);
        assertEquals(CommandLedger.ERROR, disposition.ledgerStatus);
        assertEquals("error", disposition.protocolStatus);
        assertEquals("expired_before_effect", disposition.code);
        assertEquals("command_timed_out_before_effect", disposition.message);
        assertFalse(lease.beginEffect());
        assertFalse(lease.effectStarted());
    }

    @Test public void timeoutAfterAdmissionIsAuthoritativelyUncertain() {
        ExecutionLease lease = new ExecutionLease(100, () -> 10, () -> true);
        assertTrue(lease.beginEffect());

        TimeoutDisposition disposition = TimeoutDisposition.cancel(lease);

        assertTrue(disposition.uncertain);
        assertEquals(CommandLedger.OUTCOME_UNKNOWN, disposition.ledgerStatus);
        assertEquals("outcome_unknown", disposition.protocolStatus);
        assertEquals("outcome_unknown", disposition.code);
        assertEquals("action_completion_timeout_after_effect_started", disposition.message);
        assertTrue(lease.effectStarted());
        assertFalse(lease.mayRun());
    }
}
