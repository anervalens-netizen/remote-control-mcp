package eu.astancu.rcmcp.android;

import org.junit.Test;
import static org.junit.Assert.*;

public final class LocalConsentBoundaryTest {
    @Test public void blocksAllMutationsDuringSetupButAllowsObservation() {
        LocalConsentBoundary boundary = new LocalConsentBoundary();
        Object activity = new Object();
        boundary.update(activity, true, false);
        for (String operation : new String[]{"tap", "swipe", "set_text", "node_action", "global_action", "open_app"})
            assertFalse(boundary.allows(operation));
        assertTrue(boundary.allows("observe"));
        boundary.update(activity, false, false);
        assertTrue(boundary.allows("tap"));
    }

    @Test public void dialogLatchSurvivesBackgroundAndRechecksQueuedAction() {
        LocalConsentBoundary boundary = new LocalConsentBoundary();
        Object activity = new Object();
        assertTrue(boundary.allows("tap")); // Allowed when queued.
        boundary.update(activity, true, true); // Before launching consent or picker.
        boundary.update(activity, false, true); // Dialog takes foreground.
        assertFalse(boundary.allows("mutation")); // Rechecked immediately before effect.
        assertTrue(boundary.allows("observe"));
        boundary.update(activity, true, false); // Result arrives; setup still visible.
        assertFalse(boundary.allows("tap"));
        boundary.update(activity, false, false);
        assertTrue(boundary.allows("tap"));
    }

    @Test public void destroyingOldActivityDoesNotClearReplacementBoundary() {
        LocalConsentBoundary boundary = new LocalConsentBoundary();
        Object old = new Object(), replacement = new Object();
        boundary.update(old, false, true);
        boundary.update(replacement, false, true);
        boundary.destroy(old);
        assertFalse(boundary.allows("tap"));
        boundary.destroy(replacement);
        assertTrue(boundary.allows("tap"));
    }
}
