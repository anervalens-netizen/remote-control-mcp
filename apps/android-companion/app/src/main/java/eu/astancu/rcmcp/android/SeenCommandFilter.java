package eu.astancu.rcmcp.android;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;

/**
 * Fixed-size, fail-closed tombstone filter for compacted command identities.
 * False positives reject a fresh UUID; false negatives would permit replay, so
 * the filter is never rotated or cleared automatically.
 */
public final class SeenCommandFilter {
    static final int BYTES = 128 * 1024;
    private static final int HASHES = 6;
    private final byte[] bits;

    public SeenCommandFilter() {
        this.bits = new byte[BYTES];
    }

    private SeenCommandFilter(byte[] bits) {
        if (bits.length != BYTES) throw new IllegalArgumentException("seen_filter_size_invalid");
        this.bits = bits.clone();
    }

    public static SeenCommandFilter decode(String encoded) {
        if (encoded == null || encoded.isBlank()) return new SeenCommandFilter();
        return new SeenCommandFilter(Base64.getDecoder().decode(encoded));
    }

    public String encode() {
        return Base64.getEncoder().encodeToString(bits);
    }

    public void add(String commandId) {
        for (int bit : indexes(commandId)) bits[bit >>> 3] |= (byte) (1 << (bit & 7));
    }

    public boolean mightContain(String commandId) {
        for (int bit : indexes(commandId)) {
            if ((bits[bit >>> 3] & (1 << (bit & 7))) == 0) return false;
        }
        return true;
    }

    private static int[] indexes(String commandId) {
        byte[] digest;
        try {
            digest = MessageDigest.getInstance("SHA-256").digest(commandId.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
        long first = unsignedInt(digest, 0);
        long step = unsignedInt(digest, 4) | 1L;
        long bitCount = (long) BYTES * 8L;
        int[] result = new int[HASHES];
        for (int i = 0; i < HASHES; i++) {
            result[i] = (int) ((first + i * step + (long) i * i) % bitCount);
        }
        return result;
    }

    private static long unsignedInt(byte[] bytes, int offset) {
        return ((long) (bytes[offset] & 0xff) << 24)
                | ((long) (bytes[offset + 1] & 0xff) << 16)
                | ((long) (bytes[offset + 2] & 0xff) << 8)
                | (long) (bytes[offset + 3] & 0xff);
    }
}
