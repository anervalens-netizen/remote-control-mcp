package eu.astancu.rcmcp.android;

public final class Deadline {
    private final long localDeadlineElapsedMs;

    private Deadline(long localDeadlineElapsedMs) {
        this.localDeadlineElapsedMs = localDeadlineElapsedMs;
    }

    public static Deadline fromServerTiming(long serverTimeMs, long expiresAtMs,
                                            long requestStartedElapsedMs, long responseReceivedElapsedMs,
                                            long serverWaitMs) {
        long ttlAtServerSend = Math.max(0L, expiresAtMs - serverTimeMs);
        long clientRoundTrip = Math.max(0L, responseReceivedElapsedMs - requestStartedElapsedMs);
        // New controllers report long-poll wait so only request/response
        // transit + processing consumes the TTL. Older v1 controllers cannot
        // distinguish long-poll wait from transit, so fail closed by charging
        // the entire measured RTT against the server TTL. This may expire a
        // legacy command early, but it can never grant time beyond expiry.
        long networkAndProcessing = serverWaitMs < 0L
                ? clientRoundTrip
                : Math.max(0L, clientRoundTrip - serverWaitMs);
        long remainingAtReceipt = Math.max(0L, ttlAtServerSend - networkAndProcessing);
        long localDeadline = responseReceivedElapsedMs > Long.MAX_VALUE - remainingAtReceipt
                ? Long.MAX_VALUE : responseReceivedElapsedMs + remainingAtReceipt;
        return new Deadline(localDeadline);
    }

    public boolean isExpired(long elapsedMs) {
        return elapsedMs >= localDeadlineElapsedMs;
    }

    public long localDeadlineElapsedMs() {
        return localDeadlineElapsedMs;
    }
}
