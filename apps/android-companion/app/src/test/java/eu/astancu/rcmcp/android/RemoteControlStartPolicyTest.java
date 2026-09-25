package eu.astancu.rcmcp.android;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class RemoteControlStartPolicyTest {
    @Test public void explicitStartRunsWhenLocalInvariantsAllowIt() {
        assertEquals(RemoteControlStartPolicy.Decision.START_STICKY,
                RemoteControlStartPolicy.decide(false, true, false, true, false));
    }

    @Test public void localStopAlwaysWins() {
        assertEquals(RemoteControlStartPolicy.Decision.STOP_NOT_STICKY,
                RemoteControlStartPolicy.decide(true, true, true, true, false));
    }

    @Test public void processReclaimResumesOnlyWhenOwnerStillEnabledControl() {
        assertEquals(RemoteControlStartPolicy.Decision.START_STICKY,
                RemoteControlStartPolicy.decide(false, false, true, true, false));
        assertEquals(RemoteControlStartPolicy.Decision.STOP_NOT_STICKY,
                RemoteControlStartPolicy.decide(false, false, false, true, false));
    }

    @Test public void revokedNotificationPermissionBlocksRestart() {
        assertEquals(RemoteControlStartPolicy.Decision.STOP_NOT_STICKY,
                RemoteControlStartPolicy.decide(false, false, true, false, false));
    }

    @Test public void authenticationBlockBlocksRestart() {
        assertEquals(RemoteControlStartPolicy.Decision.STOP_NOT_STICKY,
                RemoteControlStartPolicy.decide(false, false, true, true, true));
    }
}
