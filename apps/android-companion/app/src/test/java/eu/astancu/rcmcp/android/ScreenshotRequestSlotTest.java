package eu.astancu.rcmcp.android;

import java.util.concurrent.CompletableFuture;
import org.junit.Test;
import static org.junit.Assert.*;

public final class ScreenshotRequestSlotTest {
    @Test public void onlyOnePendingCaptureAndOneEncoder() {
        ScreenshotRequestSlot<String> slot = new ScreenshotRequestSlot<>();
        CompletableFuture<String> first = slot.begin();
        assertNull(slot.begin());
        assertTrue(slot.claimEncoding(first));
        assertFalse(slot.claimEncoding(first));
        assertTrue(slot.finish(first, "image"));
        assertEquals("image", first.join());
        assertNull(slot.begin());
        slot.releaseEncoder();
        assertNotNull(slot.begin());
    }

    @Test public void timeoutCompletesImmediatelyWhileEncodingAndRejectsLateCompletion() {
        ScreenshotRequestSlot<String> slot = new ScreenshotRequestSlot<>();
        CompletableFuture<String> first = slot.begin();
        assertTrue(slot.claimEncoding(first));
        assertTrue(slot.finish(first, "timeout"));
        assertTrue(first.isDone());
        assertEquals("timeout", first.join());
        assertNull(slot.begin());
        slot.releaseEncoder();
        CompletableFuture<String> next = slot.begin();
        assertFalse(slot.finish(first, "late image"));
        assertFalse(next.isDone());
        slot.finish(next, "fresh image");
        assertEquals("fresh image", next.join());
    }

    @Test public void stopRevocationAndUnbindCompletePendingWithoutWaitingForEncoder() {
        ScreenshotRequestSlot<String> slot = new ScreenshotRequestSlot<>();
        CompletableFuture<String> pending = slot.begin();
        assertTrue(slot.claimEncoding(pending));
        slot.stop("revoked");
        assertTrue(pending.isDone());
        assertEquals("revoked", pending.join());
        slot.stop("stopped");
        assertFalse(slot.finish(pending, "late image"));
        slot.releaseEncoder();
        assertNull(slot.begin());
    }

    @Test public void cancelledRequestCannotBeEncodedOrConfusedWithNextRequest() {
        ScreenshotRequestSlot<String> slot = new ScreenshotRequestSlot<>();
        CompletableFuture<String> pending = slot.begin();
        pending.cancel(false);
        assertFalse(slot.claimEncoding(pending));
        slot.finish(pending, "cancelled");
        CompletableFuture<String> next = slot.begin();
        assertNotNull(next);
        assertFalse(slot.finish(pending, "late"));
        assertFalse(next.isDone());
    }
}
