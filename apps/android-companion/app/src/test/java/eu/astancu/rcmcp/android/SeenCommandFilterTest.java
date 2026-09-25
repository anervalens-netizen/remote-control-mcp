package eu.astancu.rcmcp.android;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class SeenCommandFilterTest {
    @Test public void persistsSeenCommandsWithoutFalseNegatives() {
        SeenCommandFilter filter = new SeenCommandFilter();
        String first = "11111111-1111-4111-8111-111111111111";
        String second = "22222222-2222-4222-8222-222222222222";
        assertFalse(filter.mightContain(first));
        filter.add(first);
        assertTrue(filter.mightContain(first));
        SeenCommandFilter restored = SeenCommandFilter.decode(filter.encode());
        assertTrue(restored.mightContain(first));
        assertFalse(restored.mightContain(second));
    }
}
