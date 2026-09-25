package eu.astancu.rcmcp.android;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

public final class RemoteAccessibilityService extends AccessibilityService {
    private static volatile RemoteAccessibilityService instance;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService screenshotEncoder = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "rcmcp-screenshot-encoder");
        thread.setDaemon(true);
        return thread;
    });
    private long generation;
    private ExecutionLease currentLease;
    private SnapshotFreshness.Metadata lastSnapshot;
    private String lastPackage;
    private int lastWindowId = -1;
    private Map<String, String> lastNodeIdentities = Map.of();

    public static boolean isRunning() {
        return instance != null;
    }

    public static RemoteAccessibilityService current() {
        return instance;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        android.accessibilityservice.AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            info.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            setServiceInfo(info);
        }
        // Accessibility reliably reconnects after package updates and normal
        // boots on OEM builds that may suppress BOOT_COMPLETED delivery to
        // ordinary apps. Reuse the same durable local-enable policy as boot
        // recovery so a local STOP remains authoritative.
        RemoteControlService.recoverIfDesired(this);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        generation++;
    }

    @Override
    public void onInterrupt() {
        generation++;
    }

    @Override
    public void onDestroy() {
        generation++;
        lastSnapshot = null;
        lastNodeIdentities = Map.of();
        ExecutionLease lease = currentLease;
        currentLease = null;
        if (lease != null) lease.cancel();
        if (instance == this) instance = null;
        screenshotEncoder.shutdownNow();
        super.onDestroy();
    }

    private boolean isActiveService() {
        return instance == this;
    }

    public CompletableFuture<JSONObject> execute(JSONObject request, ExecutionLease lease) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(() -> executeOnMain(request, result, lease));
        } else {
            executeOnMain(request, result, lease);
        }
        return result;
    }

    private void executeOnMain(JSONObject request, CompletableFuture<JSONObject> result, ExecutionLease lease) {
        if (result.isDone()) return;
        if (!isActiveService()) { completeError(result, "accessibility_unavailable", "accessibility_service_unavailable"); return; }
        if (!lease.mayRun()) { completeError(result, "expired_or_paused", "command_not_started"); return; }
        currentLease = lease;
        try {
            String operation = request.optString("operation", "");
            switch (operation) {
                case "observe" -> observe(request, result, lease);
                case "tap" -> tap(request, result);
                case "swipe" -> swipe(request, result);
                case "set_text" -> setText(request, result);
                case "node_action" -> nodeAction(request, result);
                case "global_action" -> globalAction(request, result);
                case "open_app" -> openApp(request, result);
                default -> completeError(result, "unsupported_operation", "operation_not_supported");
            }
        } catch (ActionFailure known) {
            result.completeExceptionally(known);
        } catch (JSONException invalid) {
            completeError(result, "invalid_request", "request_invalid");
        } catch (RuntimeException failure) {
            completeError(result, lease.effectStarted() ? "outcome_unknown" : "accessibility_error", "accessibility_operation_failed");
        }
    }

    private void observe(JSONObject request, CompletableFuture<JSONObject> result, ExecutionLease lease) throws JSONException {
        boolean wantImage = request.optBoolean("image", true);
        boolean wantTree = request.optBoolean("tree", true);
        int maxNodes = Protocol.boundedMaxNodes(request);
        long before = generation;
        DisplayInfo display = displayInfo();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        boolean concreteWindowIdentity = root != null && root.getPackageName() != null
                && !root.getPackageName().toString().isBlank() && root.getWindowId() >= 0;
        String packageName = concreteWindowIdentity ? root.getPackageName().toString() : null;
        int windowId = concreteWindowIdentity ? root.getWindowId() : -1;
        NodeCollection tree = wantTree ? collectNodes(root, maxNodes) : new NodeCollection(Protocol.emptyNodes(), false, new HashMap<>(), new ObservationBudget());
        JSONArray nodes = tree.nodes;
        if (root != null) root.recycle();

        CompletableFuture<ScreenshotData> image = wantImage ? captureScreenshot() :
                CompletableFuture.completedFuture(ScreenshotData.notRequested());
        image.whenComplete((screenshot, throwable) -> mainHandler.post(() -> {
            if (result.isDone()) return;
            if (!isActiveService()) { completeError(result, "accessibility_unavailable", "accessibility_service_unavailable"); return; }
            if (!lease.mayRun()) { completeError(result, "expired_or_paused", "observation_expired"); return; }
            long after = generation;
            if (throwable != null) {
                completeError(result, "observation_failed", "observation_failed");
                return;
            }
            DisplayInfo currentDisplay = displayInfo();
            if (before != after
                    || currentDisplay.width != display.width || currentDisplay.height != display.height
                    || currentDisplay.rotation != display.rotation
                    || (concreteWindowIdentity && !activeWindowMatches(packageName, windowId))) {
                completeError(result, "observation_changed", "screen_or_window_changed_during_observation");
                return;
            }
            lastSnapshot = new SnapshotFreshness.Metadata(System.currentTimeMillis(), android.os.SystemClock.elapsedRealtime(),
                    display.width, display.height, display.rotation, after);
            // A screenshot without a concrete active-window identity is still
            // useful for observation, but it must never authorize a later
            // snapshot-bound gesture or node action.
            lastPackage = concreteWindowIdentity ? packageName : null;
            lastWindowId = concreteWindowIdentity ? windowId : -1;
            lastNodeIdentities = concreteWindowIdentity ? Map.copyOf(tree.identities) : Map.of();
            JSONObject snapshot = snapshotJson(lastSnapshot);
            JSONObject output = new JSONObject();
            try {
                output.put("snapshot", snapshot);
                if (wantImage) output.put("image", screenshot.toJson());
                if (wantTree) {
                    output.put("nodes", nodes);
                    output.put("treeTruncated", tree.truncated);
                    output.put("fieldsTruncated", tree.budget.fieldTruncated());
                }
                result.complete(output);
            } catch (JSONException impossible) {
                completeError(result, "observation_failed", "observation_failed");
            }
        }));
    }

    private void tap(JSONObject request, CompletableFuture<JSONObject> result) throws JSONException {
        if (!canMutate()) {
            completeError(result, "accessibility_unavailable", availabilityReason());
            return;
        }
        if (!fresh(request.optString("snapshotId", ""))) {
            completeError(result, "stale_observation", "snapshot_is_stale");
            return;
        }
        float x = (float) request.getDouble("x");
        float y = (float) request.getDouble("y");
        dispatchSingleGesture(x, y, x, y, 50L, result);
    }

    private void swipe(JSONObject request, CompletableFuture<JSONObject> result) throws JSONException {
        if (!canMutate()) {
            completeError(result, "accessibility_unavailable", availabilityReason());
            return;
        }
        if (!fresh(request.optString("snapshotId", ""))) {
            completeError(result, "stale_observation", "snapshot_is_stale");
            return;
        }
        long duration = request.optLong("durationMs", 300L);
        if (duration < 50L || duration > 5000L) {
            completeError(result, "invalid_request", "duration_invalid");
            return;
        }
        dispatchSingleGesture((float) request.getDouble("fromX"), (float) request.getDouble("fromY"),
                (float) request.getDouble("toX"), (float) request.getDouble("toY"), duration, result);
    }

    private void dispatchSingleGesture(float fromX, float fromY, float toX, float toY, long duration,
                                       CompletableFuture<JSONObject> result) {
        Path path = new Path();
        path.moveTo(fromX, fromY);
        path.lineTo(toX, toY);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, duration)).build();
        DisplayInfo display = displayInfo();
        if (!Float.isFinite(fromX) || !Float.isFinite(fromY) || !Float.isFinite(toX) || !Float.isFinite(toY)
                || fromX < 0 || fromY < 0 || toX < 0 || toY < 0
                || fromX >= display.width || toX >= display.width || fromY >= display.height || toY >= display.height) {
            completeError(result, "invalid_request", "coordinates_outside_display"); return;
        }
        beginEffect();
        ExecutionLease lease = currentLease;
        boolean accepted = dispatchGesture(gesture, new GestureResult(this, result, lease), null);
        if (accepted) { generation++; lastSnapshot = null; }
        if (!accepted) completeError(result, "gesture_rejected", "gesture_not_accepted");
    }

    private void setText(JSONObject request, CompletableFuture<JSONObject> result) throws JSONException {
        AccessibilityNodeInfo node = freshNode(request, result);
        if (node == null) return;
        if (!node.isEditable()) {
            node.recycle();
            completeError(result, "node_not_editable", "node_is_not_editable");
            return;
        }
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                request.getString("text"));
        beginEffect();
        boolean accepted = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        node.recycle();
        if (accepted) {
            generation++;
            lastSnapshot = null;
            completeOk(result);
        } else {
            completeError(result, "action_rejected", "set_text_not_accepted");
        }
    }

    private void nodeAction(JSONObject request, CompletableFuture<JSONObject> result) throws JSONException {
        AccessibilityNodeInfo node = freshNode(request, result);
        if (node == null) return;
        String action = request.getString("action");
        int actionId = switch (action) {
            case "click" -> AccessibilityNodeInfo.ACTION_CLICK;
            case "long_click" -> AccessibilityNodeInfo.ACTION_LONG_CLICK;
            case "scroll_forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
            case "scroll_backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
            case "focus" -> AccessibilityNodeInfo.ACTION_FOCUS;
            default -> 0;
        };
        if (actionId == 0) {
            node.recycle();
            completeError(result, "invalid_request", "node_action_invalid");
            return;
        }
        beginEffect();
        boolean accepted = node.performAction(actionId);
        node.recycle();
        if (accepted) {
            generation++;
            lastSnapshot = null;
            completeOk(result);
        } else completeError(result, "action_rejected", "node_action_not_accepted");
    }

    private void globalAction(JSONObject request, CompletableFuture<JSONObject> result) throws JSONException {
        if (!canMutate()) {
            completeError(result, "accessibility_unavailable", availabilityReason());
            return;
        }
        int action = switch (request.getString("action")) {
            case "home" -> GLOBAL_ACTION_HOME;
            case "back" -> GLOBAL_ACTION_BACK;
            case "recents" -> GLOBAL_ACTION_RECENTS;
            case "notifications" -> GLOBAL_ACTION_NOTIFICATIONS;
            case "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS;
            case "lock_screen" -> GLOBAL_ACTION_LOCK_SCREEN;
            default -> 0;
        };
        if (action == 0) {
            completeError(result, "invalid_request", "global_action_invalid");
            return;
        }
        beginEffect();
        if (performGlobalAction(action)) {
            generation++;
            lastSnapshot = null;
            completeOk(result);
        } else completeError(result, "action_rejected", "global_action_not_accepted");
    }

    private void openApp(JSONObject request, CompletableFuture<JSONObject> result) throws JSONException {
        if (!canMutate()) {
            completeError(result, "accessibility_unavailable", availabilityReason());
            return;
        }
        String packageName = request.getString("packageName");
        android.content.Intent launch = getPackageManager().getLaunchIntentForPackage(packageName);
        if (launch == null) {
            completeError(result, "package_unavailable", "package_has_no_launcher");
            return;
        }
        launch.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        beginEffect();
        startActivity(launch);
        generation++;
        lastSnapshot = null;
        completeOk(result);
    }

    private AccessibilityNodeInfo freshNode(JSONObject request, CompletableFuture<JSONObject> result) throws JSONException {
        if (!canMutate()) {
            completeError(result, "accessibility_unavailable", availabilityReason());
            return null;
        }
        if (!fresh(request.optString("snapshotId", ""))) {
            completeError(result, "stale_observation", "snapshot_is_stale");
            return null;
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || lastPackage == null || !lastPackage.equals(String.valueOf(root.getPackageName()))
                || root.getWindowId() != lastWindowId) {
            if (root != null) root.recycle();
            completeError(result, "stale_observation", "active_window_changed");
            return null;
        }
        String nodeId = request.optString("nodeId", "");
        AccessibilityNodeInfo node = nodeAtPath(root, nodeId);
        root.recycle();
        if (node == null) {
            completeError(result, "node_unavailable", "node_not_found");
            return null;
        }
        String expectedIdentity = lastNodeIdentities.get(nodeId);
        String currentIdentity = nodeIdentity(node);
        if (expectedIdentity == null || currentIdentity == null || !expectedIdentity.equals(currentIdentity)) {
            node.recycle();
            completeError(result, "stale_observation", expectedIdentity == null ? "node_identity_unavailable" : "node_identity_changed");
            return null;
        }
        return node;
    }

    private AccessibilityNodeInfo nodeAtPath(AccessibilityNodeInfo root, String path) {
        if (path == null || path.isBlank()) return null;
        String[] parts = path.split("/");
        if (parts.length == 0 || !"0".equals(parts[0])) return null;
        AccessibilityNodeInfo current = AccessibilityNodeInfo.obtain(root);
        for (int i = 1; i < parts.length; i++) {
            int index;
            try { index = Integer.parseInt(parts[i]); } catch (NumberFormatException invalid) {
                current.recycle();
                return null;
            }
            AccessibilityNodeInfo next = current.getChild(index);
            current.recycle();
            if (next == null) return null;
            current = next;
        }
        if (!current.refresh()) { current.recycle(); return null; }
        return current;
    }

    private boolean fresh(String snapshotId) {
        DisplayInfo display = displayInfo();
        return SnapshotFreshness.isFresh(lastSnapshot, snapshotId, android.os.SystemClock.elapsedRealtime(),
                generation, display.width, display.height, display.rotation)
                && lastPackage != null && activeWindowMatches(lastPackage, lastWindowId);
    }

    private boolean activeWindowMatches(String expectedPackage, int expectedWindowId) {
        if (expectedPackage == null || expectedPackage.isBlank() || expectedWindowId < 0) return false;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null || root.getWindowId() < 0) {
            if (root != null) root.recycle();
            return false;
        }
        String currentPackage = root.getPackageName().toString();
        int currentWindowId = root.getWindowId();
        root.recycle();
        return expectedPackage.equals(currentPackage) && expectedWindowId == currentWindowId;
    }

    private void beginEffect() {
        if (currentLease == null || !currentLease.beginEffect()) throw new ActionFailure("expired_or_paused", "command_not_started");
    }

    private boolean canMutate() {
        android.app.KeyguardManager keyguard = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        android.os.PowerManager power = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        ConfigRepository local = new ConfigRepository(this);
        return local.enabled() && !local.authBlocked() && isActiveService() && keyguard != null && !keyguard.isKeyguardLocked()
                && power != null && power.isInteractive();
    }

    private String availabilityReason() {
        android.app.KeyguardManager keyguard = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        android.os.PowerManager power = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        if (!isActiveService()) return "accessibility_unavailable";
        if (keyguard != null && keyguard.isKeyguardLocked()) return "keyguard_locked";
        if (power != null && !power.isInteractive()) return "screen_off";
        return "accessibility_unavailable";
    }

    private CompletableFuture<ScreenshotData> captureScreenshot() {
        CompletableFuture<ScreenshotData> result = new CompletableFuture<>();
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                @Override
                public void onFailure(int errorCode) {
                    result.complete(ScreenshotData.unavailable("screenshot_unavailable"));
                }

                @Override
                public void onSuccess(ScreenshotResult screenshot) {
                    if (screenshot == null || screenshot.getHardwareBuffer() == null) {
                        result.complete(ScreenshotData.unavailable("screenshot_unavailable"));
                        return;
                    }
                    HardwareBuffer hardwareBuffer = screenshot.getHardwareBuffer();
                    Bitmap hardwareBitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, screenshot.getColorSpace());
                    hardwareBuffer.close();
                    if (hardwareBitmap == null) {
                        result.complete(ScreenshotData.unavailable("screenshot_unavailable"));
                        return;
                    }
                    Bitmap bitmap = hardwareBitmap.copy(Bitmap.Config.ARGB_8888, false);
                    hardwareBitmap.recycle();
                    if (bitmap == null) {
                        result.complete(ScreenshotData.unavailable("screenshot_unavailable"));
                        return;
                    }
                    try {
                        screenshotEncoder.execute(() -> {
                            try {
                                result.complete(encodeScreenshot(bitmap));
                            } finally {
                                bitmap.recycle();
                            }
                        });
                    } catch (RejectedExecutionException stopping) {
                        bitmap.recycle();
                        result.complete(ScreenshotData.unavailable("screenshot_unavailable"));
                    }
                }
            });
        } catch (RuntimeException unavailable) {
            result.complete(ScreenshotData.unavailable("screenshot_unavailable"));
        }
        return result;
    }

    private ScreenshotData encodeScreenshot(Bitmap bitmap) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
                && ScreenshotBudget.fitsCompressedBytes(output.size())) {
            return ScreenshotData.available("image/png",
                    Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
        }
        for (int quality : ScreenshotBudget.JPEG_QUALITIES) {
            output.reset();
            if (bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)
                    && ScreenshotBudget.fitsCompressedBytes(output.size())) {
                return ScreenshotData.available("image/jpeg",
                        Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
            }
        }
        return ScreenshotData.unavailable("screenshot_too_large");
    }

    private NodeCollection collectNodes(AccessibilityNodeInfo root, int maxNodes) {
        NodeCollection collection = new NodeCollection(new JSONArray(), false, new HashMap<>(), new ObservationBudget());
        if (root == null) return collection;

        Deque<NodeFrame> pending = new ArrayDeque<>();
        pending.addLast(new NodeFrame(root, "0", false));
        int remainingChildFetches = Math.max(0, maxNodes - 1);
        try {
            while (!pending.isEmpty()) {
                NodeFrame frame = pending.peekLast();
                AccessibilityNodeInfo node = frame.node;

                if (!frame.emitted) {
                    if (collection.nodes.length() >= maxNodes || collection.budget.exhausted()) {
                        collection.truncated = true;
                        break;
                    }
                    frame.emitted = true;
                    Rect bounds = new Rect();
                    node.getBoundsInScreen(bounds);
                    try {
                        boolean password = node.isPassword();
                        String identity = nodeIdentity(node);
                        if (identity != null) collection.identities.put(frame.path, identity);
                        JSONObject value = new JSONObject().put("nodeId", frame.path)
                                .put("text", password ? "" : collection.budget.take(node.getText()))
                                .put("description", password ? "" : collection.budget.take(node.getContentDescription()))
                                .put("viewId", collection.budget.take(node.getViewIdResourceName()))
                                .put("className", collection.budget.take(node.getClassName()))
                                .put("packageName", collection.budget.take(node.getPackageName()))
                                .put("clickable", node.isClickable()).put("editable", node.isEditable())
                                .put("bounds", new JSONObject().put("left", bounds.left).put("top", bounds.top)
                                        .put("right", bounds.right).put("bottom", bounds.bottom));
                        collection.nodes.put(value);
                    } catch (JSONException impossible) {
                        frame.nextChildIndex = frame.childCount;
                    }
                }

                if (collection.nodes.length() >= maxNodes || collection.budget.exhausted()) {
                    if (hasUnvisitedNodes(pending)) collection.truncated = true;
                    break;
                }

                if (frame.nextChildIndex < frame.childCount) {
                    if (remainingChildFetches <= 0) {
                        collection.truncated = true;
                        break;
                    }
                    remainingChildFetches--;
                    int childIndex = frame.nextChildIndex++;
                    AccessibilityNodeInfo child = node.getChild(childIndex);
                    if (child != null) {
                        pending.addLast(new NodeFrame(child, frame.path + "/" + childIndex, true));
                    }
                    continue;
                }

                pending.removeLast();
                if (frame.recycle) frame.node.recycle();
            }
        } finally {
            while (!pending.isEmpty()) {
                NodeFrame frame = pending.removeLast();
                if (frame.recycle) frame.node.recycle();
            }
        }
        return collection;
    }

    private boolean hasUnvisitedNodes(Deque<NodeFrame> pending) {
        for (NodeFrame frame : pending) {
            if (!frame.emitted || frame.nextChildIndex < frame.childCount) return true;
        }
        return false;
    }

    private String nodeIdentity(AccessibilityNodeInfo node) {
        if (Build.VERSION.SDK_INT >= 33) {
            String uniqueId = node.getUniqueId();
            if (uniqueId != null && !uniqueId.isBlank()) return "uid:" + uniqueId;
        }
        String viewId = node.getViewIdResourceName();
        if (viewId == null || viewId.isBlank() || node.getPackageName() == null || node.getClassName() == null) return null;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return "view:" + node.getPackageName() + "|" + viewId + "|" + node.getClassName()
                + "|" + bounds.left + "," + bounds.top + "," + bounds.right + "," + bounds.bottom;
    }

    private JSONObject snapshotJson(SnapshotFreshness.Metadata metadata) {
        try {
            return new JSONObject().put("snapshotId", metadata.snapshotId)
                    .put("observedAt", metadata.observedAtWallMs).put("width", metadata.width)
                    .put("height", metadata.height).put("rotation", metadata.rotation)
                    .put("generation", Long.toString(metadata.generation));
        } catch (JSONException impossible) {
            throw new AssertionError(impossible);
        }
    }

    private DisplayInfo displayInfo() {
        WindowManager windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        Display display = windowManager.getDefaultDisplay();
        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        return new DisplayInfo(metrics.widthPixels, metrics.heightPixels, display.getRotation());
    }

    private void completeOk(CompletableFuture<JSONObject> result) {
        try { result.complete(new JSONObject()); } catch (Exception impossible) { result.completeExceptionally(impossible); }
    }

    private void completeError(CompletableFuture<JSONObject> result, String code, String message) {
        result.completeExceptionally(new ActionFailure(code, message));
    }

    private static final class GestureResult extends AccessibilityService.GestureResultCallback {
        private final RemoteAccessibilityService service;
        private final CompletableFuture<JSONObject> result;
        private final ExecutionLease lease;

        GestureResult(RemoteAccessibilityService service, CompletableFuture<JSONObject> result, ExecutionLease lease) {
            this.service = service; this.result = result; this.lease = lease;
        }

        @Override public void onCompleted(GestureDescription gestureDescription) {
            if (!service.isActiveService() || lease == null || !lease.mayRun()) {
                result.completeExceptionally(new ActionFailure("outcome_unknown", "gesture_completion_after_service_loss"));
                return;
            }
            result.complete(new JSONObject());
        }

        @Override public void onCancelled(GestureDescription gestureDescription) {
            result.completeExceptionally(new ActionFailure("outcome_unknown", "gesture_may_have_partially_executed"));
        }
    }

    public static final class ActionFailure extends RuntimeException {
        public final String code;
        public ActionFailure(String code, String message) { super(message); this.code = code; }
    }

    private static final class NodeFrame {
        final AccessibilityNodeInfo node;
        final String path;
        final boolean recycle;
        final int childCount;
        int nextChildIndex;
        boolean emitted;

        NodeFrame(AccessibilityNodeInfo node, String path, boolean recycle) {
            this.node = node;
            this.path = path;
            this.recycle = recycle;
            this.childCount = node.getChildCount();
        }
    }

    private static final class NodeCollection {
        final JSONArray nodes;
        boolean truncated;
        final Map<String, String> identities;
        final ObservationBudget budget;
        NodeCollection(JSONArray nodes, boolean truncated, Map<String, String> identities, ObservationBudget budget) {
            this.nodes = nodes; this.truncated = truncated; this.identities = identities; this.budget = budget;
        }
    }

    private static final class DisplayInfo {
        final int width;
        final int height;
        final int rotation;
        DisplayInfo(int width, int height, int rotation) { this.width = width; this.height = height; this.rotation = rotation; }
    }

    private static final class ScreenshotData {
        final boolean requested;
        final boolean available;
        final String mimeType;
        final String data;
        final String reason;

        private ScreenshotData(boolean requested, boolean available, String mimeType, String data, String reason) {
            this.requested = requested; this.available = available; this.mimeType = mimeType; this.data = data; this.reason = reason;
        }

        static ScreenshotData notRequested() { return new ScreenshotData(false, false, "", "", "not_requested"); }
        static ScreenshotData available(String mimeType, String data) { return new ScreenshotData(true, true, mimeType, data, ""); }
        static ScreenshotData unavailable(String reason) { return new ScreenshotData(true, false, "", "", reason); }

        JSONObject toJson() throws JSONException {
            JSONObject object = new JSONObject().put("available", available);
            if (available) object.put("mimeType", mimeType).put("data", data);
            else object.put("reason", reason);
            return object;
        }
    }
}
