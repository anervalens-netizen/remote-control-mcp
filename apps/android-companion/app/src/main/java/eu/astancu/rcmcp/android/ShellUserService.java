package eu.astancu.rcmcp.android;

import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.os.RemoteException;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Runs inside a Shizuku UserService process. When Shizuku itself was started
 * from adb, this process has the Android shell identity (UID 2000), not root.
 *
 * Command results are streamed through a pipe instead of a Binder String so
 * large bounded output never depends on Binder's transaction-size ceiling.
 */
public final class ShellUserService extends IShellBridge.Stub {
    private static final int DESTROY_TRANSACTION = 16777114;
    private static final long PRESTART_CANCEL_TTL_MS = 60_000L;
    private static final int MAX_COMMAND_BYTES = 16 * 1024 * 1024;
    private static final String EXECUTION_MARKER = "RCMCP_EXECUTION_ID";

    private final ConcurrentHashMap<String, RunningExecution> active = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Long> cancelledBeforeStart = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "rcmcp-shell-worker");
        thread.setDaemon(true);
        return thread;
    });

    public ShellUserService() {}

    @Override
    public int uid() {
        return Process.myUid();
    }

    @Override
    public ParcelFileDescriptor exec(String executionId, ParcelFileDescriptor commandInput, int commandBytes,
                                     long deadlineElapsedMs, long timeoutMs, int maxOutputBytes) throws RemoteException {
        if (executionId == null || executionId.isBlank()) throw new RemoteException("missing_execution_id");
        if (commandInput == null) throw new RemoteException("missing_command_pipe");
        final ParcelFileDescriptor[] pipe;
        try {
            pipe = ParcelFileDescriptor.createPipe();
        } catch (IOException failure) {
            throw new RemoteException("shell_pipe_failed");
        }

        workers.execute(() -> {
            try (OutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                String payload = error("shell_command_stream_failed", "shell_command_not_read");
                String command = null;
                InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(commandInput);
                try {
                    command = readCommand(input, commandBytes);
                } catch (IOException invalidCommandStream) {
                    payload = error("shell_command_stream_failed", invalidCommandStream.getMessage());
                } finally {
                    try {
                        input.close();
                    } catch (IOException ignoredClose) {
                        // A complete read already established the exact command
                        // bytes. A close failure must not rewrite a later
                        // execution result into a false pre-effect failure.
                    }
                }
                if (command != null) {
                    payload = executeCommand(executionId, command, deadlineElapsedMs, timeoutMs, maxOutputBytes);
                }
                output.write(payload.getBytes(StandardCharsets.UTF_8));
                output.flush();
            } catch (IOException ignored) {
                // The companion may close the read side after local STOP. The
                // execution itself is cancelled independently through cancel().
            }
        });
        return pipe[0];
    }

    @Override
    public void cancel(String executionId) {
        if (executionId == null || executionId.isBlank()) return;
        prunePendingCancellations();
        RunningExecution execution = active.get(executionId);
        if (execution == null) {
            cancelledBeforeStart.put(executionId, SystemClock.elapsedRealtime());
            return;
        }
        execution.cancel();
    }

    private String executeCommand(String executionId, String command, long deadlineElapsedMs,
                                  long timeoutMs, int maxOutputBytes) {
        prunePendingCancellations();
        if (cancelledBeforeStart.remove(executionId) != null) {
            return error("shell_cancelled_before_start", "cancelled_before_process_start");
        }
        if (deadlineElapsedMs <= SystemClock.elapsedRealtime()) {
            return error("shell_expired_before_start", "deadline_elapsed_before_process_start");
        }

        int wireBudget = Math.max(1, maxOutputBytes);
        CaptureBudget captureBudget = new CaptureBudget(wireBudget);
        ExecutorService readers = Executors.newFixedThreadPool(2, runnable -> {
            Thread thread = new Thread(runnable, "rcmcp-shell-stream");
            thread.setDaemon(true);
            return thread;
        });
        RunningExecution execution = new RunningExecution(executionId);
        RunningExecution existing = active.putIfAbsent(executionId, execution);
        if (existing != null) {
            readers.shutdownNow();
            return error("shell_execution_conflict", "execution_id_already_active");
        }

        try {
            if (cancelledBeforeStart.remove(executionId) != null || execution.cancelled()) {
                return error("shell_cancelled_before_start", "cancelled_before_process_start");
            }
            if (deadlineElapsedMs <= SystemClock.elapsedRealtime()) {
                return error("shell_expired_before_start", "deadline_elapsed_before_process_start");
            }

            ProcessBuilder builder = new ProcessBuilder(
                    "/system/bin/sh", "-c",
                    "printf '%s\\n' \"$$\"; IFS= read -r _ || exit 125; exec /system/bin/sh -c \"$1\"",
                    "rcmcp-shell", command);
            builder.environment().put(EXECUTION_MARKER, executionId);
            java.lang.Process process = builder.start();
            execution.attachWrapper(process);
            InputStream stdoutStream = process.getInputStream();
            int rootPid = readPidHandshake(stdoutStream);
            execution.attach(process, rootPid);

            if (execution.cancelled()) {
                execution.terminate();
                return error("shell_cancelled_before_start", "cancelled_before_process_start");
            }
            if (deadlineElapsedMs <= SystemClock.elapsedRealtime()) {
                execution.cancel();
                return error("shell_expired_before_start", "deadline_elapsed_before_process_start");
            }

            // Release the wrapper only after the execution is registered and
            // cancellation/deadline admission has been rechecked. From this
            // byte onward the owner command may have effects.
            try (OutputStream gate = process.getOutputStream()) {
                gate.write('\n');
                gate.flush();
            }

            Future<Capture> stdoutFuture = readers.submit(() -> readBounded(stdoutStream, captureBudget));
            Future<Capture> stderrFuture = readers.submit(() -> readBounded(process.getErrorStream(), captureBudget));

            long now = SystemClock.elapsedRealtime();
            long remainingDeadline = Math.max(0L, deadlineElapsedMs - now);
            long allowed = timeoutMs <= 0 ? remainingDeadline : Math.min(timeoutMs, remainingDeadline);
            boolean completed = allowed > 0 && process.waitFor(allowed, TimeUnit.MILLISECONDS);
            boolean cancelled = execution.cancelled();
            boolean timedOut = !completed && !cancelled;

            Termination termination = Termination.notRequired();
            if (!completed) termination = execution.terminate();

            Capture stdout = getCapture(stdoutFuture);
            Capture stderr = getCapture(stderrFuture);
            Integer code = completed ? process.exitValue() : null;
            return resultJson(code, stdout, stderr, timedOut, cancelled, termination, wireBudget);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            Termination termination = execution.terminate();
            return interruptedResult(termination, wireBudget);
        } catch (IOException | RuntimeException failure) {
            execution.terminate();
            return error("exec_failed", failure.getClass().getSimpleName() + ":" + String.valueOf(failure.getMessage()));
        } finally {
            active.remove(executionId, execution);
            cancelledBeforeStart.remove(executionId);
            readers.shutdownNow();
        }
    }

    private static String readCommand(InputStream input, int expectedBytes) throws IOException {
        if (expectedBytes <= 0 || expectedBytes > MAX_COMMAND_BYTES) {
            throw new IOException("shell_command_size_invalid");
        }
        byte[] command = new byte[expectedBytes];
        int offset = 0;
        while (offset < expectedBytes) {
            int read = input.read(command, offset, expectedBytes - offset);
            if (read < 0) throw new IOException("shell_command_stream_truncated");
            offset += read;
        }
        if (input.read() != -1) throw new IOException("shell_command_stream_overflow");
        return new String(command, StandardCharsets.UTF_8);
    }

    private static int readPidHandshake(InputStream input) throws IOException {
        StringBuilder digits = new StringBuilder(16);
        while (digits.length() < 16) {
            int value = input.read();
            if (value == -1) throw new IOException("shell_pid_handshake_eof");
            if (value == '\n') break;
            if (value < '0' || value > '9') throw new IOException("shell_pid_handshake_invalid");
            digits.append((char) value);
        }
        if (digits.length() == 0) throw new IOException("shell_pid_handshake_empty");
        try {
            return Integer.parseInt(digits.toString());
        } catch (NumberFormatException invalid) {
            throw new IOException("shell_pid_handshake_invalid", invalid);
        }
    }

    private static Capture getCapture(Future<Capture> future) throws InterruptedException {
        try {
            return future.get(3, TimeUnit.SECONDS);
        } catch (ExecutionException | TimeoutException failure) {
            future.cancel(true);
            return new Capture("", true);
        }
    }

    private static Capture readBounded(InputStream input, CaptureBudget budget) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(64 * 1024);
        byte[] buffer = new byte[8192];
        int read;
        boolean truncated = false;
        while ((read = input.read(buffer)) != -1) {
            int accepted = budget.claim(read);
            if (accepted > 0) output.write(buffer, 0, accepted);
            if (accepted < read) truncated = true;
        }
        return new Capture(new String(output.toByteArray(), StandardCharsets.UTF_8), truncated);
    }

    private static String resultJson(Integer code, Capture stdout, Capture stderr, boolean timedOut,
                                     boolean cancelled, Termination termination, int wireBudget) {
        String out = stdout.text;
        String err = stderr.text;
        boolean outTruncated = stdout.truncated;
        boolean errTruncated = stderr.truncated;
        while (true) {
            try {
                JSONObject result = new JSONObject()
                        .put("code", code == null ? JSONObject.NULL : code)
                        .put("stdout", out)
                        .put("stderr", err)
                        .put("stdoutTruncated", outTruncated)
                        .put("stderrTruncated", errTruncated)
                        .put("timedOut", timedOut)
                        .put("cancelled", cancelled)
                        .put("uid", Process.myUid());
                if (termination.required) {
                    result.put("terminationVerified", termination.verified)
                            .put("terminationForced", termination.forced);
                }
                String serialized = result.toString();
                if (serialized.getBytes(StandardCharsets.UTF_8).length <= wireBudget) return serialized;

                if (out.isEmpty() && err.isEmpty()) {
                    return error("shell_output_budget_too_small", "shell_result_metadata_exceeds_output_budget");
                }
                if (out.length() >= err.length() && !out.isEmpty()) {
                    out = out.substring(0, out.length() / 2);
                    outTruncated = true;
                } else {
                    err = err.substring(0, err.length() / 2);
                    errTruncated = true;
                }
            } catch (JSONException impossible) {
                return "{\"error\":\"exec_failed\"}";
            }
        }
    }

    private static String interruptedResult(Termination termination, int wireBudget) {
        try {
            JSONObject result = new JSONObject()
                    .put("code", JSONObject.NULL)
                    .put("stdout", "")
                    .put("stderr", "")
                    .put("stdoutTruncated", false)
                    .put("stderrTruncated", false)
                    .put("timedOut", false)
                    .put("cancelled", true)
                    .put("terminationVerified", termination.verified)
                    .put("terminationForced", termination.forced)
                    .put("uid", Process.myUid());
            String serialized = result.toString();
            if (serialized.getBytes(StandardCharsets.UTF_8).length <= wireBudget) return serialized;
        } catch (JSONException ignored) {}
        return error("interrupted", "shell_execution_interrupted");
    }

    private static String error(String code, String message) {
        try {
            return new JSONObject()
                    .put("error", code)
                    .put("message", message)
                    .put("uid", Process.myUid())
                    .toString();
        } catch (JSONException impossible) {
            return "{\"error\":\"exec_failed\"}";
        }
    }

    private void prunePendingCancellations() {
        long cutoff = SystemClock.elapsedRealtime() - PRESTART_CANCEL_TTL_MS;
        cancelledBeforeStart.entrySet().removeIf(entry -> entry.getValue() < cutoff);
    }

    private static Set<Integer> descendantPids(int rootPid) {
        File proc = new File("/proc");
        File[] entries = proc.listFiles();
        if (entries == null) return Set.of();
        Map<Integer, Integer> parents = new HashMap<>();
        for (File entry : entries) {
            String name = entry.getName();
            if (!name.chars().allMatch(Character::isDigit)) continue;
            try {
                int pid = Integer.parseInt(name);
                String stat;
                try (BufferedReader reader = new BufferedReader(new FileReader(new File(entry, "stat")))) {
                    stat = reader.readLine();
                }
                if (stat == null) continue;
                int end = stat.lastIndexOf(')');
                if (end < 0 || end + 2 >= stat.length()) continue;
                String[] fields = stat.substring(end + 2).trim().split("\\s+");
                if (fields.length < 2) continue;
                parents.put(pid, Integer.parseInt(fields[1]));
            } catch (IOException | NumberFormatException ignored) {}
        }

        Set<Integer> descendants = new HashSet<>();
        boolean changed;
        do {
            changed = false;
            for (Map.Entry<Integer, Integer> entry : parents.entrySet()) {
                int parent = entry.getValue();
                if ((parent == rootPid || descendants.contains(parent)) && descendants.add(entry.getKey())) {
                    changed = true;
                }
            }
        } while (changed);
        descendants.remove(rootPid);
        return descendants;
    }

    private static Set<Integer> executionPids(String executionId) {
        File proc = new File("/proc");
        File[] entries = proc.listFiles();
        if (entries == null) return Set.of();
        byte[] marker = (EXECUTION_MARKER + "=" + executionId + "\0").getBytes(StandardCharsets.UTF_8);
        Set<Integer> matches = new HashSet<>();
        for (File entry : entries) {
            String name = entry.getName();
            if (!name.chars().allMatch(Character::isDigit)) continue;
            try {
                int pid = Integer.parseInt(name);
                File environmentFile = new File(entry, "environ");
                if (environmentFile.length() > 1024 * 1024) continue;
                byte[] environment = Files.readAllBytes(environmentFile.toPath());
                if (containsBytes(environment, marker)) matches.add(pid);
            } catch (IOException | NumberFormatException | SecurityException ignored) {}
        }
        return matches;
    }

    private static boolean containsBytes(byte[] haystack, byte[] needle) {
        if (needle.length == 0 || haystack.length < needle.length) return false;
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) continue outer;
            }
            return true;
        }
        return false;
    }

    private static void signal(int pid, int signal) {
        try {
            Os.kill(pid, signal);
        } catch (ErrnoException ignored) {}
    }

    private static boolean alive(int pid) {
        return new File("/proc/" + pid).exists();
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static Termination terminateWrapper(java.lang.Process process) {
        process.destroy();
        try {
            if (process.waitFor(100, TimeUnit.MILLISECONDS)) return new Termination(true, true, false);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        process.destroyForcibly();
        try {
            process.waitFor(500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        return new Termination(true, !process.isAlive(), true);
    }

    private static Termination terminateTree(java.lang.Process process, int rootPid, String executionId) {
        Set<Integer> known = new HashSet<>();
        known.add(rootPid);

        // Freeze the tree before termination so descendants cannot keep
        // forking while we enumerate it. Repeat until the discovered set is
        // stable, then deliver TERM to every known member before resuming it.
        for (int round = 0; round < 6; round++) {
            int before = known.size();
            known.addAll(descendantPids(rootPid));
            known.addAll(executionPids(executionId));
            for (int pid : known) if (alive(pid)) signal(pid, OsConstants.SIGSTOP);
            if (known.size() == before) break;
            sleep(20L);
        }

        List<Integer> order = new ArrayList<>(known);
        order.sort(Comparator.reverseOrder());
        for (int pid : order) if (alive(pid)) signal(pid, OsConstants.SIGTERM);
        for (int pid : order) if (alive(pid)) signal(pid, OsConstants.SIGCONT);

        long gracefulUntil = SystemClock.elapsedRealtime() + 500L;
        while (SystemClock.elapsedRealtime() < gracefulUntil && order.stream().anyMatch(ShellUserService::alive)) {
            sleep(25L);
        }

        boolean forced = order.stream().anyMatch(ShellUserService::alive);
        if (forced) {
            for (int pid : order) if (alive(pid)) signal(pid, OsConstants.SIGKILL);
        }

        long verifyUntil = SystemClock.elapsedRealtime() + 2_000L;
        while (SystemClock.elapsedRealtime() < verifyUntil && order.stream().anyMatch(ShellUserService::alive)) {
            sleep(25L);
        }
        // Best-effort marker sweep catches detached/reparented descendants that
        // inherited this execution identity. Unrestricted shell commands can,
        // however, exec with a scrubbed environment or create containment that
        // is not visible from this process. Without a kernel-enforced cgroup or
        // PID namespace, disappearance of discoverable PIDs is not proof that
        // every possible escaped descendant is gone. Never claim full-tree
        // verification for a started owner shell command.
        for (int round = 0; round < 3; round++) {
            Set<Integer> late = executionPids(executionId);
            late.removeAll(known);
            if (late.isEmpty()) break;
            known.addAll(late);
            for (int pid : late) if (alive(pid)) signal(pid, OsConstants.SIGKILL);
            sleep(25L);
        }
        try {
            process.waitFor(100, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        return new Termination(true, false, forced);
    }

    @Override
    public boolean onTransact(int code, android.os.Parcel data, android.os.Parcel reply, int flags)
            throws android.os.RemoteException {
        if (code == DESTROY_TRANSACTION) {
            for (RunningExecution execution : active.values()) execution.cancel();
            workers.shutdownNow();
            System.exit(0);
            return true;
        }
        return super.onTransact(code, data, reply, flags);
    }

    private record Capture(String text, boolean truncated) {}

    private static final class CaptureBudget {
        private int remaining;
        CaptureBudget(int maxBytes) { remaining = Math.max(0, maxBytes); }
        synchronized int claim(int requested) {
            int accepted = Math.min(Math.max(0, requested), remaining);
            remaining -= accepted;
            return accepted;
        }
    }

    private static final class RunningExecution {
        final String id;
        private volatile boolean cancelled;
        private volatile java.lang.Process process;
        private volatile int rootPid = -1;
        private Termination termination;

        RunningExecution(String id) { this.id = id; }

        synchronized void attachWrapper(java.lang.Process process) {
            this.process = process;
            if (cancelled && termination == null) termination = terminateWrapper(process);
        }

        synchronized void attach(java.lang.Process process, int rootPid) {
            this.process = process;
            this.rootPid = rootPid;
            if (cancelled && termination == null) termination = terminateTree(process, rootPid, id);
        }

        boolean cancelled() { return cancelled; }

        synchronized void cancel() {
            cancelled = true;
            if (process == null || termination != null) return;
            termination = rootPid > 0 ? terminateTree(process, rootPid, id) : terminateWrapper(process);
        }

        synchronized Termination terminate() {
            if (termination == null && process != null) {
                termination = rootPid > 0 ? terminateTree(process, rootPid, id) : terminateWrapper(process);
            }
            return termination == null ? Termination.notRequired() : termination;
        }
    }

    private record Termination(boolean required, boolean verified, boolean forced) {
        static Termination notRequired() { return new Termination(false, true, false); }
    }
}
