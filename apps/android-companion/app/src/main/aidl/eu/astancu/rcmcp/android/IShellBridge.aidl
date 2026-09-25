package eu.astancu.rcmcp.android;

import android.os.ParcelFileDescriptor;

interface IShellBridge {
    ParcelFileDescriptor exec(String executionId, in ParcelFileDescriptor commandInput, int commandBytes, long deadlineElapsedMs, long timeoutMs, int maxOutputBytes);
    void cancel(String executionId);
    int uid();
}
