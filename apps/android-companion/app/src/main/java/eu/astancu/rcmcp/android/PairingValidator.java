package eu.astancu.rcmcp.android;

import java.util.regex.Pattern;

/** Pure validation shared by onboarding and JVM tests. */
public final class PairingValidator {
    private static final Pattern DEVICE = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");
    private static final Pattern TOKEN = Pattern.compile("^\\S{32,}$");

    private PairingValidator() {}

    public static boolean validToken(String value) {
        return value != null && TOKEN.matcher(value).matches();
    }

    public static boolean validDeviceId(String value) {
        return value != null && DEVICE.matcher(value.trim()).matches();
    }
}
