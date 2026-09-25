package eu.astancu.rcmcp.android;

import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class SharedPrefsLedgerStore implements CommandLedger.Store {
    private static final String PREFIX = "command.";
    private static final String SEEN_FILTER = "seen_filter_v1";
    private static final int MAX_DETAILED_COMMANDS = 256;
    private final SharedPreferences preferences;
    private final SeenCommandFilter seenFilter;

    public SharedPrefsLedgerStore(SharedPreferences preferences) {
        this.preferences = preferences;
        try {
            this.seenFilter = SeenCommandFilter.decode(preferences.getString(SEEN_FILTER, ""));
        } catch (RuntimeException corrupt) {
            throw new IllegalStateException("command_seen_filter_invalid", corrupt);
        }
    }

    @Override
    public String get(String commandId) {
        return preferences.getString(PREFIX + commandId, null);
    }

    @Override
    public void put(String commandId, String value) {
        if (!preferences.edit().putString(PREFIX + commandId, value).commit()) {
            throw new IllegalStateException("command_ledger_persist_failed");
        }
        compactIfNeeded();
    }

    @Override
    public boolean seen(String commandId) {
        return seenFilter.mightContain(commandId);
    }

    private void compactIfNeeded() {
        Map<String, ?> all = preferences.getAll();
        int detailed = 0;
        List<String> terminalKeys = new ArrayList<>();
        for (Map.Entry<String, ?> entry : all.entrySet()) {
            if (!entry.getKey().startsWith(PREFIX) || !(entry.getValue() instanceof String value)) continue;
            detailed++;
            int separator = value.indexOf('\n');
            String status = separator < 0 ? "" : value.substring(separator + 1);
            if (CommandLedger.COMPLETED.equals(status) || CommandLedger.ERROR.equals(status)
                    || CommandLedger.OUTCOME_UNKNOWN.equals(status)) {
                terminalKeys.add(entry.getKey());
            }
        }
        if (detailed <= MAX_DETAILED_COMMANDS) return;
        List<String> victims = new ArrayList<>();
        for (String key : terminalKeys) {
            if (detailed <= MAX_DETAILED_COMMANDS) break;
            String commandId = key.substring(PREFIX.length());
            seenFilter.add(commandId);
            victims.add(key);
            detailed--;
        }
        if (victims.isEmpty()) return;
        // Persist the fail-closed filter first. A crash before removal leaves
        // redundant details; a crash after the filter write still cannot replay.
        if (!preferences.edit().putString(SEEN_FILTER, seenFilter.encode()).commit()) {
            throw new IllegalStateException("command_seen_filter_persist_failed");
        }
        SharedPreferences.Editor remove = preferences.edit();
        for (String key : victims) remove.remove(key);
        if (!remove.commit()) throw new IllegalStateException("command_ledger_compaction_failed");
    }

    @Override
    public Set<String> keys() {
        Set<String> result = new HashSet<>();
        for (String key : preferences.getAll().keySet()) {
            if (key.startsWith(PREFIX)) result.add(key.substring(PREFIX.length()));
        }
        return result;
    }
}
