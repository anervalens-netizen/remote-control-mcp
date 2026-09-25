package eu.astancu.rcmcp.android;

/** Pure timeout classification seam used by the service and JVM regressions. */
public final class TimeoutDisposition {
    public final boolean uncertain;
    public final String ledgerStatus;
    public final String protocolStatus;
    public final String code;
    public final String message;

    private TimeoutDisposition(boolean uncertain, String ledgerStatus, String protocolStatus,
                               String code, String message) {
        this.uncertain = uncertain;
        this.ledgerStatus = ledgerStatus;
        this.protocolStatus = protocolStatus;
        this.code = code;
        this.message = message;
    }

    public static TimeoutDisposition cancel(ExecutionLease lease) {
        boolean effectStarted = lease.cancelAndEffectStarted();
        if (effectStarted) {
            return new TimeoutDisposition(true, CommandLedger.OUTCOME_UNKNOWN, "outcome_unknown",
                    "outcome_unknown", "action_completion_timeout_after_effect_started");
        }
        return new TimeoutDisposition(false, CommandLedger.ERROR, "error",
                "expired_before_effect", "command_timed_out_before_effect");
    }
}
