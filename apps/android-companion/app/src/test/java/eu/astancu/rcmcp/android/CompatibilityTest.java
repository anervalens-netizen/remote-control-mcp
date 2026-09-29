package eu.astancu.rcmcp.android;

import org.junit.Test;
import static org.junit.Assert.*;

public final class CompatibilityTest {
    @Test public void retainsUnicodeBlankSemanticsOnApi29() {
        for (String value : new String[]{"", " ", "\t\n\r", "\u2003", "\u00a0", "x", " x ", "\uD83D\uDE00"}) {
            assertEquals(value.isBlank(), Compatibility.isBlank(value));
        }
    }
}
