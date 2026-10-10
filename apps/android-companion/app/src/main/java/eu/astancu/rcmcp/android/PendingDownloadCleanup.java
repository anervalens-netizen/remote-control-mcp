package eu.astancu.rcmcp.android;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;

final class PendingDownloadCleanup {
    private static final int JOB_ID = 32002;
    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler != null) scheduler.schedule(new JobInfo.Builder(JOB_ID,
                new ComponentName(context, PendingDownloadCleanupJob.class))
                .setPeriodic(15 * 60_000L).setPersisted(true).build());
    }
    static void run(Context context) {
        long cutoff = System.currentTimeMillis() / 1000 - 3600;
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        android.os.Bundle query = new android.os.Bundle();
        String selection = MediaStore.Downloads.IS_PENDING + " = 1 AND " + MediaStore.Downloads.OWNER_PACKAGE_NAME + " = ? AND " + MediaStore.Downloads.DATE_ADDED + " <= ?";
        String[] arguments = { context.getPackageName(), Long.toString(cutoff) };
        query.putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
        query.putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arguments);
        if (android.os.Build.VERSION.SDK_INT >= 30) query.putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_ONLY);
        else collection = MediaStore.setIncludePending(collection);
        // Scoped storage allows our own pending downloads. Never touch published
        // files or another application's downloads, including after process death.
        try (Cursor rows = context.getContentResolver().query(collection,
                new String[] { MediaStore.Downloads._ID },
                query, null)) {
            if (rows == null) return;
            while (rows.moveToNext()) context.getContentResolver().delete(
                    android.content.ContentUris.withAppendedId(collection, rows.getLong(0)), selection, arguments);
        } catch (RuntimeException unavailable) {
            // Media provider availability is transient; the persisted job retries.
        }
    }
}
