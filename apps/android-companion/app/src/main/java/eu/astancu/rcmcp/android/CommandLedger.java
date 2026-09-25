package eu.astancu.rcmcp.android;

import java.util.HashSet;
import java.util.Set;

/** Durable command tombstones. Values contain identity and status only. */
public final class CommandLedger {
    public static final String RESERVED = "reserved";
    public static final String STARTED = "started";
    public static final String COMPLETED = "completed";
    public static final String ERROR = "error";
    public static final String OUTCOME_UNKNOWN = "outcome_unknown";

    public interface Store {
        String get(String commandId);
        void put(String commandId, String value);
        Set<String> keys();
        default boolean seen(String commandId) { return false; }
    }

    public static final class Entry {
        public final String commandId;
        public final String deliveryId;
        public final String status;

        Entry(String commandId, String deliveryId, String status) {
            this.commandId = commandId;
            this.deliveryId = deliveryId;
            this.status = status;
        }
    }

    private final Store store;

    public CommandLedger(Store store) {
        this.store = store;
    }

    /** Converts any in-flight identity to a tombstone after process restart. */
    public synchronized void markInterruptedAsUnknown() {
        for (String commandId : new HashSet<>(store.keys())) {
            Entry entry = read(commandId);
            if (entry != null && (RESERVED.equals(entry.status) || STARTED.equals(entry.status))) {
                write(entry.commandId, entry.deliveryId, OUTCOME_UNKNOWN);
            }
        }
    }

    /** Reserves identity before the operation can reach the accessibility service. */
    public synchronized boolean reserve(String commandId, String deliveryId) {
        if (commandId == null || deliveryId == null || read(commandId) != null || store.seen(commandId)) {
            return false;
        }
        write(commandId, deliveryId, RESERVED);
        return true;
    }

    public synchronized boolean markStarted(String commandId, String deliveryId) {
        Entry entry = read(commandId);
        if (entry == null || !deliveryId.equals(entry.deliveryId)) return false;
        write(commandId, deliveryId, STARTED);
        return true;
    }

    public synchronized boolean finish(String commandId, String deliveryId, String status) {
        Entry entry = read(commandId);
        if (entry == null || !deliveryId.equals(entry.deliveryId)) return false;
        write(commandId, deliveryId, status);
        return true;
    }

    public synchronized Entry get(String commandId) {
        return read(commandId);
    }

    private Entry read(String commandId) {
        String encoded = store.get(commandId);
        if (encoded == null) return null;
        int separator = encoded.indexOf('\n');
        if (separator <= 0 || separator != encoded.lastIndexOf('\n') || separator == encoded.length() - 1) {
            throw new IllegalStateException("command_ledger_entry_invalid");
        }
        String status = encoded.substring(separator + 1);
        if (!RESERVED.equals(status) && !STARTED.equals(status) && !COMPLETED.equals(status)
                && !ERROR.equals(status) && !OUTCOME_UNKNOWN.equals(status)) {
            throw new IllegalStateException("command_ledger_status_invalid");
        }
        return new Entry(commandId, encoded.substring(0, separator), status);
    }

    private void write(String commandId, String deliveryId, String status) {
        store.put(commandId, deliveryId + "\n" + status);
    }
}
