package eu.astancu.rcmcp.android;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public final class ConfigurationImportTest {
    private static final String TOKEN = "0123456789abcdef0123456789abcdef";
    private static final String VALID = "{\"endpoint\":\"https://controller.example/\",\"device\":\"tablet-example\",\"token\":\"" + TOKEN + "\"}";
    private ConfigurationImport parse(String value) { return ConfigurationImport.parse(value.getBytes(StandardCharsets.UTF_8)); }
    private void reject(String value) { assertThrows(IllegalArgumentException.class, () -> parse(value)); }

    @Test public void normalizesAndValidatesWithoutProvisioning() throws Exception {
        ConfigurationImport imported = ConfigurationImport.read(new ByteArrayInputStream(VALID.getBytes(StandardCharsets.UTF_8)));
        assertEquals("https://controller.example", imported.endpoint);
        assertEquals("tablet-example", imported.device);
        assertEquals(TOKEN, imported.token);
        assertEquals(TOKEN, parse(VALID.replace("0123", "\\u0030123")).token);
    }

    @Test public void rejectsMissingUnknownDuplicateAndNonStringMembers() {
        reject("{}");
        reject(VALID.replace("\"device\":\"tablet-example\",", ""));
        reject(VALID.replace("\"device\"", "\"deviceId\""));
        reject(VALID.replace("}", ",\"enabled\":true}"));
        reject(VALID.replace("}", ",\"token\":\"" + TOKEN + "\"}"));
        for (String value : new String[]{"null", "true", "29", "[]", "{}"}) {
            reject(VALID.replace("\"tablet-example\"", value));
        }
    }

    @Test public void rejectsMalformedAndLenientJsonExtensions() {
        for (String value : new String[]{"", "[]", VALID + "x", VALID + VALID, VALID.substring(0, VALID.length() - 1),
                VALID.replace('"', '\''), VALID.replace("\"device\"", "device"), VALID.replace("}", ",}"),
                VALID.replace("tablet-example", "tablet\nexample"), VALID.replace("tablet-example", "\\uZZZZ"),
                VALID.replace("tablet-example", "\\uD800"), VALID.replace("tablet-example", "\\q")}) reject(value);
        assertThrows(IllegalArgumentException.class, () -> ConfigurationImport.parse(new byte[]{(byte) 0xc3, 0x28}));
    }

    @Test public void rejectsUnsafeEndpointsDevicesAndTokens() {
        reject(VALID.replace("https://controller.example/", "http://controller.example/"));
        reject(VALID.replace("https://controller.example/", "https://controller.example/path"));
        reject(VALID.replace("tablet-example", "invalid device"));
        reject(VALID.replace(TOKEN, "short"));
        reject(VALID.replace(TOKEN, TOKEN + " "));
    }

    @Test public void readsAtMostLimitPlusOneAndAcceptsExactByteLimit() throws Exception {
        String exact = VALID + " ".repeat(ConfigurationImport.MAX_BYTES - VALID.getBytes(StandardCharsets.UTF_8).length);
        assertEquals(TOKEN, parse(exact).token);
        reject(exact + " ");
        ByteArrayInputStream stream = new ByteArrayInputStream((exact + " ".repeat(10000)).getBytes(StandardCharsets.UTF_8));
        int initial = stream.available();
        assertThrows(IllegalArgumentException.class, () -> ConfigurationImport.read(stream));
        assertEquals(ConfigurationImport.MAX_BYTES + 1, initial - stream.available());
        reject(VALID + "é".repeat(ConfigurationImport.MAX_BYTES / 2));
    }
}
