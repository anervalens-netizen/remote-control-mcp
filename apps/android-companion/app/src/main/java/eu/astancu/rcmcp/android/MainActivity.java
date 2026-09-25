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
    private ConfigRepository config;
    private TextView status;
    private EditText endpoint;
    private EditText token;
    private EditText device;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Pairing/configuration includes a bearer credential entry surface. Protect
        // the window before any credential UI is constructed so an already-active
        // remote Accessibility session cannot capture replacement credentials.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        config = new ConfigRepository(this);
        ShellBridgeManager.init(this);
        buildUi();
        updateSensitiveWindowProtection();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (status != null) refreshStatus();
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
                + "The phone initiates the authenticated connection. Baseline control needs no ADB or Shizuku and uses Accessibility instead of MediaProjection.\n"
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

    private EditText field(String hint, boolean password) {
        EditText edit = new EditText(this);
        edit.setHint(hint);
        edit.setSingleLine(true);
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
        token.setText("");
        status.setText("Configuration saved privately. Stored credential is never displayed.");
        refreshStatus();
    }

    private void startControl() {
        if (!RemoteControlService.hasControlNotificationPermission(this)) {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
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
        boolean durable = RemoteControlService.stopFromOwner(this);
        refreshStatus();
        if (!durable) {
            status.append("\nWARNING: local STOP was applied to this process but could not be durably persisted.");
        }
    }

    private void updateSensitiveWindowProtection() {
        boolean protect = token != null && (token.hasFocus() || token.length() > 0);
        if (protect) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    private void refreshStatus() {
        StringBuilder text = new StringBuilder();
        text.append("Build: ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE).append(")");
        text.append("\nConfigured: ").append(!config.endpoint().isBlank() && !config.token().isBlank());
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
