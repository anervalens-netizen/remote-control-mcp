package eu.astancu.rcmcp.android;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class PairingValidatorTest {
    @Test public void matchesControllerCredentialAndDeviceConstraints() {
        assertTrue(PairingValidator.validToken("0123456789abcdef0123456789abcdef"));
        assertFalse(PairingValidator.validToken("too-short"));
        assertFalse(PairingValidator.validToken("0123456789abcdef 0123456789abcdef"));
        assertTrue(PairingValidator.validDeviceId("phone-example"));
        assertTrue(PairingValidator.validDeviceId("Phone_2.test"));
        assertFalse(PairingValidator.validDeviceId("phone example"));
        assertFalse(PairingValidator.validDeviceId(""));
        assertFalse(PairingValidator.validDeviceId("x".repeat(65)));
    }
}
