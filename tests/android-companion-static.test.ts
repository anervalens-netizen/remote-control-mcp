import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve("apps/android-companion/app/src/main");

describe("Android companion static capability contract", () => {
  it("declares every Accessibility capability used by the rootless baseline", () => {
    const config = readFileSync(path.join(appRoot, "res/xml/accessibility_service_config.xml"), "utf8");
    const source = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    expect(source).toContain("takeScreenshot(");
    expect(source).toContain("dispatchGesture(");
    expect(source).toContain("getRootInActiveWindow()");
    expect(config).toContain('android:canTakeScreenshot="true"');
    expect(config).toContain('android:canPerformGestures="true"');
    expect(config).toContain('android:canRetrieveWindowContent="true"');
  });

  it("keeps the baseline rootless and post-unlock only", () => {
    const manifest = readFileSync(path.join(appRoot, "AndroidManifest.xml"), "utf8");
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    expect(manifest).toContain('android:foregroundServiceType="specialUse"');
    expect(manifest).toContain('android:directBootAware="false"');
    expect(manifest).not.toContain("LOCKED_BOOT_COMPLETED");
    expect(manifest).not.toContain("MANAGE_EXTERNAL_STORAGE");
    expect(manifest).not.toContain("BIND_VPN_SERVICE");
    expect(service).not.toMatch(/\badb\b|mediaprojection/i);
    expect(accessibility).not.toMatch(/shizuku/i);
    expect(service).toContain('if ("shell".equals(request.optString("operation")))');
  });

  it("never renders the stored controller credential into the onboarding UI", () => {
    const activity = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/MainActivity.java"), "utf8");
    const config = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/ConfigRepository.java"), "utf8");
    expect(activity).not.toContain("token.setText(config.token())");
    expect(activity).toContain("token.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO)");
    expect(activity).toContain('token.setText("")');
    expect(config).toContain("token == null || token.isBlank() ? token() : token");
  });

  it("reports the generated APK version instead of a duplicated literal", () => {
    const protocol = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/Protocol.java"), "utf8");
    const gradle = readFileSync(path.resolve("apps/android-companion/app/build.gradle"), "utf8");
    expect(protocol).toContain('put("appVersion", BuildConfig.VERSION_NAME)');
    expect(protocol).not.toContain("APP_VERSION");
    expect(gradle).toContain("buildConfig true");
  });

  it("fail-stops the foreground control service when its active loop terminates", () => {
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    expect(service).toContain("if (epoch == loopGeneration)");
    expect(service).toContain("stopLocally()");
    expect(service).toContain("stopForeground(STOP_FOREGROUND_REMOVE)");
    expect(service).toContain("config.setAuthBlocked()");
  });

  it("fails closed when the durable command tombstone cannot be committed", () => {
    const store = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/SharedPrefsLedgerStore.java"), "utf8");
    expect(store).toContain("if (!preferences.edit().putString(PREFIX + commandId, value).commit())");
    expect(store).toContain('throw new IllegalStateException("command_ledger_persist_failed")');
  });

  it("persists uncertain Accessibility completion directly as outcome_unknown", () => {
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    expect(service).toContain("unknown ? CommandLedger.OUTCOME_UNKNOWN : CommandLedger.ERROR");
    expect(service).not.toContain("ledger.finish(commandId, deliveryId, CommandLedger.ERROR);\n                        Throwable cause = failed.getCause();");
  });

  it("invalidates queued and asynchronous Accessibility work when the service is destroyed", () => {
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    expect(accessibility).toContain("if (lease != null) lease.cancel()");
    expect(accessibility).toContain("if (!isActiveService()) { completeError(result, \"accessibility_unavailable\"");
    expect(accessibility).toContain("gesture_completion_after_service_loss");
  });

  it("rotates the control session after a failed poll instead of replaying the same delivery", () => {
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    const rotations = service.match(/sessionId = Protocol\.newSessionId\(\);/g) ?? [];
    expect(rotations.length).toBeGreaterThanOrEqual(3); // initial + protocol + transport failure
    expect(service).toContain("Persistence or local runtime failures are not safe retry");
  });

  it("excludes pairing credentials and ledger SharedPreferences from backup and device transfer", () => {
    const rules = readFileSync(path.join(appRoot, "res/xml/data_extraction_rules.xml"), "utf8");
    expect((rules.match(/domain="sharedpref"/g) ?? [])).toHaveLength(2);
    expect((rules.match(/domain="root"/g) ?? [])).toHaveLength(2);
  });

  it("revalidates the active window and never authorizes gestures from a sentinel/no-root identity", () => {
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    expect(accessibility).toContain("boolean concreteWindowIdentity");
    expect(accessibility).toContain("(concreteWindowIdentity && !activeWindowMatches(packageName, windowId))");
    expect(accessibility).toContain("lastPackage = concreteWindowIdentity ? packageName : null");
    expect(accessibility).toContain("lastWindowId = concreteWindowIdentity ? windowId : -1");
    expect(accessibility).toContain("expectedPackage == null || expectedPackage.isBlank() || expectedWindowId < 0");
    expect(accessibility).toContain("&& lastPackage != null && activeWindowMatches(lastPackage, lastWindowId)");
    expect(accessibility).toContain("screen_or_window_changed_during_observation");
  });

  it("walks Accessibility trees iteratively and fetches children lazily within the node budget", () => {
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    expect(accessibility).toContain("Deque<NodeFrame> pending = new ArrayDeque<>()");
    expect(accessibility).toContain("NodeFrame frame = pending.peekLast()");
    expect(accessibility).toContain("int remainingChildFetches = Math.max(0, maxNodes - 1)");
    expect(accessibility).toContain("if (remainingChildFetches <= 0)");
    expect(accessibility).toContain("remainingChildFetches--");
    expect(accessibility).toContain("int childIndex = frame.nextChildIndex++");
    expect(accessibility).toContain("AccessibilityNodeInfo child = node.getChild(childIndex)");
    expect(accessibility).toContain("pending.addLast(new NodeFrame(child");
    expect(accessibility).toContain("if (hasUnvisitedNodes(pending)) collection.truncated = true");
    expect(accessibility).not.toMatch(/for \(int i = .*childCount/);
    expect(accessibility).not.toContain("collectNode(child");
  });

  it("redacts password fields, bounds observation text, and revalidates node identity before path actions", () => {
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    expect(accessibility).toContain("boolean password = node.isPassword()");
    expect(accessibility).toContain('.put("text", password ? "" : collection.budget.take(node.getText()))');
    expect(accessibility).toContain('.put("description", password ? "" : collection.budget.take(node.getContentDescription()))');
    expect(accessibility).toContain("lastNodeIdentities = concreteWindowIdentity ? Map.copyOf(tree.identities) : Map.of()");
    expect(accessibility).toContain("String expectedIdentity = lastNodeIdentities.get(nodeId)");
    expect(accessibility).toContain("node_identity_changed");
    expect(accessibility).toContain("node_identity_unavailable");
    expect(accessibility).toContain("node.getUniqueId()");
  });

  it("validates replacement configuration and fully stops the old loop before rotating credentials", () => {
    const activity = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/MainActivity.java"), "utf8");
    const config = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/ConfigRepository.java"), "utf8");
    const saveBody = activity.slice(activity.indexOf("private void saveConfiguration()"), activity.indexOf("private void startControl()"));
    const startBody = activity.slice(activity.indexOf("private void startControl()"), activity.indexOf("private void stopControl()"));
    expect(config).toContain("public boolean canSave(");
    expect(saveBody.indexOf("config.canSave(")).toBeGreaterThan(-1);
    expect(saveBody.indexOf("config.canSave(")).toBeLessThan(saveBody.indexOf("RemoteControlService.stopFromOwner("));
    expect(startBody.indexOf("config.canSave(")).toBeGreaterThan(-1);
    expect(startBody.indexOf("RemoteControlService.stopFromOwner(this)")).toBeGreaterThan(startBody.indexOf("config.canSave("));
    expect(startBody.indexOf("RemoteControlService.stopFromOwner(this)")).toBeLessThan(startBody.indexOf("config.save("));
    const configSaveBody = config.slice(config.indexOf("public boolean save("), config.indexOf("public void setEnabled("));
    expect(configSaveBody).toContain(".commit()");
    expect(configSaveBody).not.toContain(".apply()");
    expect(config).toContain("setEnabledDurably");
    expect(config).toContain('CONTROL_GENERATION = "control_generation"');
    expect(config).toContain("editor.putLong(CONTROL_GENERATION, next)");
    expect(config).toContain(".commit()");
  });

  it("reports the durable local-control generation in every poll state", () => {
    const protocol = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/Protocol.java"), "utf8");
    expect(protocol).toContain('.put("controlGeneration", new ConfigRepository(context).controlGeneration())');
  });

  it("reports desired enablement separately from the live control loop", () => {
    const activity = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/MainActivity.java"), "utf8");
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    expect(activity).toContain("Control desired enabled:");
    expect(activity).toContain("Control loop running:");
    expect(service).toContain("public static boolean isControlLoopRunning()");
  });

  it("keeps the Accessibility/Tailscale baseline alive when optional Shizuku transport is lost", () => {
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    const shellCatchStart = service.indexOf("catch (ShellBridgeManager.ShellBridgeException failure)");
    const shellCatchEnd = service.indexOf("\n                } else {", shellCatchStart);
    const shellCatch = service.slice(shellCatchStart, shellCatchEnd);
    expect(shellCatch).toContain("knownPreEffectFailure");
    expect(shellCatch).toContain("boolean unknown = !knownPreEffectFailure");
    expect(shellCatch).toContain("CommandLedger.OUTCOME_UNKNOWN");
    expect(shellCatch).toContain('"outcome_unknown"');
    expect(shellCatch).not.toContain("uncertain =");
  });

  it("routes timeout classification through the JVM-tested atomic disposition seam", () => {
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    const disposition = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/TimeoutDisposition.java"), "utf8");
    expect(service).toContain("TimeoutDisposition disposition = TimeoutDisposition.cancel(lease)");
    expect(service).toContain("uncertain = disposition.uncertain");
    expect(disposition).toContain("lease.cancelAndEffectStarted()");
    expect(disposition).toContain("command_timed_out_before_effect");
  });

  it("requires an active VPN before sending a bearer credential to Tailscale HTTP", () => {
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    const transportCheck = service.indexOf("EndpointValidator.requireSafeTransport(endpoint, hasActiveVpnRoute(this, endpoint))");
    const authHeader = service.indexOf('connection.setRequestProperty("Authorization"');
    expect(transportCheck).toBeGreaterThan(-1);
    expect(authHeader).toBeGreaterThan(transportCheck);
    expect(service).toContain("TRANSPORT_VPN");
    expect(service).toContain("route.matches(destination)");
    expect(service).toContain("parseNumericAddress(host)");
    expect(service).toContain("throw new IOException(unsafeTransport.getMessage(), unsafeTransport)");
  });

  it("bounds screenshot wire size and degrades oversized PNGs without changing display dimensions", () => {
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    const budget = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/ScreenshotBudget.java"), "utf8");
    expect(budget).toContain("MAX_COMPRESSED_BYTES = 8 * 1024 * 1024");
    expect(accessibility).toContain("Bitmap.CompressFormat.PNG");
    expect(accessibility).toContain("Bitmap.CompressFormat.JPEG");
    expect(accessibility).toContain('ScreenshotData.unavailable("screenshot_too_large")');
    expect(service).toContain("response.status == 413 && !compactFallback");
    expect(service).toContain('"result_too_large"');
    expect(service).toContain("CommandLedger.OUTCOME_UNKNOWN");
  });

  it("streams shell results outside Binder, gates effects, and exposes explicit cancellation", () => {
    const aidl = readFileSync(path.join(appRoot, "aidl/eu/astancu/rcmcp/android/IShellBridge.aidl"), "utf8");
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    const bridge = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/ShellBridgeManager.java"), "utf8");
    const userService = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/ShellUserService.java"), "utf8");
    expect(aidl).toContain("ParcelFileDescriptor exec(");
    expect(aidl).toContain("in ParcelFileDescriptor commandInput");
    expect(aidl).not.toContain("String command");
    expect(aidl).toContain("void cancel(String executionId)");
    expect(bridge).toContain("AutoCloseInputStream");
    expect(bridge).toContain("AutoCloseOutputStream");
    expect(bridge).toContain("DISPATCH_GATE.acquire");
    const gateAcquire = bridge.indexOf("DISPATCH_GATE.acquire");
    const leaseRecheck = bridge.indexOf("!lease.mayRun()", gateAcquire);
    const binderExec = bridge.indexOf("current.exec(", leaseRecheck);
    expect(leaseRecheck).toBeGreaterThan(gateAcquire);
    expect(binderExec).toBeGreaterThan(leaseRecheck);
    expect(bridge).toContain("DISPATCH_GATE.release");
    expect(bridge).toContain("cancelActive()");
    expect(bridge).toContain("Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED");
    expect(bridge).toContain("Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED");
    expect(bridge).toContain('return "permission_required"');
    expect(service).toContain("ExecutionLease lease = new ExecutionLease(");
    expect(service).toContain("ShellBridgeManager.cancelActive()");
    expect(userService).toContain("CaptureBudget");
    expect(userService).toContain("readCommand(input, commandBytes)");
    expect(userService).toContain("shell_command_stream_truncated");
    const commandRead = userService.indexOf("command = readCommand(input, commandBytes)");
    const commandClose = userService.indexOf("input.close()", commandRead);
    const commandExecute = userService.indexOf("payload = executeCommand(", commandClose);
    expect(commandRead).toBeGreaterThan(-1);
    expect(commandClose).toBeGreaterThan(commandRead);
    expect(commandExecute).toBeGreaterThan(commandClose);
    expect(userService).toContain("A close failure must not rewrite a later");
    expect(userService).toContain("terminateTree(");
    expect(userService).toContain('EXECUTION_MARKER = "RCMCP_EXECUTION_ID"');
    expect(userService).toContain("builder.environment().put(EXECUTION_MARKER, executionId)");
    expect(userService).toContain("executionPids(executionId)");
    expect(userService).toContain("SIGSTOP");
    expect(userService).toContain("SIGKILL");
    expect(userService).toContain("return new Termination(true, false, forced)");
    expect(userService).toContain("terminationVerified");
  });

  it("protects replacement-token entry without blocking ordinary status screenshots", () => {
    const activity = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/MainActivity.java"), "utf8");
    const onCreate = activity.slice(activity.indexOf("protected void onCreate"), activity.indexOf("protected void onResume"));
    const initialSecure = onCreate.indexOf("getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE)");
    const buildUi = onCreate.indexOf("buildUi()");
    const scopeProtection = onCreate.indexOf("updateSensitiveWindowProtection()", buildUi);
    expect(initialSecure).toBeGreaterThan(-1);
    expect(buildUi).toBeGreaterThan(initialSecure);
    expect(scopeProtection).toBeGreaterThan(buildUi);
    expect(activity).toContain("token.setOnFocusChangeListener");
    expect(activity).toContain("token.addTextChangedListener");
    expect(activity).toContain("token.hasFocus() || token.length() > 0");
    expect(activity).toContain("getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE)");
  });

  it("recovers desired control when Accessibility reconnects after update or boot", () => {
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    const service = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteControlService.java"), "utf8");
    const boot = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/BootReceiver.java"), "utf8");
    expect(accessibility).toContain("RemoteControlService.recoverIfDesired(this)");
    expect(boot).toContain("RemoteControlService.recoverIfDesired(context)");
    expect(service).toContain("public static boolean recoverIfDesired");
    expect(service).toContain("!recoveryConfig.enabled()");
    expect(service).toContain("recoveryConfig.authBlocked()");
    expect(service).toContain("!hasControlNotificationPermission(context)");
  });

  it("moves expensive screenshot encoding off the Android main executor", () => {
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    expect(accessibility).toContain("rcmcp-screenshot-encoder");
    expect(accessibility).toContain("screenshotEncoder.execute(() ->");
    expect(accessibility).toContain("screenshotEncoder.shutdownNow()");
  });

  it("does not stop UI-tree traversal merely because one field was truncated", () => {
    const accessibility = readFileSync(path.join(appRoot, "java/eu/astancu/rcmcp/android/RemoteAccessibilityService.java"), "utf8");
    expect(accessibility).toContain('output.put("fieldsTruncated", tree.budget.fieldTruncated())');
    expect(accessibility).not.toContain("node.getChildCount() && !collection.truncated");
    expect(accessibility).toContain("collection.nodes.length() >= maxNodes || collection.budget.exhausted()");
  });
});
