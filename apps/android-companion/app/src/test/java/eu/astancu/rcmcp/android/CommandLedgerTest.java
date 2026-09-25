package eu.astancu.rcmcp.android;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class CommandLedgerTest {
    private static final class MemoryStore implements CommandLedger.Store {
        final Map<String, String> values = new HashMap<>();
        final Set<String> seen = new java.util.HashSet<>();
        @Override public String get(String key) { return values.get(key); }
        @Override public void put(String key, String value) { values.put(key, value); }
        @Override public Set<String> keys() { return values.keySet(); }
        @Override public boolean seen(String key) { return seen.contains(key); }
    }

    @Test public void identityIsReservedBeforeEffectAndCannotReplay() {
        MemoryStore store = new MemoryStore();
        CommandLedger ledger = new CommandLedger(store);
        assertTrue(ledger.reserve("c1", "d1"));
        assertFalse(ledger.reserve("c1", "d2"));
        assertTrue(ledger.markStarted("c1", "d1"));
        assertTrue(ledger.finish("c1", "d1", CommandLedger.COMPLETED));
        assertFalse(ledger.reserve("c1", "d1"));
        assertEquals(CommandLedger.COMPLETED, ledger.get("c1").status);
    }

    @Test public void compactedSeenIdentityCannotReplay() {
        MemoryStore store = new MemoryStore();
        store.seen.add("old");
        CommandLedger ledger = new CommandLedger(store);
        assertFalse(ledger.reserve("old", "new-delivery"));
    }

    @Test public void malformedExistingIdentityFailsClosedInsteadOfReplaying() {
        MemoryStore store = new MemoryStore();
        store.values.put("old", "truncated");
        CommandLedger ledger = new CommandLedger(store);
        org.junit.Assert.assertThrows(IllegalStateException.class, () -> ledger.reserve("old", "new-delivery"));
        store.values.put("old", "delivery\nnot-a-status");
        org.junit.Assert.assertThrows(IllegalStateException.class, () -> ledger.reserve("old", "new-delivery"));
    }

    @Test public void restartTurnsInFlightCommandsIntoUnknownTombstones() {
        MemoryStore store = new MemoryStore();
        CommandLedger ledger = new CommandLedger(store);
        assertTrue(ledger.reserve("reserved", "d1"));
        assertTrue(ledger.reserve("started", "d2"));
        assertTrue(ledger.markStarted("started", "d2"));
        ledger.markInterruptedAsUnknown();
        assertEquals(CommandLedger.OUTCOME_UNKNOWN, ledger.get("reserved").status);
        assertEquals(CommandLedger.OUTCOME_UNKNOWN, ledger.get("started").status);
        assertFalse(ledger.reserve("started", "d3"));
    }
}
