package eu.astancu.rcmcp.android;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class DeadlineTest {
    @Test public void subtractsNonPollRoundTripFromServerTtlWithoutClockSync() {
        // TTL at server send = 3000ms. Client RTT = 800ms, of which the
        // server reports 500ms as long-poll wait. The remaining 300ms is
        // request/response transit + processing and must consume the TTL.
        Deadline deadline = Deadline.fromServerTiming(10_000L, 13_000L, 100L, 900L, 500L);
        assertFalse(deadline.isExpired(3_599L));
        assertTrue(deadline.isExpired(3_600L));
    }

    @Test public void expiredServerCommandCannotGainTime() {
        Deadline deadline = Deadline.fromServerTiming(20_000L, 19_000L, 100L, 800L, 500L);
        assertTrue(deadline.isExpired(800L));
    }

    @Test public void delayedResponseCanConsumeTheEntireRemainingTtl() {
        Deadline deadline = Deadline.fromServerTiming(10_000L, 10_100L, 100L, 800L, 100L);
        assertTrue(deadline.isExpired(800L));
    }

    @Test public void legitimateLongPollWaitDoesNotConsumeCommandTtlTwice() {
        Deadline deadline = Deadline.fromServerTiming(10_000L, 12_000L, 100L, 5_100L, 4_900L);
        assertFalse(deadline.isExpired(6_999L));
        assertTrue(deadline.isExpired(7_000L));
    }

    @Test public void legacyV1WithoutServerWaitChargesTheWholeRoundTripConservatively() {
        Deadline deadline = Deadline.fromServerTiming(10_000L, 13_000L, 100L, 2_100L, -1L);
        assertFalse(deadline.isExpired(3_099L));
        assertTrue(deadline.isExpired(3_100L));
    }

    @Test public void legacyV1RoundTripLongerThanTtlExpiresAtReceipt() {
        Deadline deadline = Deadline.fromServerTiming(10_000L, 13_000L, 100L, 5_100L, -1L);
        assertTrue(deadline.isExpired(5_100L));
    }
}
