package eu.astancu.rcmcp.android;

import org.json.JSONObject;
import org.json.JSONException;
import org.junit.Test;
import java.util.UUID;
import static org.junit.Assert.*;

public final class ProtocolTest {
    private JSONObject command() throws Exception {
        return new JSONObject().put("commandId", UUID.randomUUID().toString())
            .put("deliveryId", UUID.randomUUID().toString()).put("expiresAt", 13000L)
            .put("request", new JSONObject().put("operation", "observe"));
    }
    @Test public void returnsNestedCommandNotTransportEnvelope() throws Exception {
        JSONObject command = command();
        JSONObject outer = new JSONObject().put("version", 1).put("serverTime", 10000L).put("serverWaitMs", 0L).put("command", command);
        assertSame(command, Protocol.commandResponse(outer));
        assertEquals("observe", Protocol.commandResponse(outer).getJSONObject("request").getString("operation"));
    }
    @Test public void idleResponseReturnsNull() throws Exception {
        assertNull(Protocol.commandResponse(new JSONObject().put("version", 1).put("serverTime", 10000L).put("serverWaitMs", 25L).put("command", JSONObject.NULL)));
    }
    @Test public void rejectsMissingServerTimeAndUnsupportedVersion() throws Exception {
        JSONObject missing = new JSONObject().put("version", 1).put("serverWaitMs", 0L).put("command", command());
        assertThrows(JSONException.class, () -> Protocol.commandResponse(missing));
        JSONObject missingWait = new JSONObject().put("version", 1).put("serverTime", 10000L).put("command", command());
        assertSame(missingWait.getJSONObject("command"), Protocol.commandResponse(missingWait));
        assertEquals(-1L, Protocol.serverWaitMs(missingWait));
        JSONObject withWait = new JSONObject().put("version", 1).put("serverTime", 10000L).put("serverWaitMs", 25L).put("command", command());
        assertEquals(25L, Protocol.serverWaitMs(withWait));
        JSONObject negativeWait = new JSONObject().put("version", 1).put("serverTime", 10000L).put("serverWaitMs", -1L).put("command", command());
        assertThrows(JSONException.class, () -> Protocol.commandResponse(negativeWait));
        assertThrows(JSONException.class, () -> Protocol.serverWaitMs(negativeWait));
        JSONObject version = new JSONObject().put("version", 2).put("serverTime", 10000L).put("serverWaitMs", 0L).put("command", command());
        assertThrows(JSONException.class, () -> Protocol.commandResponse(version));
    }
    @Test public void rejectsMalformedCommandIdentity() throws Exception {
        JSONObject invalid = new JSONObject().put("version", 1).put("serverTime", 10000L).put("serverWaitMs", 0L).put("command", command().put("commandId", "invalid"));
        assertThrows(IllegalArgumentException.class, () -> Protocol.commandResponse(invalid));
    }
    @Test public void resultPreservesDeliveryBindingAndStatus() throws Exception {
        String commandId = UUID.randomUUID().toString(), deliveryId = UUID.randomUUID().toString(), sessionId = UUID.randomUUID().toString();
        JSONObject result = Protocol.successResult("phone-example", sessionId, commandId, deliveryId, new JSONObject().put("observed", true));
        assertEquals(commandId, result.getString("commandId")); assertEquals(deliveryId, result.getString("deliveryId"));
        assertEquals(sessionId, result.getString("sessionId")); assertTrue(result.getBoolean("ok"));
        assertEquals("completed", result.getString("status"));
        JSONObject unknown = Protocol.errorResult("phone-example", sessionId, commandId, deliveryId, "outcome_unknown", "outcome_unknown", "completion_not_observed");
        assertFalse(unknown.getBoolean("ok")); assertEquals("outcome_unknown", unknown.getString("status"));
    }
}
