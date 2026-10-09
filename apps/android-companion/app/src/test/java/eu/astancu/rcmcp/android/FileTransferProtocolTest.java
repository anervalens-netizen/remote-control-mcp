package eu.astancu.rcmcp.android;
import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;
public final class FileTransferProtocolTest {
    private static final String HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    @Test public void validatesTransferProtocol() throws Exception {
        JSONObject request = new JSONObject().put("operation", "receive_file").put("transferId", "00000000-0000-4000-8000-000000000001")
            .put("filename", "example.bin").put("sha256", HASH).put("bytes", 3);
        JSONObject envelope = new JSONObject().put("version", 1).put("serverTime", 10000).put("serverWaitMs", 0)
            .put("command", new JSONObject().put("commandId", "00000000-0000-4000-8000-000000000002")
                .put("deliveryId", "00000000-0000-4000-8000-000000000003").put("expiresAt", 13000).put("request", request));
        FileTransfer.validate(Protocol.commandResponse(envelope).getJSONObject("request"));
        request.put("filename", "../bad.bin"); assertThrows(Exception.class, () -> FileTransfer.validate(request));
        request.put("filename", "valid.bin").put("bytes", FileTransfer.MAX_BYTES + 1); assertThrows(Exception.class, () -> FileTransfer.validate(request));
        request.put("bytes", 3).put("sha256", "invalid"); assertThrows(Exception.class, () -> FileTransfer.validate(request));
        request.put("sha256", HASH).put("transferId", "1-1-1-1-1"); assertThrows(Exception.class, () -> FileTransfer.validate(request));
    }
}
