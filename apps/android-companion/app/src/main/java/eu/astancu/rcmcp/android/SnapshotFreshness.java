package eu.astancu.rcmcp.android;

import java.util.UUID;

public final class SnapshotFreshness {
    public static final long MAX_AGE_MS = 15_000L;

    public static final class Metadata {
        public final String snapshotId;
        public final long observedAtWallMs;
        public final long observedAtElapsedMs;
        public final int width;
        public final int height;
        public final int rotation;
        public final long generation;

        public Metadata(long observedAtWallMs, long observedAtElapsedMs, int width, int height,
                        int rotation, long generation) {
            this.snapshotId = UUID.randomUUID().toString();
            this.observedAtWallMs = observedAtWallMs;
            this.observedAtElapsedMs = observedAtElapsedMs;
            this.width = width;
            this.height = height;
            this.rotation = rotation;
            this.generation = generation;
        }
    }

    private SnapshotFreshness() {}

    public static boolean isFresh(Metadata snapshot, String expectedSnapshotId, long nowElapsedMs,
                                  long currentGeneration, int width, int height, int rotation) {
        return snapshot != null
                && snapshot.snapshotId.equals(expectedSnapshotId)
                && nowElapsedMs - snapshot.observedAtElapsedMs < MAX_AGE_MS
                && nowElapsedMs >= snapshot.observedAtElapsedMs
                && snapshot.generation == currentGeneration
                && snapshot.width == width
                && snapshot.height == height
                && snapshot.rotation == rotation;
    }
}
