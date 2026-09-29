import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve("apps/android-companion");
const main = path.join(root, "app/src/main");
const java = path.join(main, "java/eu/astancu/rcmcp/android");
const source = (name: string) => readFileSync(path.join(java, `${name}.java`), "utf8");

describe("Android 10 companion platform wiring", () => {
  it("guards remote dispatch and every actual UI effect, without gating observations or physical controls", () => {
    const accessibility = source("RemoteAccessibilityService");
    const dispatch = accessibility.slice(accessibility.indexOf("public CompletableFuture<JSONObject> execute("), accessibility.indexOf("private void executeOnMain"));
    expect(dispatch.indexOf("LocalConsentBoundary.INSTANCE.allows")).toBeLessThan(dispatch.indexOf("mainHandler.post"));
    const effect = accessibility.slice(accessibility.indexOf("private void beginEffect()"), accessibility.indexOf("private boolean canMutate()"));
    expect(effect.indexOf('allows("mutation")')).toBeLessThan(effect.indexOf("currentLease.beginEffect()"));
    for (const call of ["dispatchGesture(gesture", "node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT", "node.performAction(actionId)", "performGlobalAction(action)", "startActivity(launch)"]) {
      const index = accessibility.indexOf(call);
      expect(index).toBeGreaterThan(0);
      expect(accessibility.slice(index - 130, index)).toContain("beginEffect();");
    }
    const activity = source("MainActivity");
    for (const pending of ["importPending", "sharingPending"]) {
      const latch = activity.indexOf(`${pending} = true;`);
      const launch = activity.indexOf("startActivityForResult", latch);
      expect(activity.slice(latch, launch)).toContain("updateLocalBoundary();");
    }
    expect(activity).toContain("importPending || sharingPending || notificationPending");
    expect(activity).toContain("LocalConsentBoundary.INSTANCE.destroy(this)");
    expect(activity).not.toContain('allows("mutation")');
    expect(source("RemoteControlService")).not.toContain("LocalConsentBoundary");
  });

  it("bounds provider work and cleanup, cancels on STOP, and rejects late UI results", () => {
    const importer = source("BackgroundConfigurationImport");
    expect(importer).toContain('openAssetFileDescriptor(uri, "r", signal)');
    expect(importer).toContain("TIMEOUT_MS = 5000L");
    expect(importer).toContain("if (active != null) return null");
    expect(importer).toContain("WORKER.execute(");
    expect(importer).toContain("future.cancel(true)");
    expect(importer).toContain("signal.cancel()");
    expect(importer).toContain("close(input)");
    expect(importer).toContain("close(descriptor)");
    expect(importer).toContain("workerDone && cleanupPending == 0");
    expect(importer).not.toMatch(/newCachedThreadPool|new Thread\(/);
    const activity = source("MainActivity");
    expect(activity).not.toMatch(/openInputStream|openAssetFileDescriptor|ConfigurationImport.read/);
    expect(activity).toContain("imported -> statusHandler.post(");
    expect(activity).toContain("!importGeneration.accepts(generation)");
    expect(activity).toContain("stopEpoch != BackgroundConfigurationImport.stopEpoch()");
    expect(activity).toContain("importGeneration.destroy()");
    expect(activity).toContain("statusHandler.postDelayed(importTimeout, BackgroundConfigurationImport.TIMEOUT_MS)");
    expect(source("RemoteControlService").match(/BackgroundConfigurationImport.stop\(\)/g)).toHaveLength(2);
  });

  it("keeps identity/protocol and isolates projection to its own nonexported service", () => {
    const gradle = readFileSync(path.join(root, "app/build.gradle"), "utf8");
    expect(gradle).toContain("applicationId 'eu.astancu.rcmcp.android'");
    expect(gradle).toContain("minSdk 29");
    expect(gradle).toContain("versionCode 11");
    expect(gradle).toContain("versionName '0.1.10-android10'");
    expect(source("Protocol")).toContain("VERSION = 1");
    const manifest = readFileSync(path.join(main, "AndroidManifest.xml"), "utf8");
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION');
    const projection = manifest.match(/<service\s+android:name=".ProjectionScreenshotService"[\s\S]*?\/>/)?.[0];
    expect(projection).toContain('android:exported="false"');
    expect(projection).toContain('android:foregroundServiceType="mediaProjection"');
    const control = manifest.match(/<service\s+android:name=".RemoteControlService"[\s\S]*?<\/service>/)?.[0];
    expect(control).toContain('android:foregroundServiceType="specialUse"');
    expect(control).not.toContain('mediaProjection');
    expect(manifest).not.toMatch(/RECORD_AUDIO|CAPTURE_SECURE_VIDEO_OUTPUT/);
  });

  it("routes API29 separately and isolates API30 screenshot callback linkage", () => {
    const accessibility = source("RemoteAccessibilityService");
    const routing = accessibility.slice(accessibility.indexOf("private CompletableFuture<ScreenshotData> captureScreenshot"), accessibility.indexOf("private static final class Api30Screenshots"));
    expect(routing).toContain("Build.VERSION.SDK_INT == 29");
    expect(routing).toContain("ProjectionScreenshotService.capture(display.width, display.height, display.rotation)");
    expect(routing.indexOf("Build.VERSION.SDK_INT < 30")).toBeLessThan(routing.indexOf("Api30Screenshots.capture("));
    const api30 = accessibility.slice(accessibility.indexOf("private static final class Api30Screenshots"), accessibility.indexOf("static ScreenshotData encodeScreenshot"));
    expect(api30).toContain("service.takeScreenshot(");
    expect(api30).toContain("new TakeScreenshotCallback()");
    expect(api30).toContain("buffer.getWidth() != display.width || buffer.getHeight() != display.height");
    expect(accessibility.replace(api30, "")).not.toMatch(/new TakeScreenshotCallback|onSuccess\(ScreenshotResult/);
    for (const file of readdirSync(java).filter((name) => name.endsWith(".java"))) {
      expect(readFileSync(path.join(java, file), "utf8")).not.toMatch(/\b(?:Map|List|Set)\.(?:of|copyOf)\(|(?<!Compatibility)\.isBlank\(/);
    }
  });

  it("starts only from owner consent and never from boot, recovery, or remote commands", () => {
    const activity = source("MainActivity");
    const projection = source("ProjectionScreenshotService");
    expect(activity).toContain("if (Build.VERSION.SDK_INT == 29)");
    expect(activity).toContain("sharing.setOnClickListener");
    expect(activity).toContain("ProjectionScreenshotService.requestConsent(this)");
    expect(activity).toContain(".createScreenCaptureIntent()");
    expect(activity).toContain("consentTicket = 0");
    expect(activity).toContain('consentTicket = state.getLong("consentTicket")');
    expect(activity).toContain('state.putLong("consentTicket", consentTicket)');
    expect(projection).toContain("CONSENT.consume(");
    expect(projection).toContain('intent.removeExtra("resultData")');
    expect(projection).toContain("START_NOT_STICKY");
    expect(projection.indexOf("startForeground(372")).toBeLessThan(projection.indexOf(".getMediaProjection(Activity.RESULT_OK"));
    expect(projection).not.toMatch(/SharedPreferences|putString|MediaRecorder|AudioRecord/);
    for (const file of ["BootReceiver", "RemoteControlService", "RemoteAccessibilityService"]) {
      expect(source(file)).not.toMatch(/startConsented|requestConsent|createScreenCaptureIntent/);
    }
  });

  it("drains frames and bounds capture, encoding, dimensions, and cleanup", () => {
    const projection = source("ProjectionScreenshotService");
    expect(projection).toContain("ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)");
    expect(projection).toContain("image = source.acquireLatestImage()");
    expect(projection).toContain("requests.claimEncoding(target)");
    const frame = projection.slice(projection.indexOf("private void onFrame"), projection.indexOf("private synchronized void finish"));
    expect(frame.indexOf("frameWidth = width")).toBeLessThan(frame.indexOf("Bitmap.createBitmap(frameWidth"));
    expect(frame).toContain("if (target.isDone()) return");
    expect(frame).toContain("image.close()");
    expect(projection).toContain("image.getTimestamp() < requestedAtNanos");
    expect(projection).toContain("requests.begin()");
    expect(projection).toContain("main.postDelayed(timeout, ProjectionPolicy.CAPTURE_TIMEOUT_MS)");
    expect(projection).toContain('ScreenshotData.unavailable("screenshot_timeout")');
    expect(projection).toContain("if (bitmap != null) bitmap.recycle()");
    expect(projection).toContain("ScreenshotBudget.fitsPixels(width, height)");
    expect(projection).toContain("RemoteAccessibilityService.encodeScreenshot(bitmap)");
    expect(projection).toContain("ProjectionPolicy.sameDisplay(");
    expect(projection).toContain("!keyguard.isKeyguardLocked()");
    expect(projection).not.toMatch(/FileOutputStream|createNewFile|\.save\(/);
    const close = projection.slice(projection.indexOf("private synchronized void close("));
    for (const required of ["active = false", "CONSENT.invalidate()", "requests.stop(ScreenshotData.unavailable(why))", "removeCallbacksAndMessages(null)",
      "unregisterDisplayListener", "setOnImageAvailableListener(null, null)", "virtualDisplay.release()", "reader.close()",
      "projection.unregisterCallback", "projection.stop()", "frameThread.quitSafely()", "stopForeground", "stopSelf()"])
      expect(close).toContain(required);
    expect(projection).toContain('onStop() { close("screen_sharing_revoked")');
    expect(source("ConfigRepository")).toContain('ProjectionScreenshotService.stop(context, "authentication_blocked")');
    expect(source("ConfigRepository")).toContain('if (!enabled) ProjectionScreenshotService.stop(');
    expect(source("RemoteControlService")).toContain('ProjectionScreenshotService.stop(context, "control_stopped")');
    expect(source("RemoteAccessibilityService")).toContain('public boolean onUnbind(');
    expect(source("RemoteAccessibilityService")).toContain('ProjectionScreenshotService.stop(this, "accessibility_unavailable")');
  });

  it("lets accessibility teardown complete queued commands instead of deleting their callbacks", () => {
    const accessibility = source("RemoteAccessibilityService");
    const teardown = accessibility.slice(accessibility.indexOf("public void onDestroy()"),
      accessibility.indexOf("public boolean onUnbind"));
    expect(teardown).toContain("if (instance == this) instance = null");
    expect(teardown).toContain("screenshot.complete(ScreenshotData.unavailable");
    expect(teardown).not.toContain("removeCallbacksAndMessages(null)");
    expect(teardown.indexOf("instance = null")).toBeLessThan(teardown.indexOf("screenshot.complete"));
  });

  it("imports only owner-selected SAF documents into protected fields with a separate Save", () => {
    const activity = source("MainActivity");
    expect(activity).toContain("Intent.ACTION_OPEN_DOCUMENT");
    expect(activity).toContain("Intent.CATEGORY_OPENABLE");
    expect(activity).toContain('"content".equals(data.getData().getScheme())');
    expect(activity).toContain("requestCode != IMPORT_CONFIGURATION || !importPending");
    const importer = source("BackgroundConfigurationImport");
    expect(importer).toContain("try (java.io.InputStream opened =");
    expect(importer).toContain("ConfigurationImport.read(input)");
    expect(activity).toContain("importedUnsaved = true");
    expect(activity).toContain("if (importedUnsaved)");
    expect(activity).toContain("token.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO)");
    expect(activity).toContain("edit.setSaveEnabled(!password)");
    expect(activity).toContain('state.putString("endpointDraft"');
    expect(activity).toContain('state.putString("deviceDraft"');
    expect(activity).toContain('state.getString("endpointDraft")');
    expect(activity).toContain('state.getString("deviceDraft")');
    expect(activity).not.toMatch(/getIntent\(\)|takePersistableUriPermission/);
    const result = activity.slice(activity.indexOf("protected void onActivityResult"), activity.indexOf("private EditText field"));
    expect(result).not.toMatch(/config\.save|startControl\(|setEnabled\(/);
    expect(result.indexOf("getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE)")).toBeLessThan(result.indexOf("token.setText(imported.token)"));
  });
});
