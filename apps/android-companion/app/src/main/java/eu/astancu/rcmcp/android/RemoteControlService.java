package eu.astancu.rcmcp.android;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

public final class RemoteControlService extends Service {
    public static final String ACTION_START = "eu.astancu.rcmcp.android.START";
    public static final String ACTION_STOP = "eu.astancu.rcmcp.android.STOP";
    private static final String CHANNEL_ID = "remote_control";
    private static final int NOTIFICATION_ID = 371;
    private static final long POLL_READ_TIMEOUT_MS = 35_000L;
    private static final long CONNECT_TIMEOUT_MS = 10_000L;

    private final Object loopLock = new Object();
    private volatile boolean running;
    private volatile long loopGeneration;
    private volatile HttpURLConnection activeConnection;
    private static volatile RemoteControlService instance;
    private static volatile String lastTransportState = "idle";
    private static volatile String lastTransportDetail = "not_started";
    private static volatile long lastTransportAt;
    private ExecutorService loopExecutor;
    private ConfigRepository config;
    private CommandLedger ledger;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        config = new ConfigRepository(this);
        ShellBridgeManager.init(this);
        ledger = new CommandLedger(new SharedPrefsLedgerStore(getSharedPreferences("command_ledger", MODE_PRIVATE)));
        ledger.markInterruptedAsUnknown();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean stopRequested = intent != null && ACTION_STOP.equals(intent.getAction());
        boolean explicitStart = intent != null && ACTION_START.equals(intent.getAction());
        RemoteControlStartPolicy.Decision decision = RemoteControlStartPolicy.decide(
                stopRequested, explicitStart, config.enabled(),
                hasControlNotificationPermission(this), config.authBlocked());

        if (decision == RemoteControlStartPolicy.Decision.STOP_NOT_STICKY) {
            stopLocally();
            return START_NOT_STICKY;
        }
        if (explicitStart && !config.setEnabledDurably(true)) {
            stopLocally();
            return START_NOT_STICKY;
        }

        // START_STICKY recreation arrives with a null intent after the process is
        // reclaimed. The pure policy above is JVM-tested for local STOP, desired
        // enablement, notification permission and authentication blocking.
        startForeground(NOTIFICATION_ID, notification());
        startControlLoop();
        return START_STICKY;
    }

    private void startControlLoop() {
        synchronized (loopLock) {
            if (running) return;
            running = true;
            loopExecutor = Executors.newSingleThreadExecutor(r -> {
                Thread thread = new Thread(r, "rcmcp-control-loop");
                thread.setDaemon(true);
                return thread;
            });
            long epoch = ++loopGeneration;
            loopExecutor.execute(() -> runControlLoop(epoch));
        }
    }

    public static boolean isControlLoopRunning() {
        RemoteControlService service = instance;
        return service != null && service.running;
    }

    public static String transportStatus() {
        return lastTransportState + " / " + lastTransportDetail + " / " + lastTransportAt;
    }

    public static boolean hasActiveVpnRoute(Context context, String endpoint) {
        android.net.ConnectivityManager connectivity =
                (android.net.ConnectivityManager) context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) return false;
        final java.net.InetAddress destination;
        try {
            String host = new URL(EndpointValidator.validateAndNormalize(endpoint)).getHost();
            destination = android.net.InetAddresses.parseNumericAddress(host);
        } catch (IllegalArgumentException | IOException invalidOrNonNumericEndpoint) {
            return false;
        }
        for (android.net.Network network : connectivity.getAllNetworks()) {
            android.net.NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
            if (capabilities == null
                    || !capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) continue;
            android.net.LinkProperties properties = connectivity.getLinkProperties(network);
            if (properties == null) continue;
            for (android.net.RouteInfo route : properties.getRoutes()) {
                if (route.matches(destination)) return true;
            }
        }
        return false;
    }

    public static boolean hasControlNotificationPermission(Context context) {
        return Build.VERSION.SDK_INT < 33
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean recoverIfDesired(android.content.Context context) {
        if (isControlLoopRunning()) return true;
        ConfigRepository recoveryConfig = new ConfigRepository(context);
        if (!recoveryConfig.enabled() || recoveryConfig.authBlocked()
                || !hasControlNotificationPermission(context)) return false;
        Intent start = new Intent(context, RemoteControlService.class).setAction(ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(start);
            else context.startService(start);
            return true;
        } catch (RuntimeException blocked) {
            return false;
        }
    }

    public static boolean stopFromOwner(android.content.Context context) {
        RemoteControlService service = instance;
        if (service != null) return service.stopLocally();
        return new ConfigRepository(context).setEnabledDurably(false);
    }

    private boolean stopLocally() {
        boolean durableStop = config.setEnabledDurably(false);
        running = false;
        loopGeneration++;
        ShellBridgeManager.cancelActive();
        HttpURLConnection connection = activeConnection;
        if (connection != null) connection.disconnect();
        synchronized (loopLock) {
            if (loopExecutor != null) {
                loopExecutor.shutdownNow();
                loopExecutor = null;
            }
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        return durableStop;
    }

    private boolean isActive(long epoch) { return running && epoch == loopGeneration && config.enabled() && !config.authBlocked() && hasControlNotificationPermission(this); }

    private void runControlLoop(long epoch) {
        String sessionId = Protocol.newSessionId();
        long backoffMs = 1000L;
        boolean uncertain = false;
        while (isActive(epoch) && !Thread.currentThread().isInterrupted() && !uncertain) {
            if (config.authBlocked()) break;
            try {
                lastTransportState = "connecting";
                lastTransportDetail = "poll";
                lastTransportAt = System.currentTimeMillis();
                PollResponse poll = poll(sessionId);
                lastTransportState = "connected";
                lastTransportDetail = "poll_ok";
                lastTransportAt = System.currentTimeMillis();
                backoffMs = 1000L;
                if (!isActive(epoch)) break;
                if (poll.command == null) continue;

                JSONObject command = poll.command;
                String commandId = command.getString("commandId");
                String deliveryId = command.getString("deliveryId");
                JSONObject request = command.getJSONObject("request");
                long serverTime = poll.serverTime;
                long expiresAt = command.getLong("expiresAt");
                Deadline deadline = Deadline.fromServerTiming(serverTime, expiresAt,
                        poll.requestStartedElapsedMs, poll.responseReceivedElapsedMs, poll.serverWaitMs);

                if (!ledger.reserve(commandId, deliveryId)) {
                    JSONObject duplicate = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                            "outcome_unknown", "outcome_unknown", "command_identity_already_seen");
                    if (!uploadResult(duplicate)) break;
                    continue;
                }
                if (deadline.isExpired(SystemClock.elapsedRealtime())) {
                    ledger.finish(commandId, deliveryId, CommandLedger.ERROR);
                    JSONObject expired = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                            "error", "expired", "command_expired_before_execution");
                    if (!uploadResult(expired)) break;
                    continue;
                }

                ledger.markStarted(commandId, deliveryId);
                JSONObject result;
                if ("shell".equals(request.optString("operation"))) {
                    ExecutionLease lease = new ExecutionLease(
                            deadline.localDeadlineElapsedMs(), SystemClock::elapsedRealtime, () -> isActive(epoch));
                    if (!lease.beginEffect()) {
                        ledger.finish(commandId, deliveryId, CommandLedger.ERROR);
                        result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                "error", "expired_or_paused", "shell_command_not_started");
                    } else {
                        try {
                            JSONObject shellResult = ShellBridgeManager.execute(
                                    request.getString("command"),
                                    lease,
                                    deadline.localDeadlineElapsedMs(),
                                    request.optLong("timeoutMs", 120_000L),
                                    request.optInt("maxOutputBytes", 1024 * 1024));
                            if (shellResult.optBoolean("timedOut", false)) {
                                ledger.finish(commandId, deliveryId, CommandLedger.OUTCOME_UNKNOWN);
                                String detail = shellResult.optBoolean("terminationVerified", false)
                                        ? "shell_command_timed_out_process_tree_terminated"
                                        : "shell_command_timed_out_termination_unverified";
                                result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                        "outcome_unknown", "shell_timeout", detail);
                            } else if (shellResult.optBoolean("cancelled", false)) {
                                ledger.finish(commandId, deliveryId, CommandLedger.OUTCOME_UNKNOWN);
                                result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                        "outcome_unknown", "shell_cancelled", "shell_effect_may_have_started");
                            } else {
                                ledger.finish(commandId, deliveryId, CommandLedger.COMPLETED);
                                result = Protocol.successResult(config.deviceId(), sessionId, commandId, deliveryId, shellResult);
                            }
                        } catch (ShellBridgeManager.ShellBridgeException failure) {
                            boolean knownPreEffectFailure =
                                    "shell_unavailable".equals(failure.code)
                                    || "shell_busy".equals(failure.code)
                                    || "shell_cancelled_before_start".equals(failure.code)
                                    || "shell_expired_before_start".equals(failure.code)
                                    || "shell_execution_conflict".equals(failure.code)
                                    || "shell_command_stream_failed".equals(failure.code);
                            boolean unknown = !knownPreEffectFailure;
                            ledger.finish(commandId, deliveryId,
                                    unknown ? CommandLedger.OUTCOME_UNKNOWN : CommandLedger.ERROR);
                            result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                    unknown ? "outcome_unknown" : "error", failure.code, failure.getMessage());
                            // Optional-shell failure never tears down the independent
                            // Accessibility/Tailscale baseline. The command identity
                            // is still fail-closed and never replayed.
                        }
                    }
                } else {
                    RemoteAccessibilityService accessibility = RemoteAccessibilityService.current();
                    if (accessibility == null) {
                    ledger.finish(commandId, deliveryId, CommandLedger.ERROR);
                    result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                            "error", "accessibility_unavailable", "accessibility_service_unavailable");
                } else {
                    ExecutionLease lease = new ExecutionLease(deadline.localDeadlineElapsedMs(), SystemClock::elapsedRealtime, () -> isActive(epoch));
                    CompletableFuture<JSONObject> action = accessibility.execute(request, lease);
                    long remaining = Math.max(1L, deadline.localDeadlineElapsedMs() - SystemClock.elapsedRealtime());
                    try {
                        JSONObject actionResult = action.get(Math.min(remaining, 35_000L), TimeUnit.MILLISECONDS);
                        ledger.finish(commandId, deliveryId, CommandLedger.COMPLETED);
                        result = Protocol.successResult(config.deviceId(), sessionId, commandId, deliveryId, actionResult);
                    } catch (RemoteAccessibilityService.ActionFailure failure) {
                        ledger.finish(commandId, deliveryId, CommandLedger.ERROR);
                        result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                "error", failure.code, "accessibility_action_failed");
                    } catch (java.util.concurrent.TimeoutException timeout) {
                        TimeoutDisposition disposition = TimeoutDisposition.cancel(lease);
                        action.cancel(false);
                        ledger.finish(commandId, deliveryId, disposition.ledgerStatus);
                        result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                disposition.protocolStatus, disposition.code, disposition.message);
                        uncertain = disposition.uncertain;
                    } catch (InterruptedException interrupted) {
                        lease.cancel();
                        action.cancel(false);
                        Thread.currentThread().interrupt();
                        ledger.finish(commandId, deliveryId, CommandLedger.OUTCOME_UNKNOWN);
                        result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                "outcome_unknown", "outcome_unknown", "control_loop_interrupted");
                        uncertain = true;
                    } catch (ExecutionException failed) {
                        Throwable cause = failed.getCause();
                        if (cause instanceof RemoteAccessibilityService.ActionFailure actionFailure) {
                            boolean unknown = "outcome_unknown".equals(actionFailure.code);
                            uncertain = unknown;
                            ledger.finish(commandId, deliveryId, unknown ? CommandLedger.OUTCOME_UNKNOWN : CommandLedger.ERROR);
                            result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                    unknown ? "outcome_unknown" : "error", actionFailure.code, "accessibility_action_failed");
                        } else {
                            ledger.finish(commandId, deliveryId, CommandLedger.ERROR);
                            result = Protocol.errorResult(config.deviceId(), sessionId, commandId, deliveryId,
                                    "error", "accessibility_error", "accessibility_action_failed");
                        }
                    }
                }
                }
                if (!uploadResult(result)) break;
            } catch (AuthFailure auth) {
                lastTransportState = "auth_error";
                lastTransportDetail = "credential_rejected";
                lastTransportAt = System.currentTimeMillis();
                config.setAuthBlocked();
                break;
            } catch (ProtocolFailure protocol) {
                lastTransportState = "protocol_error";
                lastTransportDetail = "controller_response";
                lastTransportAt = System.currentTimeMillis();
                // A command may have been dispatched even when its poll response
                // was lost. Reusing that session would correctly suppress replay
                // forever, so reconnect under a fresh session and let the
                // controller tombstone any unresolved delivery.
                sessionId = Protocol.newSessionId();
                if (!sleepBackoff(backoffMs)) break;
                backoffMs = Math.min(30_000L, backoffMs * 2L);
            } catch (IOException | JSONException networkOrJson) {
                lastTransportState = "network_error";
                lastTransportDetail = networkOrJson.getClass().getSimpleName() + ":" + String.valueOf(networkOrJson.getMessage());
                lastTransportAt = System.currentTimeMillis();
                sessionId = Protocol.newSessionId();
                if (!sleepBackoff(withJitter(backoffMs))) break;
                backoffMs = Math.min(30_000L, backoffMs * 2L);
            } catch (RuntimeException unexpected) {
                lastTransportState = "runtime_error";
                lastTransportDetail = unexpected.getClass().getSimpleName() + ":" + String.valueOf(unexpected.getMessage());
                lastTransportAt = System.currentTimeMillis();
                // Persistence or local runtime failures are not safe retry
                // boundaries. Stop visibly rather than risk an ambiguous effect.
                break;
            }
        }
        if (epoch == loopGeneration) {
            running = false;
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> { if (epoch == loopGeneration) stopLocally(); });
        }
    }

    private PollResponse poll(String sessionId) throws IOException, JSONException, ProtocolFailure, AuthFailure {
        JSONObject state = Protocol.state(this, RemoteAccessibilityService.isRunning(), false);
        JSONObject body = Protocol.pollBody(config.deviceId(), sessionId, state);
        long requestStartedElapsedMs = SystemClock.elapsedRealtime();
        HttpResponse response = post("/android/v1/poll", body.toString());
        long responseReceivedElapsedMs = SystemClock.elapsedRealtime();
        if (response.status == 401 || response.status == 403) throw new AuthFailure();
        if (response.status < 200 || response.status >= 300) throw new ProtocolFailure();
        if (response.body.isBlank()) throw new ProtocolFailure();
        JSONObject parsed = new JSONObject(response.body);
        JSONObject command = Protocol.commandResponse(parsed);
        return new PollResponse(parsed.getLong("serverTime"), Protocol.serverWaitMs(parsed),
                requestStartedElapsedMs, responseReceivedElapsedMs, command);
    }

    private boolean uploadResult(JSONObject result) {
        long backoff = 1000L;
        JSONObject upload = result;
        boolean compactFallback = false;
        while (running && !Thread.currentThread().isInterrupted()) {
            try {
                HttpResponse response = post("/android/v1/result", upload.toString());
                if (response.status == 401 || response.status == 403) {
                    config.setAuthBlocked();
                    return false;
                }
                if (response.status >= 200 && response.status < 300) {
                    try {
                        JSONObject ack = new JSONObject(response.body);
                        if (ack.getInt("version") == Protocol.VERSION && ack.getBoolean("accepted")) return true;
                    } catch (JSONException malformed) { return false; }
                    return false;
                }
                if (response.status == 413 && !compactFallback) {
                    String commandId = upload.optString("commandId", "");
                    String deliveryId = upload.optString("deliveryId", "");
                    ledger.finish(commandId, deliveryId, CommandLedger.OUTCOME_UNKNOWN);
                    upload = Protocol.errorResult(
                            upload.optString("device", config.deviceId()),
                            upload.optString("sessionId", ""),
                            commandId, deliveryId,
                            "outcome_unknown", "result_too_large",
                            "result_payload_rejected_after_execution");
                    compactFallback = true;
                    backoff = 250L;
                    continue;
                }
                if (response.status >= 400 && response.status < 500 && response.status != 429) return false;
            } catch (IOException ignored) {
                // Retry the exact result envelope, never the operation.
            }
            if (!sleepBackoff(withJitter(backoff))) return false;
            backoff = Math.min(30_000L, backoff * 2L);
        }
        return false;
    }

    private HttpResponse post(String path, String body) throws IOException {
        String endpoint = EndpointValidator.validateAndNormalize(config.endpoint());
        try {
            EndpointValidator.requireSafeTransport(endpoint, hasActiveVpnRoute(this, endpoint));
        } catch (IllegalArgumentException unsafeTransport) {
            // Missing/recovering VPN is a transport outage, not a fatal local
            // configuration error. Poll backs off; result upload retries the
            // exact envelope and never replays the device effect.
            throw new IOException(unsafeTransport.getMessage(), unsafeTransport);
        }
        URL url = new URL(endpoint + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        activeConnection = connection;
        try {
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout((int) CONNECT_TIMEOUT_MS);
        connection.setReadTimeout((int) POLL_READ_TIMEOUT_MS);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Bearer " + config.token());
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "application/json");
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(payload);
        }
        int status = connection.getResponseCode();
        InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String response = input == null ? "" : readLimited(input, 16 * 1024 * 1024);
        return new HttpResponse(status, response);
        } finally {
            connection.disconnect();
            if (activeConnection == connection) activeConnection = null;
        }
    }

    private static String readLimited(InputStream input, int maxBytes) throws IOException {
        try (InputStream source = input; BufferedReader reader = new BufferedReader(new InputStreamReader(source, StandardCharsets.UTF_8))) {
            StringBuilder text = new StringBuilder();
            char[] buffer = new char[4096];
            int total = 0;
            int read;
            while ((read = reader.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) throw new IOException("response_too_large");
                text.append(buffer, 0, read);
            }
            return text.toString();
        }
    }

    private boolean sleepBackoff(long millis) {
        try {
            Thread.sleep(Math.min(30_000L, millis));
            return running;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static long withJitter(long base) {
        long spread = Math.max(1L, base / 4L);
        return Math.max(250L, base - spread + ThreadLocalRandom.current().nextLong(spread * 2L + 1L));
    }

    private Notification notification() {
        Intent stop = new Intent(this, RemoteControlService.class).setAction(ACTION_STOP);
        PendingIntent pendingStop = PendingIntent.getService(this, 371, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_manage)
                .setContentTitle("RC Android Companion")
                .setContentText("Owner control active; local STOP is available")
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "STOP", pendingStop).build())
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Remote control", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Visible owner-operated remote control status");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        loopGeneration++;
        if (instance == this) instance = null;
        HttpURLConnection connection = activeConnection;
        if (connection != null) connection.disconnect();
        synchronized (loopLock) {
            if (loopExecutor != null) loopExecutor.shutdownNow();
            loopExecutor = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private static final class PollResponse {
        final long serverTime;
        final long serverWaitMs;
        final long requestStartedElapsedMs;
        final long responseReceivedElapsedMs;
        final JSONObject command;
        PollResponse(long serverTime, long serverWaitMs, long requestStartedElapsedMs,
                     long responseReceivedElapsedMs, JSONObject command) {
            this.serverTime = serverTime;
            this.serverWaitMs = serverWaitMs;
            this.requestStartedElapsedMs = requestStartedElapsedMs;
            this.responseReceivedElapsedMs = responseReceivedElapsedMs;
            this.command = command;
        }
    }

    private static final class HttpResponse {
        final int status;
        final String body;
        HttpResponse(int status, String body) { this.status = status; this.body = body; }
    }

    private static final class AuthFailure extends Exception {}
    private static final class ProtocolFailure extends Exception {}
}
