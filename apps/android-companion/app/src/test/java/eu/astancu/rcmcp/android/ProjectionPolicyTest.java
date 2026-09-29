package eu.astancu.rcmcp.android;

import org.junit.Test;
import static org.junit.Assert.*;

public final class ProjectionPolicyTest {
    @Test public void onlyApi29MayConsumeOneExplicitConsentedGesture() {
        ProjectionPolicy policy = new ProjectionPolicy();
        assertFalse(policy.consume(0, 29, true, true));
        for (int sdk : new int[]{28, 30, 33, 36}) assertEquals(0, policy.request(sdk, true));
        assertEquals(0, policy.request(29, false));
        long ticket = policy.request(29, true);
        assertTrue(policy.consume(ticket, 29, true, true));
        assertFalse(policy.consume(ticket, 29, true, true));
    }

    @Test public void denialStopDisableAndProcessRecreationInvalidateConsent() {
        ProjectionPolicy policy = new ProjectionPolicy();
        long ticket = policy.request(29, true);
        assertFalse(policy.consume(ticket, 29, false, true));
        assertFalse(policy.consume(ticket, 29, true, true));
        ticket = policy.request(29, true);
        policy.invalidate();
        assertFalse(policy.consume(ticket, 29, true, true));
        ticket = policy.request(29, true);
        assertFalse(policy.consume(ticket, 29, true, false));
        ticket = policy.request(29, true);
        assertFalse(new ProjectionPolicy().consume(ticket, 29, true, true));
    }

    @Test public void replacementGestureAndWrongApiCannotReplayOldResult() {
        ProjectionPolicy policy = new ProjectionPolicy();
        long old = policy.request(29, true);
        long fresh = policy.request(29, true);
        assertNotEquals(old, fresh);
        assertFalse(policy.consume(old, 29, true, true));
        fresh = policy.request(29, true);
        assertFalse(policy.consume(fresh, 30, true, true));
    }

    @Test public void anyDimensionOrRotationChangeFailsClosed() {
        assertTrue(ProjectionPolicy.sameDisplay(800, 1280, 0, 800, 1280, 0));
        assertFalse(ProjectionPolicy.sameDisplay(800, 1280, 0, 1280, 800, 1));
        assertFalse(ProjectionPolicy.sameDisplay(800, 1280, 0, 800, 1280, 2));
        assertFalse(ProjectionPolicy.sameDisplay(800, 1280, 0, 801, 1280, 0));
        assertFalse(ProjectionPolicy.sameDisplay(800, 1280, 0, 800, 1279, 0));
        assertTrue(ProjectionPolicy.CAPTURE_TIMEOUT_MS > 0 && ProjectionPolicy.CAPTURE_TIMEOUT_MS <= 3000);
    }
}
