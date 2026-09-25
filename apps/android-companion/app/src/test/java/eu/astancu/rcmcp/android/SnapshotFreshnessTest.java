package eu.astancu.rcmcp.android;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class SnapshotFreshnessTest {
    @Test public void acceptsMatchingRecentSnapshot() {
        SnapshotFreshness.Metadata snapshot = new SnapshotFreshness.Metadata(1000L, 500L, 1080, 2400, 1, 7L);
        assertTrue(SnapshotFreshness.isFresh(snapshot, snapshot.snapshotId, 14_999L, 7L, 1080, 2400, 1));
    }

    @Test public void rejectsAgeGenerationAndDisplayChanges() {
        SnapshotFreshness.Metadata snapshot = new SnapshotFreshness.Metadata(1000L, 500L, 1080, 2400, 1, 7L);
        assertFalse(SnapshotFreshness.isFresh(snapshot, snapshot.snapshotId, 15_500L, 7L, 1080, 2400, 1));
        assertFalse(SnapshotFreshness.isFresh(snapshot, snapshot.snapshotId, 1000L, 8L, 1080, 2400, 1));
        assertFalse(SnapshotFreshness.isFresh(snapshot, snapshot.snapshotId, 1000L, 7L, 2400, 1080, 1));
        assertFalse(SnapshotFreshness.isFresh(snapshot, "other", 1000L, 7L, 1080, 2400, 1));
    }
}
