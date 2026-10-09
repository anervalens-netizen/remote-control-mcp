package eu.astancu.rcmcp.android;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public final class FileTransferTest {
    private static final String HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    @Test public void filenameSanitization() {
        assertEquals("example_file.bin", FileTransfer.sanitizeFilename("C:\\folder\\example file.bin"));
        assertEquals("download.bin", FileTransfer.sanitizeFilename("../../"));
        assertEquals("hidden", FileTransfer.sanitizeFilename("..hidden"));
        assertEquals(120, FileTransfer.sanitizeFilename("x".repeat(200)).length());
    }
    @Test public void streamsVerifiedBytes() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertEquals(HASH, FileTransfer.copyVerified(new ByteArrayInputStream("abc".getBytes(StandardCharsets.UTF_8)), output, 3, HASH, () -> true));
        assertEquals("abc", output.toString("UTF-8"));
    }
    @Test public void rejectsWrongHashLengthAndCancellation() {
        for (long length : new long[]{2, 4, -1, FileTransfer.MAX_BYTES + 1}) {
            assertThrows(IOException.class, () -> FileTransfer.copyVerified(new ByteArrayInputStream(new byte[]{97,98,99}), new ByteArrayOutputStream(), length, HASH, () -> true));
        }
        assertThrows(IOException.class, () -> FileTransfer.copyVerified(new ByteArrayInputStream(new byte[]{97,98,99}), new ByteArrayOutputStream(), 3, "0".repeat(64), () -> true));
        assertThrows(IOException.class, () -> FileTransfer.copyVerified(new ByteArrayInputStream(new byte[]{97,98,99}), new ByteArrayOutputStream(), 3, HASH, () -> false));
    }
    @Test public void emptyFileHash() throws Exception {
        String empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assertEquals(empty, FileTransfer.copyVerified(new ByteArrayInputStream(new byte[0]), new ByteArrayOutputStream(), 0, empty, () -> true));
    }
}
