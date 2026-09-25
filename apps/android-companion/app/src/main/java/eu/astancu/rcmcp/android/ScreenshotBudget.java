package eu.astancu.rcmcp.android;

/**
 * Wire-size budget for screenshot payloads. The controller defaults to a
 * 16 MiB JSON body cap; keeping compressed image bytes at <=8 MiB leaves
 * substantial headroom for Base64 expansion, snapshot metadata and UI tree.
 */
public final class ScreenshotBudget {
    public static final int MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
    public static final int[] JPEG_QUALITIES = {90, 80, 70, 60, 50};

    private ScreenshotBudget() {}

    public static boolean fitsCompressedBytes(int bytes) {
        return bytes >= 0 && bytes <= MAX_COMPRESSED_BYTES;
    }

    public static long maxBase64Chars() {
        return ((MAX_COMPRESSED_BYTES + 2L) / 3L) * 4L;
    }
}
