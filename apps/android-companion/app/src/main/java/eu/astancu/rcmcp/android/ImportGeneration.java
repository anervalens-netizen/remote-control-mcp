package eu.astancu.rcmcp.android;

/** UI-thread generation: timeout, replacement and destruction invalidate late delivery. */
final class ImportGeneration {
    private long generation;
    private boolean active = true;
    private boolean pending;
    long begin() { pending = true; return ++generation; }
    boolean accepts(long value) { return active && pending && generation == value; }
    void cancel() { pending = false; generation++; }
    void destroy() { cancel(); active = false; }
}
