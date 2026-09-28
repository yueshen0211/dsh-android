package dev.dsh.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Hosts the Node/DSH engine in its own process and keeps it alive while the app
 * is backgrounded.
 *
 * <p>The service is deliberately the single source of truth for engine state.
 * The UI binds to it and renders either the boot screen or the WebView depending
 * on {@link LocalState}, so a slow first launch (unpacking ~200 MB of engine
 * assets) shows progress instead of a blank window, and an engine crash surfaces
 * as a message with the captured log rather than a silent blank page.
 *
 * <p>State is published through a process-local singleton rather than Binder
 * callbacks: the UI and the service live in different processes, and the UI only
 * needs a one-shot "here is the URL" handoff plus a log tail for diagnostics.
 * {@link MainActivity} polls the singleton while the boot screen is visible,
 * which is simpler than marshalling callbacks across processes and keeps the
 * failure modes obvious.
 */
public class EngineService extends Service {

    private static final String TAG = "DshEngineService";

    public static final String ACTION_START = "dev.dsh.mobile.action.START_ENGINE";
    public static final String ACTION_STOP = "dev.dsh.mobile.action.STOP_ENGINE";

    private static final String CHANNEL_ID = "dsh-engine";
    private static final int NOTIFICATION_ID = 0x445348;

    /** First launch unpacks the engine tree; later launches only start Node. */
    private static final long STARTUP_TIMEOUT_MS = 180_000L;

    /** The engine URL plus the log tail, readable from the UI process. */
    public static final class LocalState {
        public static volatile String url;
        public static volatile String status = "idle";
        public static volatile String error;
        public static volatile String log = "";
        public static volatile boolean running;
    }

    /**
     * Cross-process handoff file.
     *
     * <p>{@link LocalState} cannot serve this purpose: the service runs in the
     * {@code :engine} process and the UI in the main one, so each has its own
     * copy of the statics. With only the in-memory state, the engine reported
     * its URL correctly while the UI kept showing "starting the DSH engine"
     * forever -- the activity was reading a field that was never written in its
     * own process.
     *
     * <p>A file in app-private storage is the simplest channel both processes
     * can share. The format is line-oriented and JSON-escaped so a URL
     * containing awkward characters survives, and so a truncated write is
     * detectable rather than silently delivering a half URL.
     */
    private static final String STATE_FILE = "engine-state.txt";

    private void publishState(String status, String url, String error) {
        LocalState.status = status;
        LocalState.url = url;
        LocalState.error = error;
        StringBuilder text = new StringBuilder();
        text.append("status=").append(jsonEscape(status)).append('\n');
        text.append("url=").append(jsonEscape(url == null ? "" : url)).append('\n');
        text.append("error=").append(jsonEscape(error == null ? "" : error)).append('\n');
        // Written via a temporary file and renamed, so a reader never observes a
        // partially written record.
        File target = new File(getFilesDir(), STATE_FILE);
        File temp = new File(getFilesDir(), STATE_FILE + ".tmp");
        try (OutputStream stream = new FileOutputStream(temp)) {
            stream.write(text.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException failure) {
            Log.w(TAG, "could not write engine state: " + failure.getMessage());
            return;
        }
        if (!temp.renameTo(target)) {
            Log.w(TAG, "could not publish engine state atomically");
        }
    }

    /** Minimal JSON string escaping, applied to every field value. */
    private static String jsonEscape(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }

    private Process process;
    private Thread worker;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopEngine();
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, buildNotification());
        if (worker == null || !worker.isAlive()) {
            // Anonymous classes rather than lambdas throughout this file:
            // javac runs with android.jar as -bootclasspath (which is what keeps
            // Android API discipline), and that hides java.lang.invoke, so
            // LambdaMetafactory cannot be resolved and lambdas do not compile.
            worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    bootEngine();
                }
            }, "dsh-engine-boot");
            worker.setDaemon(true);
            worker.start();
        }
        // Not sticky: a restart without the user present would re-run a large
        // unpack in the background for no one. The UI restarts it on next launch.
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopEngine();
        super.onDestroy();
    }

    private void bootEngine() {
        EngineRuntime.Paths paths = EngineRuntime.resolvePaths(this);
        try {
            // Clear the previous run's record before doing anything else. The
            // file outlives the process, so a stale entry would advertise a dead
            // port and token; the UI, polling it, would load that URL and show
            // ERR_CONNECTION_REFUSED instead of waiting for the new engine.
            //
            // Publishing "preparing" (rather than deleting) keeps the record
            // well-formed for every reader while removing the stale URL.
            publishState("preparing", null, null);
            appendLog("engine dir: " + paths.engineDir);
            appendLog("native lib dir: " + paths.nativeLibDir);

            // Must happen before the tree is unpacked: the spill store runs
            // mkdtemp inside TMPDIR while the plugin tree boots.
            EngineRuntime.ensureRuntimeDirectories(paths);

            EngineRuntime.Progress progress = new EngineRuntime.Progress() {
                @Override
                public void onLogLine(String line) {
                    appendLog(line);
                }
            };

            boolean unpacked = EngineRuntime.ensureEngineUnpacked(this, paths, progress);
            appendLog(unpacked ? "engine tree unpacked" : "engine tree already present");

            // The loader resolves plugin package names from the profile's
            // node_modules tree, not the engine's, so the bundled @dsh-mobile
            // plugins have to exist in both.
            EngineRuntime.ensurePluginsInProfile(this, paths);

            LocalState.status = "starting";
            EngineRuntime.Startup startup =
                    EngineRuntime.startEngine(this, paths, STARTUP_TIMEOUT_MS, progress);

            process = startup.process;
            LocalState.running = true;
            publishState("running", startup.url, null);
            appendLog("engine url: " + startup.url);
            drainOutput(startup.process);
        } catch (IOException | RuntimeException failure) {
            Log.e(TAG, "engine failed to start", failure);
            LocalState.running = false;
            publishState("failed", null, failure.getMessage());
            appendLog("FAILED: " + failure.getMessage());
            writeDiagnostics(paths, failure);
        }
    }

    /**
     * Keep consuming the engine's output for the lifetime of the process. Both
     * an unread pipe filling up (which would block the engine) and the exit
     * status are reasons this must run continuously.
     */
    private void drainOutput(Process running) {
        Thread reader = new Thread(new Runnable() {
            @Override
            public void run() {
                try (java.io.BufferedReader buffered = new java.io.BufferedReader(
                        new java.io.InputStreamReader(running.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = buffered.readLine()) != null) {
                        appendLog(line);
                    }
                } catch (IOException ignored) {
                    // Stream closes when the process dies; the exit code below is
                    // the interesting signal.
                }
                int code = -1;
                try {
                    code = running.waitFor();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                Log.w(TAG, "engine exited with code " + code);
                LocalState.running = false;
                publishState("stopped", null, "engine exited with code " + code);
                appendLog("engine exited with code " + code);
            }
        }, "dsh-engine-output");
        reader.setDaemon(true);
        reader.start();
    }

    private void stopEngine() {
        if (process != null && process.isAlive()) {
            process.destroy();
            try {
                if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }
        process = null;
        LocalState.running = false;
    }

    private void appendLog(String line) {
        Log.i(TAG, line);
        String current = LocalState.log;
        String next = current + line + '\n';
        // Bounded so a chatty engine cannot grow this without limit; the tail is
        // what matters for diagnosing a failure.
        LocalState.log = next.length() > 200_000 ? next.substring(next.length() - 200_000) : next;
    }

    /** Persist the boot log so a failure can be read without a debugger. */
    private void writeDiagnostics(EngineRuntime.Paths paths, Throwable failure) {
        File out = new File(getFilesDir(), "engine-boot-failure.log");
        try (OutputStream stream = new FileOutputStream(out)) {
            String text = "error: " + failure + "\n\n" + LocalState.log;
            stream.write(text.getBytes(StandardCharsets.UTF_8));
            Log.i(TAG, "wrote diagnostics to " + out);
        } catch (IOException ignored) {
            // Diagnostics are best-effort.
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.engine_channel_name),
                NotificationManager.IMPORTANCE_MIN);
        channel.setDescription(getString(R.string.engine_notification_text));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle(getString(R.string.engine_notification_title))
                .setContentText(getString(R.string.engine_notification_text))
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }

    static void start(Context context) {
        Intent intent = new Intent(context, EngineService.class);
        intent.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }
}
