package eu.astancu.rcmcp.android;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import java.util.HashMap;
import java.util.Map;

public final class PendingDownloadCleanupJob extends JobService {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<Integer, CleanupRun> runs = new HashMap<>();

    @Override public boolean onStartJob(JobParameters parameters) {
        int id = parameters.getJobId();
        CleanupRun previous = runs.remove(id);
        if (previous != null) previous.stop();
        CancellationSignal cancellation = new CancellationSignal();
        CleanupRun run = new CleanupRun(cancellation::cancel);
        runs.put(id, run);
        Thread worker = new Thread(() -> {
            try { PendingDownloadCleanup.run(this, cancellation); }
            finally {
                main.post(() -> {
                    // The main-thread callback cannot race onStopJob. A stopped
                    // or replaced run must never finish a newer scheduled job.
                    if (runs.get(id) == run) run.finish(() -> {
                        runs.remove(id);
                        jobFinished(parameters, false);
                    });
                });
            }
        }, "pending-download-cleanup");
        run.attach(worker);
        worker.start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters parameters) {
        CleanupRun run = runs.remove(parameters.getJobId());
        if (run != null) run.stop();
        return true;
    }

    @Override public void onDestroy() {
        for (CleanupRun run : runs.values()) run.stop();
        runs.clear();
        super.onDestroy();
    }
}
