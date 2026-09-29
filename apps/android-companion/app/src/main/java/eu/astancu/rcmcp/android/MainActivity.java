package eu.astancu.rcmcp.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final int IMPORT_CONFIGURATION = 43;
    private static final int SCREEN_SHARING = 44;
    private boolean importPending;
    private boolean foreground;
    private boolean sharingPending;
    private boolean notificationPending;
    private final ImportGeneration importGeneration = new ImportGeneration();
    private BackgroundConfigurationImport.Job importJob;
    private Runnable importTimeout;
    private long importStopEpoch;
    private boolean importedUnsaved;
    private long consentTicket;
    private ConfigRepository config;
    private TextView status;
    private TextView importStatus;
    private TextView sharingStatus;
    private final android.os.Handler statusHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable sharingStatusUpdate = new Runnable() {
        @Override public void run() {
            if (sharingStatus == null) return;
            sharingStatus.setText("Screen sharing: " + ProjectionScreenshotService.status());
            statusHandler.postDelayed(this, 1000L);
        }
    };
    private EditText endpoint;
    private EditText token;
    private EditText device;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        foreground = true;
        if (state != null) {
            importPending = state.getBoolean("importPending");
            sharingPending = state.getBoolean("sharingPending");
            consentTicket = state.getLong("consentTicket");
            notificationPending = state.getBoolean("notificationPending");
        }
        importStopEpoch = state == null ? BackgroundConfigurationImport.stopEpoch() : state.getLong("importStopEpoch");
        updateLocalBoundary();
        // Pairing/configuration includes a bearer credential entry surface. Protect
        // the window before any credential UI is constructed so an already-active
        // remote Accessibility session cannot capture replacement credentials.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        config = new ConfigRepository(this);
        ShellBridgeManager.init(this);
        buildUi();
        if (state != null) {
            String endpointDraft = state.getString("endpointDraft");
            String deviceDraft = state.getString("deviceDraft");
            if (endpointDraft != null) endpoint.setText(endpointDraft);
            if (deviceDraft != null) device.setText(deviceDraft);
        }
        updateSensitiveWindowProtection();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestNotificationPermission();
        }
    }

    private void updateLocalBoundary() {
        LocalConsentBoundary.INSTANCE.update(this, foreground,
                importPending || sharingPending || notificationPending);
    }

    @Override protected void onStart() {
        super.onStart();
        foreground = true;
        updateLocalBoundary();
    }

    @Override protected void onStop() {
        foreground = false;
        updateLocalBoundary();
        super.onStop();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putBoolean("importPending", importPending);
        state.putLong("importStopEpoch", importStopEpoch);
        state.putBoolean("sharingPending", sharingPending);
        state.putLong("consentTicket", consentTicket);
        state.putBoolean("notificationPending", notificationPending);
        // Non-secret drafts survive recreation. The credential field is deliberately
        // excluded from both view state and this Bundle.
        if (endpoint != null) state.putString("endpointDraft", endpoint.getText().toString());
        if (device != null) state.putString("deviceDraft", device.getText().toString());
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        importGeneration.destroy();
        cancelImport();
        statusHandler.removeCallbacksAndMessages(null);
        LocalConsentBoundary.INSTANCE.destroy(this);
        super.onDestroy();
    }

    private void requestNotificationPermission() {
        if (notificationPending) return;
        notificationPending = true;
        updateLocalBoundary();
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
        } catch (RuntimeException unavailable) {
            notificationPending = false;
            updateLocalBoundary();
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 42) {
            notificationPending = false;
            updateLocalBoundary();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (status != null) refreshStatus();
        statusHandler.removeCallbacks(sharingStatusUpdate);
        if (Build.VERSION.SDK_INT == 29) statusHandler.post(sharingStatusUpdate);
    }

    @Override
    protected void onPause() {
        statusHandler.removeCallbacks(sharingStatusUpdate);
        super.onPause();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(36, 32, 36, 32);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("RC Android Companion");
        title.setTextSize(24);
        title.setTextColor(Color.BLACK);
        root.addView(title, matchWrap());

        TextView explanation = new TextView(this);
        explanation.setText("Owner-authorized Android control over the configured controller.\n"
                + "The phone initiates the authenticated connection. Baseline control needs no ADB or Shizuku. Rootless input and UI-tree observation use Accessibility. Android 11+ screenshots use Accessibility. Android 10 screenshots need separate screen-sharing consent, possibly again after reboot.\n"
                + "Optional shell uses Shizuku and requires its separate permission; baseline control remains available without it.");
        explanation.setPadding(0, 18, 0, 18);
        root.addView(explanation, matchWrap());

        endpoint = field("Controller endpoint (HTTPS, or literal Tailscale 100.64/10 HTTP)", false);
        endpoint.setText(config.endpoint());
        root.addView(endpoint, matchWrap());

        token = field("New bearer credential (leave blank to keep stored credential)", true);
        token.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        token.setOnFocusChangeListener((view, hasFocus) -> updateSensitiveWindowProtection());
        token.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
                updateSensitiveWindowProtection();
            }
            @Override public void afterTextChanged(Editable value) {}
        });
        root.addView(token, matchWrap());

        device = field("Device identity", false);
        device.setText(config.deviceId());
        root.addView(device, matchWrap());

        Button importConfiguration = button("Import configuration (JSON)");
        importConfiguration.setOnClickListener(v -> {
            if (importPending) return;
            cancelImport();
            if (BackgroundConfigurationImport.busy()) {
                importStatus.setText("Previous import is still closing. Try again later.");
                return;
            }
            importStopEpoch = BackgroundConfigurationImport.stopEpoch();
            importPending = true;
            updateLocalBoundary();
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            try {
                startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/json"), IMPORT_CONFIGURATION);
            } catch (RuntimeException unavailable) {
                importPending = false;
                updateLocalBoundary();
                updateSensitiveWindowProtection();
                status.setText("No document picker available.");
            }
        });
        root.addView(importConfiguration, matchWrap());
        importStatus = new TextView(this);
        root.addView(importStatus, matchWrap());

        Button save = button("Save configuration");
        save.setOnClickListener(v -> saveConfiguration());
        root.addView(save, matchWrap());

        Button start = button("Start foreground control");
        start.setOnClickListener(v -> startControl());
        root.addView(start, matchWrap());

        Button stop = button("STOP locally");
        stop.setOnClickListener(v -> stopControl());
        root.addView(stop, matchWrap());

        Button accessibility = button("Open Accessibility settings");
        accessibility.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        root.addView(accessibility, matchWrap());

        if (Build.VERSION.SDK_INT == 29) {
            Button sharing = button("Enable screen sharing (Android 10)");
            sharing.setOnClickListener(v -> {
                if (sharingPending) return;
                consentTicket = ProjectionScreenshotService.requestConsent(this);
                if (consentTicket == 0) {
                    status.setText("Start control and enable Accessibility on the unlocked screen first.");
                    return;
                }
                sharingPending = true;
                updateLocalBoundary();
                try {
                    startActivityForResult(getSystemService(android.media.projection.MediaProjectionManager.class)
                            .createScreenCaptureIntent(), SCREEN_SHARING);
                } catch (RuntimeException unavailable) {
                    consentTicket = 0;
                    sharingPending = false;
                    updateLocalBoundary();
                    ProjectionScreenshotService.stop(this, "screen_sharing_start_failed");
                    refreshStatus();
                }
            });
            root.addView(sharing, matchWrap());
            sharingStatus = new TextView(this);
            root.addView(sharingStatus, matchWrap());
        }

        Button battery = button("Open battery optimization settings");
        battery.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)));
        root.addView(battery, matchWrap());

        Button shell = button("Enable Shizuku shell");
        shell.setOnClickListener(v -> {
            ShellBridgeManager.requestPermissionAndBind(this);
            refreshStatus();
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(this::refreshStatus, 1200L);
        });
        root.addView(shell, matchWrap());

        status = new TextView(this);
        status.setPadding(0, 24, 0, 0);
        root.addView(status, matchWrap());
        setContentView(scroll);
        refreshStatus();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SCREEN_SHARING) {
            sharingPending = false;
            updateLocalBoundary();
            long ticket = consentTicket;
            consentTicket = 0;
            if (ticket != 0 && Build.VERSION.SDK_INT == 29) {
                ProjectionScreenshotService.startConsented(this, ticket, resultCode, data);
            }
            refreshStatus();
            return;
        }
        if (requestCode != IMPORT_CONFIGURATION || !importPending) return;
        importPending = false;
        updateLocalBoundary();
        if (importStopEpoch == BackgroundConfigurationImport.stopEpoch()
                && resultCode == RESULT_OK && data != null && data.getData() != null
                && "content".equals(data.getData().getScheme())) {
            startImport(data.getData());
        }
        updateSensitiveWindowProtection();
    }

    private void cancelImport() {
        importGeneration.cancel();
        if (importTimeout != null) statusHandler.removeCallbacks(importTimeout);
        importTimeout = null;
        if (importJob != null) importJob.cancel();
        importJob = null;
    }

    private void startImport(Uri uri) {
        cancelImport();
        long generation = importGeneration.begin();
        long stopEpoch = BackgroundConfigurationImport.stopEpoch();
        importJob = BackgroundConfigurationImport.start(getApplicationContext().getContentResolver(), uri,
                imported -> statusHandler.post(() -> {
                    if (!importGeneration.accepts(generation)
                            || stopEpoch != BackgroundConfigurationImport.stopEpoch()) return;
                    cancelImport();
                    if (imported == null) {
                        importStatus.setText("Import rejected: expected valid configuration JSON, at most 8192 bytes.");
                        return;
                    }
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                    importedUnsaved = true;
                    token.setText(imported.token);
                    endpoint.setText(imported.endpoint);
                    device.setText(imported.device);
                    importStatus.setText("Configuration imported for review. Press Save configuration to confirm; control has not started.");
                }));
        if (importJob == null) {
            importGeneration.cancel();
            importStatus.setText("Previous import is still closing. Try again later.");
            return;
        }
        importStatus.setText("Importing configuration…");
        importTimeout = () -> {
            if (!importGeneration.accepts(generation)) return;
            cancelImport();
            importStatus.setText("Import timed out after 5 seconds. Provider may still be closing.");
        };
        statusHandler.postDelayed(importTimeout, BackgroundConfigurationImport.TIMEOUT_MS);
    }

    private EditText field(String hint, boolean password) {
        EditText edit = new EditText(this);
        edit.setHint(hint);
        edit.setSingleLine(true);
        // Only the credential must be excluded from automatic view-state persistence.
        // Endpoint/device drafts are also copied explicitly into the Activity Bundle
        // because these programmatic views do not rely on stable resource IDs.
        edit.setSaveEnabled(!password);
        edit.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        if (password) edit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        return edit;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        return button;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private void saveConfiguration() {
        cancelImport();
        String endpointValue = endpoint.getText().toString();
        String tokenValue = token.getText().toString();
        String deviceValue = device.getText().toString();
        if (!config.canSave(endpointValue, tokenValue, deviceValue)) {
            status.setText("Configuration rejected: use HTTPS, or literal 100.64.0.0/10 HTTP; token and device are required.");
            return;
        }
        if (!RemoteControlService.stopFromOwner(this)) {
            status.setText("Unable to durably stop the previous control session; configuration was not replaced.");
            return;
        }
        if (!config.save(endpointValue, tokenValue, deviceValue)) {
            status.setText("Configuration changed before save; current stored configuration was kept.");
            return;
        }
        importedUnsaved = false;
        importStatus.setText("");
        token.setText("");
        status.setText("Configuration saved privately. Stored credential is never displayed.");
        refreshStatus();
    }

    private void startControl() {
        cancelImport();
        if (importedUnsaved) {
            status.setText("Review imported configuration and press Save configuration before starting control.");
            return;
        }
        if (!RemoteControlService.hasControlNotificationPermission(this)) {
            if (Build.VERSION.SDK_INT >= 33) requestNotificationPermission();
            status.setText("Notification permission is required so the persistent local STOP control remains visible.");
            refreshStatus();
            return;
        }
        String endpointValue = endpoint.getText().toString();
        String tokenValue = token.getText().toString();
        String deviceValue = device.getText().toString();
        if (!config.canSave(endpointValue, tokenValue, deviceValue)) {
            status.setText("Save a valid endpoint, token, and device identity first.");
            return;
        }
        if (!RemoteControlService.stopFromOwner(this)) {
            status.setText("Unable to durably stop the previous control session; configuration was not replaced.");
            return;
        }
        if (!config.save(endpointValue, tokenValue, deviceValue)) {
            status.setText("Configuration changed before start; current stored configuration was kept.");
            return;
        }
        token.setText("");
        config.setEnabled(true);
        config.clearAuthBlock();
        Intent intent = new Intent(this, RemoteControlService.class).setAction(RemoteControlService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
        refreshStatus();
    }

    private void stopControl() {
        cancelImport();
        boolean durable = RemoteControlService.stopFromOwner(this);
        refreshStatus();
        if (!durable) {
            status.append("\nWARNING: local STOP was applied to this process but could not be durably persisted.");
        }
    }

    private void updateSensitiveWindowProtection() {
        boolean protect = importPending || (token != null && (token.hasFocus() || token.length() > 0));
        if (protect) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    private void refreshStatus() {
        StringBuilder text = new StringBuilder();
        text.append("Build: ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE).append(")");
        text.append("\nConfigured: ").append(!Compatibility.isBlank(config.endpoint()) && !Compatibility.isBlank(config.token()));
        text.append("\nControl desired enabled: ").append(config.enabled());
        text.append("\nControl loop running: ").append(RemoteControlService.isControlLoopRunning());
        text.append("\nAccessibility service: ").append(RemoteAccessibilityService.isRunning());
        text.append("\nAuthentication blocked: ").append(config.authBlocked());
        text.append("\nNotification STOP available: ").append(RemoteControlService.hasControlNotificationPermission(this));
        text.append("\nTailscale/VPN route detected: ").append(RemoteControlService.hasActiveVpnRoute(this, config.endpoint()));
        text.append("\nTransport: ").append(RemoteControlService.transportStatus());
        text.append("\nShell available: ").append(ShellBridgeManager.isReady());
        text.append("\nShell bridge: ").append(ShellBridgeManager.reason());
        text.append("\nShell UID: ").append(ShellBridgeManager.uid());
        text.append("\nPhone-dependent qualification: not run");
        status.setText(text.toString());
    }
}
