package eu.astancu.rcmcp.android;

import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;
import org.json.JSONException;

/** Bounded streaming verification independent of Android storage APIs. */
public final class FileTransfer {
    public static final long MAX_BYTES = 512L * 1024 * 1024;
    private FileTransfer() {}

    public static String sanitizeFilename(String value) {
        String[] parts = value.split("[/\\\\]", -1);
        String name = parts[parts.length - 1].replaceAll("[^A-Za-z0-9._-]", "_").replaceAll("^[._-]+", "");
        if (name.length() > 120) name = name.substring(0, 120);
        return name.isEmpty() ? "download.bin" : name;
    }
    public static void validate(JSONObject request) throws JSONException {
        String id = request.getString("transferId");
        if (!java.util.UUID.fromString(id).toString().equals(id)) throw new JSONException("transfer_id_invalid");
        String filename = request.getString("filename");
        if (!filename.equals(sanitizeFilename(filename))) throw new JSONException("filename_invalid");
        if (!request.getString("sha256").matches("[a-f0-9]{64}")) throw new JSONException("sha256_invalid");
        long bytes = request.getLong("bytes");
        if (bytes < 0 || bytes > MAX_BYTES) throw new JSONException("bytes_invalid");
    }
    public static String copyVerified(InputStream input, OutputStream output, long expectedBytes, String expectedHash, BooleanSupplier active) throws IOException {
        if (expectedBytes < 0 || expectedBytes > MAX_BYTES || !expectedHash.matches("[a-f0-9]{64}")) throw new IOException("file_expectation_invalid");
        MessageDigest hash;
        try { hash = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
        byte[] buffer = new byte[64 * 1024];
        long bytes = 0;
        while (true) {
            if (!active.getAsBoolean()) throw new IOException("file_transfer_cancelled");
            int read = input.read(buffer);
            if (read == -1) break;
            bytes += read;
            if (bytes > expectedBytes) throw new IOException("file_length_mismatch");
            output.write(buffer, 0, read); hash.update(buffer, 0, read);
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte part : hash.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", part & 0xff));
        if (bytes != expectedBytes || !hex.toString().equals(expectedHash)) throw new IOException("file_integrity_mismatch");
        return hex.toString();
    }
}
