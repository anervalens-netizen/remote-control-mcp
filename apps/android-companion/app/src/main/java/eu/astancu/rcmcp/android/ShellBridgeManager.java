package eu.astancu.rcmcp.android;

import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.RemoteException;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

import rikka.shizuku.Shizuku;

public final class ShellBridgeManager {
    private static final String TAG = "RCMCP-ShellBridge";
    private static final int REQUEST_CODE = 381;
    private static final Object LOCK = new Object();
    private static final int RESULT_OVERHEAD_BYTES = 64 * 1024;

    private static volatile boolean initialized;
    private static volatile Context appContext;
    private static volatile IShellBridge bridge;
    private static volatile int bridgeUid = -1;
    private static volatile String reason = "shizuku_not_ready";
    private static volatile boolean binding;
    private static final ShellDispatchGate DISPATCH_GATE = new ShellDispatchGate();

    private ShellBridgeManager() {}

    private static final Shizuku.OnBinderReceivedListener BINDER_RECEIVED = () -> {
        reason = "shizuku_binder_ready";
        bindIfPermitted();
    };

    private static final Shizuku.OnBinderDeadListener BINDER_DEAD = () -> {
        synchronized (LOCK) {
            bridge = null;
            bridgeUid = -1;
            binding = false;
            DISPATCH_GATE.clear();
            reason = "shizuku_service_stopped";
        }
    };

    private static final Shizuku.OnRequestPermissionResultListener PERMISSION_RESULT = (requestCode, grantResult) -> {
        if (requestCode != REQUEST_CODE) return;
        if (grantResult == PackageManager.PERMISSION_GRANTED) {
            reason = "permission_granted";
            bindIfPermitted();
        } else {
            synchronized (LOCK) {
                bridge = null;
                bridgeUid = -1;
                binding = false;
                DISPATCH_GATE.clear();
                reason = "permission_denied";
            }
        }
    };

    private static final ServiceConnection CONNECTION = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            Log.i(TAG, "onServiceConnected name=" + name + " alive=" + service.isBinderAlive());
            IShellBridge candidate = IShellBridge.Stub.asInterface(service);
            try {
                int uid = candidate.uid();
                synchronized (LOCK) {
                    bridge = candidate;
                    bridgeUid = uid;
                    reason = uid == 2000 ? "ready" : "unexpected_uid_" + uid;
                }
                Log.i(TAG, "bridge probe uid=" + uid + " reason=" + reason);
            } catch (RemoteException failure) {
                synchronized (LOCK) {
                    bridge = null;
                    bridgeUid = -1;
                    reason = "bridge_probe_failed";
                }
                Log.e(TAG, "bridge probe failed", failure);
            } finally {
                binding = false;
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            synchronized (LOCK) {
                bridge = null;
                bridgeUid = -1;
                binding = false;
                DISPATCH_GATE.clear();
                reason = "bridge_disconnected";
            }
        }
    };

    public static void init(Context context) {
        if (initialized) return;
        synchronized (LOCK) {
            if (initialized) return;
            appContext = context.getApplicationContext();
            Shizuku.addBinderReceivedListenerSticky(BINDER_RECEIVED);
            Shizuku.addBinderDeadListener(BINDER_DEAD);
            Shizuku.addRequestPermissionResultListener(PERMISSION_RESULT);
            initialized = true;
        }
    }

    public static void requestPermissionAndBind(Context context) {
        init(context);
        if (!Shizuku.pingBinder()) {
            reason = "shizuku_service_not_running";
            return;
        }
        try {
            if (Shizuku.isPreV11()) {
                reason = "shizuku_too_old";
                return;
            }
            if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
                bindIfPermitted();
                return;
            }
            if (Shizuku.shouldShowRequestPermissionRationale()) {
                reason = "permission_denied";
                return;
            }
            reason = "permission_requested";
            Shizuku.requestPermission(REQUEST_CODE);
        } catch (RuntimeException failure) {
            reason = "shizuku_api_error";
        }
    }

    private static void bindIfPermitted() {
        Context context = appContext;
        if (context == null || !Shizuku.pingBinder()) {
            reason = "shizuku_service_not_running";
            return;
        }
        try {
            if (Shizuku.isPreV11()) {
                reason = "shizuku_too_old";
                return;
            }
            if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) {
                reason = "permission_required";
                return;
            }
            synchronized (LOCK) {
                if (isReady() || binding) return;
                binding = true;
            }
            ComponentName component = new ComponentName(context, ShellUserService.class);
            Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(component)
                    .daemon(true)
                    .processNameSuffix("shell")
                    .tag("rcmcp-shell-v2")
                    .version(2);
            Runnable bind = () -> {
                try {
                    int existing = Shizuku.peekUserService(args, CONNECTION);
                    Log.i(TAG, "peekUserService=" + existing);
                    if (existing < 0) Shizuku.bindUserService(args, CONNECTION);
                    reason = "binding";
                    Log.i(TAG, "bind requested existing=" + existing);
                } catch (RuntimeException failure) {
                    binding = false;
                    reason = "bind_failed";
                }
            };
            if (Looper.myLooper() == Looper.getMainLooper()) bind.run();
            else new android.os.Handler(Looper.getMainLooper()).post(bind);
        } catch (RuntimeException failure) {
            binding = false;
            reason = "shizuku_api_error";
        }
    }

    public static boolean isReady() {
        IShellBridge current = bridge;
        if (current == null || !current.asBinder().isBinderAlive() || bridgeUid != 2000) return false;
        try {
            return Shizuku.pingBinder()
                    && !Shizuku.isPreV11()
                    && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (RuntimeException failure) {
            return false;
        }
    }

    public static int uid() {
        return isReady() ? bridgeUid : -1;
    }

    public static String reason() {
        if (isReady()) return "ready";
        if (!initialized) return "not_initialized";
        try {
            if (!Shizuku.pingBinder()) return "shizuku_service_not_running";
            if (Shizuku.isPreV11()) return "shizuku_too_old";
            if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) return "permission_required";
        } catch (RuntimeException failure) {
            return "shizuku_api_error";
        }
        return reason;
    }

    public static JSONObject execute(String command, ExecutionLease lease,
                                     long deadlineElapsedMs, long timeoutMs, int maxOutputBytes)
            throws ShellBridgeException {
        IShellBridge current = bridge;
        if (!isReady() || current == null) throw new ShellBridgeException("shell_unavailable", reason());

        String executionId = UUID.randomUUID().toString();
        long waitMs = Math.max(0L, deadlineElapsedMs - android.os.SystemClock.elapsedRealtime());
        try {
            if (!DISPATCH_GATE.acquire(executionId, waitMs)) {
                throw new ShellBridgeException("shell_expired_before_start", "deadline_elapsed_while_waiting_for_prior_shell");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new ShellBridgeException("shell_cancelled_before_start", "interrupted_while_waiting_for_prior_shell");
        }

        ParcelFileDescriptor commandRead = null;
        ParcelFileDescriptor commandWrite = null;
        try {
            // Once the dispatch gate owns an execution ID, STOP can cancel it
            // through cancelActive(). Recheck the lease here to close the race
            // where STOP happened after service admission but before gate acquire.
            if (lease == null || !lease.mayRun()) {
                throw new ShellBridgeException("shell_cancelled_before_start", "control_session_stopped_before_shell_dispatch");
            }
            byte[] commandBytes = command.getBytes(StandardCharsets.UTF_8);
            ParcelFileDescriptor[] commandPipe = ParcelFileDescriptor.createPipe();
            commandRead = commandPipe[0];
            commandWrite = commandPipe[1];

            ParcelFileDescriptor descriptor = current.exec(
                    executionId, commandRead, commandBytes.length,
                    deadlineElapsedMs, timeoutMs, maxOutputBytes);
            commandRead.close();
            commandRead = null;
            if (descriptor == null) {
                throw new ShellBridgeException("shell_protocol_error", "missing_shell_result_pipe");
            }

            IOException commandWriteFailure = null;
            try (OutputStream commandOutput = new ParcelFileDescriptor.AutoCloseOutputStream(commandWrite)) {
                commandWrite = null;
                commandOutput.write(commandBytes);
                commandOutput.flush();
            } catch (IOException failure) {
                commandWriteFailure = failure;
            }

            int limit = Math.addExact(Math.max(1024, maxOutputBytes), RESULT_OVERHEAD_BYTES);
            String raw;
            try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
                raw = readLimited(input, limit);
            } catch (IOException resultFailure) {
                if (commandWriteFailure != null) resultFailure.addSuppressed(commandWriteFailure);
                throw resultFailure;
            }
            JSONObject result = new JSONObject(raw);
            if (result.has("error")) {
                throw new ShellBridgeException(result.optString("error", "shell_error"),
                        result.optString("message", "shell_exec_failed"));
            }
            return result;
        } catch (RemoteException failure) {
            markBridgeDisconnected(current);
            throw new ShellBridgeException("shell_transport_lost", "shizuku_user_service_disconnected");
        } catch (IOException failure) {
            if (!isReady()) {
                throw new ShellBridgeException("shell_transport_lost", "shizuku_user_service_disconnected");
            }
            throw new ShellBridgeException("shell_protocol_error", "shell_stream_failed");
        } catch (JSONException | ArithmeticException failure) {
            throw new ShellBridgeException("shell_protocol_error", "invalid_shell_result");
        } finally {
            closeQuietly(commandRead);
            closeQuietly(commandWrite);
            DISPATCH_GATE.release(executionId);
        }
    }

    public static void cancelActive() {
        IShellBridge current = bridge;
        String executionId = DISPATCH_GATE.activeExecutionId();
        if (current == null || executionId == null) return;
        try {
            current.cancel(executionId);
        } catch (RemoteException failure) {
            markBridgeDisconnected(current);
        }
    }

    private static void closeQuietly(ParcelFileDescriptor descriptor) {
        if (descriptor == null) return;
        try {
            descriptor.close();
        } catch (IOException ignored) {}
    }

    private static void markBridgeDisconnected(IShellBridge expected) {
        synchronized (LOCK) {
            if (bridge == expected) {
                bridge = null;
                bridgeUid = -1;
                reason = "bridge_disconnected";
            }
        }
    }

    private static String readLimited(InputStream input, int maxBytes) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maxBytes, 64 * 1024));
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) throw new IOException("shell_result_too_large");
            output.write(buffer, 0, read);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    public static final class ShellBridgeException extends Exception {
        public final String code;
        public ShellBridgeException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
