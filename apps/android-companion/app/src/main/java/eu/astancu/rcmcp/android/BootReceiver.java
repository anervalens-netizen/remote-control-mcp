package eu.astancu.rcmcp.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.UserManager;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        UserManager user = (UserManager) context.getSystemService(Context.USER_SERVICE);
        if (user == null || !user.isUserUnlocked()) return;
        RemoteControlService.recoverIfDesired(context);
    }
}
