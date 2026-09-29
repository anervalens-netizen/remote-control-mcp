package eu.astancu.rcmcp.android;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;

import java.nio.ByteBuffer;
import java.util.concurrent.CompletableFuture;

import eu.astancu.rcmcp.android.RemoteAccessibilityService.ScreenshotData;

/** API 29 only. One consent, one projection, one virtual display, no stored frames or audio. */
public final class ProjectionScreenshotService extends Service {
    private static final String START = "projection.owner_consent";
    private static final String STOP = "projection.stop";
    private static final String CHANNEL = "screen_sharing";
    private static final ProjectionPolicy CONSENT = new ProjectionPolicy();
    private static volatile ProjectionScreenshotService instance;
    private static volatile String reason = "screen_sharing_consent_required";
    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread frameThread;
    private Handler frames;
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader reader;
    private DisplayManager displays;
    private int width, height, rotation;
    private boolean active;
    private boolean closed;
    private final ScreenshotRequestSlot<ScreenshotData> requests = new ScreenshotRequestSlot<>();
    private long requestedAtNanos;
    private Runnable timeout;

    static long requestConsent(Context context) {
        stop(context, "screen_sharing_consent_required");
        return CONSENT.request(Build.VERSION.SDK_INT, allowed(context));
    }

    static void startConsented(Context context, long ticket, int resultCode, Intent resultData) {
        // The ticket exists only after the Activity button gesture. Consume again in the
        // service so STOP/unbind while its start is queued invalidates the request.
        if (resultCode != Activity.RESULT_OK || resultData == null) {
            stop(context, "screen_sharing_consent_denied");
            return;
        }
        if (Build.VERSION.SDK_INT != 29 || ticket == 0) return;
        Intent start = new Intent(context, ProjectionScreenshotService.class).setAction(START)
                .putExtra("ticket", ticket).putExtra("resultCode", resultCode).putExtra("resultData", resultData);
        try { context.startForegroundService(start); }
        catch (RuntimeException unavailable) { stop(context, "screen_sharing_start_failed"); }
    }

    static boolean allowed(Context context) {
        ConfigRepository config = new ConfigRepository(context);
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        PowerManager power = context.getSystemService(PowerManager.class);
        return config.enabled() && !config.authBlocked() && RemoteAccessibilityService.isRunning()
                && keyguard != null && !keyguard.isKeyguardLocked() && power != null && power.isInteractive();
    }

    static String status() { return instance != null && instance.isActive() ? "active" : reason; }
    private synchronized boolean isActive() { return active; }

    static void stop(Context context, String why) {
        CONSENT.invalidate();
        reason = why;
        ProjectionScreenshotService service = instance;
        if (service != null) service.close(why);
        context.stopService(new Intent(context, ProjectionScreenshotService.class));
    }

    @Override public synchronized int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            BackgroundConfigurationImport.stop();
            stop(this, "screen_sharing_stopped");
            return START_NOT_STICKY;
        }
        Intent resultData = intent == null ? null : intent.getParcelableExtra("resultData");
        boolean accepted = CONSENT.consume(intent == null ? 0 : intent.getLongExtra("ticket", 0),
                Build.VERSION.SDK_INT, intent != null && START.equals(intent.getAction())
                        && intent.getIntExtra("resultCode", 0) == Activity.RESULT_OK && resultData != null,
                allowed(this));
        if (intent != null) intent.removeExtra("resultData");
        if (!accepted || instance != null) {
            close("screen_sharing_consent_required");
            return START_NOT_STICKY;
        }
        if (closed) { stopSelf(); return START_NOT_STICKY; }
        instance = this;
        try {
            getSystemService(NotificationManager.class).createNotificationChannel(
                    new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW));
            PendingIntent stop = PendingIntent.getService(this, 372,
                    new Intent(this, ProjectionScreenshotService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
            Notification notification = new Notification.Builder(this, CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_menu_camera).setContentTitle("Screen sharing active")
                    .setContentText("Owner-consented screenshots on request; STOP sharing at any time")
                    .setOngoing(true).addAction(new Notification.Action.Builder(null, "STOP", stop).build()).build();
            startForeground(372, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            // Foreground promotion must precede exchanging the single-use consent result.
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(Activity.RESULT_OK, resultData);
            resultData = null;
            if (projection == null) throw new IllegalStateException();
            projection.registerCallback(projectionCallback, main);
            Display display = getSystemService(WindowManager.class).getDefaultDisplay();
            DisplayMetrics metrics = new DisplayMetrics();
            display.getRealMetrics(metrics);
            width = metrics.widthPixels; height = metrics.heightPixels; rotation = display.getRotation();
            if (!ScreenshotBudget.fitsPixels(width, height)) throw new IllegalStateException();
            frameThread = new HandlerThread("rcmcp-projection-frames");
            frameThread.start();
            frames = new Handler(frameThread.getLooper());
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            reader.setOnImageAvailableListener(this::onFrame, frames);
            virtualDisplay = projection.createVirtualDisplay("Owner screenshots", width, height,
                    getResources().getConfiguration().densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(), null, main);
            if (virtualDisplay == null) throw new IllegalStateException();
            displays = getSystemService(DisplayManager.class);
            displays.registerDisplayListener(displayListener, main);
            synchronized (this) { active = true; }
            reason = "active";
        } catch (RuntimeException failure) {
            close("screen_sharing_start_failed");
        }
        return START_NOT_STICKY;
    }

    static CompletableFuture<ScreenshotData> capture(int width, int height, int rotation) {
        ProjectionScreenshotService service = instance;
        if (Build.VERSION.SDK_INT != 29 || service == null) {
            return CompletableFuture.completedFuture(ScreenshotData.unavailable(reason));
        }
        return service.captureFrame(width, height, rotation);
    }

    private synchronized CompletableFuture<ScreenshotData> captureFrame(int expectedWidth, int expectedHeight, int expectedRotation) {
        if (!active || !allowed(this)) return CompletableFuture.completedFuture(ScreenshotData.unavailable("screen_sharing_unavailable"));
        if (!displayMatches() || !ProjectionPolicy.sameDisplay(width, height, rotation, expectedWidth, expectedHeight, expectedRotation)) {
            close("display_changed_refresh_and_reenable_screen_sharing");
            return CompletableFuture.completedFuture(ScreenshotData.unavailable(reason));
        }
        CompletableFuture<ScreenshotData> result = requests.begin();
        if (result == null) return CompletableFuture.completedFuture(ScreenshotData.unavailable("screenshot_busy"));
        timeout = () -> finish(result, ScreenshotData.unavailable("screenshot_timeout"));
        main.postDelayed(timeout, ProjectionPolicy.CAPTURE_TIMEOUT_MS);
        try {
            // Discard queued frames and ask SurfaceFlinger for a fresh frame, even
            // when the screen is static. Never serve the last previously seen image.
            virtualDisplay.setSurface(null);
            try (Image stale = reader.acquireLatestImage()) { /* discard */ }
            requestedAtNanos = System.nanoTime();
            virtualDisplay.setSurface(reader.getSurface());
        } catch (RuntimeException unavailable) {
            finish(result, ScreenshotData.unavailable("screenshot_unavailable"));
        }
        result.whenComplete((value, failure) -> {
            if (result.isCancelled()) finish(result, ScreenshotData.unavailable("screenshot_cancelled"));
        });
        return result;
    }

    private void onFrame(ImageReader source) {
        Bitmap bitmap = null;
        Image image = null;
        CompletableFuture<ScreenshotData> target = null;
        int frameWidth = 0;
        int frameHeight = 0;
        try {
            synchronized (this) {
                if (source != reader) return;
                image = source.acquireLatestImage();
                if (image == null || !active) return;
                if (image.getTimestamp() < requestedAtNanos) return;
                target = requests.pending();
                if (!requests.claimEncoding(target)) { target = null; return; }
                if (!allowed(this) || !displayMatches() || image.getWidth() != width || image.getHeight() != height) {
                    finish(target, ScreenshotData.unavailable("display_changed_or_locked_refresh_required"));
                    return;
                }
                frameWidth = width;
                frameHeight = height;
            }

            // The acquired Image is owned by this callback until close. Do the O(pixels)
            // copy without the service monitor so timeout, STOP and revocation can finish
            // the request and tear down the projection immediately.
            Image.Plane plane = image.getPlanes()[0];
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            if (pixelStride != 4 || rowStride < frameWidth * 4) throw new IllegalStateException();
            ByteBuffer buffer = plane.getBuffer();
            bitmap = Bitmap.createBitmap(frameWidth, frameHeight, Bitmap.Config.ARGB_8888);
            int[] row = new int[frameWidth];
            for (int y = 0; y < frameHeight; y++) {
                if (target.isDone()) return;
                for (int x = 0; x < frameWidth; x++) {
                    int offset = y * rowStride + x * pixelStride;
                    int r = buffer.get(offset) & 255, g = buffer.get(offset + 1) & 255;
                    int b = buffer.get(offset + 2) & 255, a = buffer.get(offset + 3) & 255;
                    row[x] = (a << 24) | (r << 16) | (g << 8) | b;
                }
                bitmap.setPixels(row, 0, frameWidth, 0, y, frameWidth, 1);
            }
            image.close();
            image = null;

            if (target.isDone()) return;
            ScreenshotData data = RemoteAccessibilityService.encodeScreenshot(bitmap);
            synchronized (this) {
                if (!active || !allowed(this) || !displayMatches()) data = ScreenshotData.unavailable("screen_sharing_changed_refresh_required");
                finish(target, data);
            }
        } catch (RuntimeException failure) {
            synchronized (this) { if (target != null) finish(target, ScreenshotData.unavailable("screenshot_unavailable")); }
        } finally {
            if (image != null) {
                try { image.close(); } catch (RuntimeException alreadyClosed) { /* teardown may invalidate it */ }
            }
            if (bitmap != null) bitmap.recycle();
            synchronized (this) { if (target != null) requests.releaseEncoder(); }
        }
    }

    private synchronized void finish(CompletableFuture<ScreenshotData> target, ScreenshotData value) {
        if (!requests.finish(target, value)) return;
        if (timeout != null) main.removeCallbacks(timeout);
        timeout = null;
    }

    private boolean displayMatches() {
        Display display = getSystemService(WindowManager.class).getDefaultDisplay();
        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        return ProjectionPolicy.sameDisplay(width, height, rotation, metrics.widthPixels, metrics.heightPixels, display.getRotation());
    }

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override public void onStop() { close("screen_sharing_revoked"); }
    };
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) {}
        @Override public void onDisplayRemoved(int id) { if (id == Display.DEFAULT_DISPLAY) close("display_removed"); }
        @Override public void onDisplayChanged(int id) {
            if (id == Display.DEFAULT_DISPLAY && !displayMatches()) close("display_changed_refresh_and_reenable_screen_sharing");
        }
    };

    private synchronized void close(String why) {
        if (closed) return;
        closed = true;
        active = false;
        reason = why;
        CONSENT.invalidate();
        if (instance == this) instance = null;
        requests.stop(ScreenshotData.unavailable(why));
        main.removeCallbacksAndMessages(null);
        timeout = null;
        if (displays != null) { releaseSafely(() -> displays.unregisterDisplayListener(displayListener)); displays = null; }
        if (reader != null) releaseSafely(() -> reader.setOnImageAvailableListener(null, null));
        if (virtualDisplay != null) { releaseSafely(() -> virtualDisplay.release()); virtualDisplay = null; }
        if (reader != null) { releaseSafely(() -> reader.close()); reader = null; }
        if (projection != null) {
            releaseSafely(() -> projection.unregisterCallback(projectionCallback));
            releaseSafely(() -> projection.stop());
            projection = null;
        }
        if (frames != null) { frames.removeCallbacksAndMessages(null); frames = null; }
        if (frameThread != null) { frameThread.quitSafely(); frameThread = null; }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private static void releaseSafely(Runnable release) {
        // A revoked system resource may already be gone; still release all others.
        try { release.run(); } catch (RuntimeException alreadyReleased) { /* continue cleanup */ }
    }

    @Override public void onTaskRemoved(Intent rootIntent) { close("screen_sharing_stopped"); }
    @Override public void onDestroy() { close(reason); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
