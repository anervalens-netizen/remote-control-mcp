package eu.astancu.rcmcp.android;

import org.junit.Test;

import static org.junit.Assert.*;

public final class ScreenshotBudgetTest {
    @Test public void leavesHeadroomUnderTheControllerDefaultJsonBodyLimit() {
        long controllerDefault = 16L * 1024L * 1024L;
        long observationText = ObservationBudget.DEFAULT_MAX_TOTAL_CHARS;
        long metadataHeadroom = 512L * 1024L;

        assertTrue(ScreenshotBudget.fitsCompressedBytes(ScreenshotBudget.MAX_COMPRESSED_BYTES));
        assertFalse(ScreenshotBudget.fitsCompressedBytes(ScreenshotBudget.MAX_COMPRESSED_BYTES + 1));
        assertTrue(ScreenshotBudget.maxBase64Chars() + observationText + metadataHeadroom < controllerDefault);
    }

    @Test public void providesBoundedLossyFallbackQualities() {
        assertArrayEquals(new int[] {90, 80, 70, 60, 50}, ScreenshotBudget.JPEG_QUALITIES);
    }
}
