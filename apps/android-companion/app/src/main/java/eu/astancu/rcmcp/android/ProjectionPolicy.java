package eu.astancu.rcmcp.android;

/** In-memory, one-shot owner gesture authorization; never persisted across process death. */
final class ProjectionPolicy {
    static final long CAPTURE_TIMEOUT_MS = 2500L;
    private long generation;
    private long pending;

    synchronized long request(int sdk, boolean allowed) {
        invalidate();
        if (sdk != 29 || !allowed) return 0;
        pending = generation;
        return pending;
    }

    synchronized boolean consume(long ticket, int sdk, boolean consented, boolean allowed) {
        boolean accepted = ticket != 0 && ticket == pending && sdk == 29 && consented && allowed;
        invalidate();
        return accepted;
    }

    synchronized void invalidate() { pending = 0; generation++; }

    static boolean sameDisplay(int width, int height, int rotation, int otherWidth, int otherHeight, int otherRotation) {
        return width == otherWidth && height == otherHeight && rotation == otherRotation;
    }
}
