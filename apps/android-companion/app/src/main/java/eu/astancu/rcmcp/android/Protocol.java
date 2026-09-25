package eu.astancu.rcmcp.android;

import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

public final class Protocol {
    public static final int VERSION = 1;
    public static final String DEVICE_ID = "phone-example";

    private Protocol() {}

    public static String newSessionId() {
        return UUID.randomUUID().toString();
    }

    public static JSONObject pollBody(String device, String sessionId, JSONObject state) throws JSONException {
        return new JSONObject().put("version", VERSION).put("device", device)
                .put("sessionId", sessionId).put("state", state);
    }

    public static JSONObject commandResponse(JSONObject body) throws JSONException {
        if (body.optInt("version", -1) != VERSION) throw new JSONException("unsupported_version");
        JSONObject command = body.optJSONObject("command");
        if (!body.has("serverTime") || body.getLong("serverTime") <= 0) throw new JSONException("server_time_missing");
        if (body.has("serverWaitMs") && body.getLong("serverWaitMs") < 0) throw new JSONException("server_wait_invalid");
        if (command == null) return null;
        require(command, "commandId");
        require(command, "deliveryId");
        require(command, "expiresAt");
        JSONObject request = command.optJSONObject("request");
        if (request == null) throw new JSONException("request_missing");
        java.util.UUID.fromString(command.getString("commandId"));
        java.util.UUID.fromString(command.getString("deliveryId"));
        return command;
    }

    public static long serverWaitMs(JSONObject body) throws JSONException {
        if (!body.has("serverWaitMs")) return -1L; // v1 controller compatibility
        long value = body.getLong("serverWaitMs");
        if (value < 0) throw new JSONException("server_wait_invalid");
        return value;
    }

    public static JSONObject errorResult(String device, String sessionId, String commandId,
                                         String deliveryId, String status, String code, String message) {
        try {
            return new JSONObject().put("version", VERSION).put("device", device)
                    .put("sessionId", sessionId).put("commandId", commandId)
                    .put("deliveryId", deliveryId).put("ok", false).put("status", status)
                    .put("error", new JSONObject().put("code", code).put("message", message));
        } catch (JSONException impossible) {
            throw new AssertionError(impossible);
        }
    }

    public static JSONObject successResult(String device, String sessionId, String commandId,
                                           String deliveryId, JSONObject result) {
        try {
            return new JSONObject().put("version", VERSION).put("device", device)
                    .put("sessionId", sessionId).put("commandId", commandId)
                    .put("deliveryId", deliveryId).put("ok", true).put("status", "completed")
                    .put("result", result == null ? new JSONObject() : result);
        } catch (JSONException impossible) {
            throw new AssertionError(impossible);
        }
    }

    public static JSONObject state(android.content.Context context, boolean accessibility, boolean paused) {
        android.os.PowerManager power = (android.os.PowerManager) context.getSystemService(android.content.Context.POWER_SERVICE);
        android.app.KeyguardManager keyguard = (android.app.KeyguardManager) context.getSystemService(android.content.Context.KEYGUARD_SERVICE);
        android.os.UserManager user = (android.os.UserManager) context.getSystemService(android.content.Context.USER_SERVICE);
        android.net.ConnectivityManager connectivity = (android.net.ConnectivityManager) context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        android.os.BatteryManager battery = (android.os.BatteryManager) context.getSystemService(android.content.Context.BATTERY_SERVICE);
        String network = physicalNetwork(connectivity);
        int batteryPercent = battery == null ? -1 : battery.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY);
        try {
            return new JSONObject().put("androidSdk", Build.VERSION.SDK_INT)
                    .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
                    .put("build", Build.DISPLAY).put("appVersion", BuildConfig.VERSION_NAME)
                    .put("uid", android.os.Process.myUid())
                    .put("screenOn", power != null && power.isInteractive())
                    .put("keyguardLocked", keyguard != null && keyguard.isKeyguardLocked())
                    .put("userUnlocked", user == null || user.isUserUnlocked())
                    .put("accessibility", accessibility).put("paused", paused)
                    .put("controlGeneration", new ConfigRepository(context).controlGeneration())
                    .put("shellAvailable", ShellBridgeManager.isReady()).put("network", network)
                    .put("batteryPercent", batteryPercent >= 0 && batteryPercent <= 100 ? batteryPercent : JSONObject.NULL);
        } catch (JSONException impossible) {
            throw new AssertionError(impossible);
        }
    }

    static String physicalNetwork(android.net.ConnectivityManager connectivity) {
        if (connectivity == null) return "offline";
        boolean wifi = false;
        boolean cellular = false;
        boolean ethernet = false;
        boolean other = false;
        for (android.net.Network candidate : connectivity.getAllNetworks()) {
            android.net.NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(candidate);
            if (capabilities == null || capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
                    || !capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
            wifi |= capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI);
            cellular |= capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR);
            ethernet |= capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET);
            other |= !capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                    && !capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)
                    && !capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET);
        }
        if (wifi && cellular) return "wifi+cellular";
        if (wifi) return "wifi";
        if (cellular) return "cellular";
        if (ethernet) return "ethernet";
        if (other) return "other";
        return "offline";
    }

    public static void require(JSONObject object, String name) throws JSONException {
        if (!object.has(name) || object.isNull(name)) throw new JSONException(name + "_missing");
    }

    public static int boundedMaxNodes(JSONObject request) throws JSONException {
        int maxNodes = request.optInt("maxNodes", 200);
        if (maxNodes < 1 || maxNodes > 1000) throw new JSONException("maxNodes_invalid");
        return maxNodes;
    }

    public static JSONArray emptyNodes() {
        return new JSONArray();
    }
}
