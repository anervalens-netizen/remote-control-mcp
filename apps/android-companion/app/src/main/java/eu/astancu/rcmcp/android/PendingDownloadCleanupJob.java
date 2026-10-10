package eu.astancu.rcmcp.android;

import android.app.job.JobParameters;
import android.app.job.JobService;

public final class PendingDownloadCleanupJob extends JobService {
    @Override public boolean onStartJob(JobParameters parameters) {
        new Thread(() -> { PendingDownloadCleanup.run(this); jobFinished(parameters, false); }, "pending-download-cleanup").start();
        return true;
    }
    @Override public boolean onStopJob(JobParameters parameters) { return true; }
}
