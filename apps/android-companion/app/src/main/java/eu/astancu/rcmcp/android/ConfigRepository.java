package eu.astancu.rcmcp.android;

import android.content.Context;
import android.content.SharedPreferences;

public final class ConfigRepository {
    private static final String PREFS = "private_config";
    private static final String ENDPOINT = "endpoint";
    private static final String TOKEN = "token";
    private static final String DEVICE = "device";
    private static final String ENABLED = "enabled";
    private static final String AUTH_BLOCKED = "auth_blocked";
    private static final String CONTROL_GENERATION = "control_generation";

    private final SharedPreferences preferences;

    public ConfigRepository(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public String endpoint() { return preferences.getString(ENDPOINT, ""); }
    public String token() { return preferences.getString(TOKEN, ""); }
    public String deviceId() { return preferences.getString(DEVICE, Protocol.DEVICE_ID); }
    public boolean enabled() { return preferences.getBoolean(ENABLED, false); }
    public boolean authBlocked() { return preferences.getBoolean(AUTH_BLOCKED, false); }
    public long controlGeneration() { return preferences.getLong(CONTROL_GENERATION, 0L); }

    public boolean canSave(String endpoint, String token, String deviceId) {
        try {
            EndpointValidator.validateAndNormalize(endpoint);
        } catch (IllegalArgumentException invalid) {
            return false;
        }
        String effectiveToken = token == null || token.isBlank() ? token() : token;
        return PairingValidator.validToken(effectiveToken) && PairingValidator.validDeviceId(deviceId);
    }

    public boolean save(String endpoint, String token, String deviceId) {
        if (!canSave(endpoint, token, deviceId)) return false;
        String normalized = EndpointValidator.validateAndNormalize(endpoint);
        String effectiveToken = token == null || token.isBlank() ? token() : token;
        return preferences.edit().putString(ENDPOINT, normalized).putString(TOKEN, effectiveToken)
                .putString(DEVICE, deviceId.trim()).putBoolean(AUTH_BLOCKED, false).commit();
    }

    public void setEnabled(boolean enabled) {
        preferences.edit().putBoolean(ENABLED, enabled).apply();
    }

    public boolean setEnabledDurably(boolean enabled) {
        SharedPreferences.Editor editor = preferences.edit().putBoolean(ENABLED, enabled);
        if (!enabled) {
            long current = controlGeneration();
            long next = current >= Integer.MAX_VALUE ? 0L : current + 1L;
            editor.putLong(CONTROL_GENERATION, next);
        }
        return editor.commit();
    }

    public void clearAuthBlock() {
        preferences.edit().putBoolean(AUTH_BLOCKED, false).apply();
    }

    public void setAuthBlocked() {
        preferences.edit().putBoolean(AUTH_BLOCKED, true).putBoolean(ENABLED, false).apply();
    }
}
