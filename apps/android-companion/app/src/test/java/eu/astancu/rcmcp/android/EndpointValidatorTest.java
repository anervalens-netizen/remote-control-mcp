package eu.astancu.rcmcp.android;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class EndpointValidatorTest {
    @Test public void normalizesHttpsEndpoint() {
        assertEquals("https://controller.example", EndpointValidator.validateAndNormalize("https://controller.example/"));
        assertThrows(IllegalArgumentException.class, () -> EndpointValidator.validateAndNormalize("https://controller.example/rc"));
    }

    @Test public void permitsOnlyTailscaleLiteralHttpAndRequiresAnActiveVpnAtSendTime() {
        String endpoint = EndpointValidator.validateAndNormalize("http://100.100.20.4:8080/");
        assertEquals("http://100.100.20.4:8080", endpoint);
        EndpointValidator.requireSafeTransport(endpoint, true);
        assertThrows(IllegalArgumentException.class, () -> EndpointValidator.requireSafeTransport(endpoint, false));
        EndpointValidator.requireSafeTransport("https://controller.example", false);
        assertThrows(IllegalArgumentException.class, () -> EndpointValidator.validateAndNormalize("http://controller.example"));
        assertThrows(IllegalArgumentException.class, () -> EndpointValidator.validateAndNormalize("http://127.0.0.1"));
    }

    @Test public void rejectsCredentialQueryAndFragment() {
        assertThrows(IllegalArgumentException.class, () -> EndpointValidator.validateAndNormalize("https://u:p@controller.example"));
        assertThrows(IllegalArgumentException.class, () -> EndpointValidator.validateAndNormalize("https://controller.example?token=secret"));
        assertThrows(IllegalArgumentException.class, () -> EndpointValidator.validateAndNormalize("https://controller.example/#fragment"));
    }
}
