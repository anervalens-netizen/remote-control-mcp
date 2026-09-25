package eu.astancu.rcmcp.android;

final class RemoteControlStartPolicy {
    enum Decision { START_STICKY, STOP_NOT_STICKY }

    private RemoteControlStartPolicy() {}

    static Decision decide(boolean stopRequested, boolean explicitStart, boolean desiredEnabled,
                           boolean notificationAllowed, boolean authBlocked) {
        if (stopRequested) return Decision.STOP_NOT_STICKY;
        boolean wantsControl = explicitStart || desiredEnabled;
        if (!wantsControl || !notificationAllowed || authBlocked) return Decision.STOP_NOT_STICKY;
        return Decision.START_STICKY;
    }
}
