package dev.dsh.mobile;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Owns the on-device Node runtime and the DSH engine process.
 *
 * <p>Two facts drive the shape of this class:
 *
 * <ul>
 *   <li>The engine is ESM and resolves {@code @deepseek-ai/*} through a real
 *       {@code node_modules} tree, but APK assets are not importable. So the
 *       packaged tree is unpacked once into app-private storage, versioned by a
 *       marker file so an app upgrade re-unpacks exactly once.
 *   <li>Android 10+ mounts app data directories {@code noexec}. The node binary
 *       therefore ships as {@code lib/arm64-v8a/libnode.so} -- the one location
 *       that is both extracted and executable -- and is launched from
 *       {@code nativeLibraryDir} directly. Nothing is copied into data storage
 *       to run, which is also why this keeps working on newer Android releases.
 * </ul>
 *
 * <p>The engine is started with {@code --port 0} so the OS assigns a free port;
 * the chosen port and the per-process launch token are recovered from the single
 * documented line the web app prints ({@code dsh web: http://127.0.0.1:<port>/?token=...}).
 */
final class EngineRuntime {

    private static final String TAG = "DshEngineRuntime";

    /** The documented startup line: "dsh web: <url>" with the token in the query. */
    private static final Pattern URL_LINE =
            Pattern.compile("dsh web:\\s*(http://127\\.0\\.0\\.1:(\\d+)/\\?token=[A-Za-z0-9_\\-]+)");

    private static final String ENGINE_ASSET_ROOT = "engine";
    private static final String ENGINE_DIR_NAME = "engine";
    private static final String HOME_DIR_NAME = "dsh-home";
    private static final String WORKSPACE_DIR_NAME = "workspace";
    /**
     * The packaged tree is a node_modules directory, and it must stay named that
     * way on disk: Node's ESM resolver only searches directories literally
     * called `node_modules`, walking up from the importing file.
     */
    private static final String NODE_MODULES = "node_modules";
    /**
     * Version marker shipped alongside the engine tree. Not dot-prefixed on
     * purpose: aapt2 drops hidden entries when packaging assets, so a
     * ".engine-version" would never arrive in the APK.
     */
    private static final String VERSION_MARKER = "ENGINE-VERSION";
    /**
     * The Android profile overlay, shipped as an asset and handed to the engine
     * as an absolute `--patch` path. It carries every platform difference
     * (permission policy pair, disabled desktop-only rows), which is what keeps
     * upstream packages untouched.
     */
    private static final String PROFILE_ASSET = ENGINE_ASSET_ROOT + "/android.patch.yml";
    private static final String PROFILE_FILE_NAME = "android.patch.yml";

    private EngineRuntime() {
    }

    /** Where the engine process and its files live. */
    static final class Paths {
        final File engineDir;
        final File homeDir;
        final File workspaceDir;
        final File tmpDir;
        final File nativeLibDir;
        final File nodeBinary;

        Paths(File engineDir, File homeDir, File workspaceDir, File tmpDir, File nativeLibDir, File nodeBinary) {
            this.engineDir = engineDir;
            this.homeDir = homeDir;
            this.workspaceDir = workspaceDir;
            this.tmpDir = tmpDir;
            this.nativeLibDir = nativeLibDir;
            this.nodeBinary = nodeBinary;
        }
    }

    static Paths resolvePaths(Context context) {
        File files = context.getFilesDir();
        File nativeLib = new File(context.getApplicationInfo().nativeLibraryDir);
        return new Paths(
                new File(files, ENGINE_DIR_NAME),
                new File(files, HOME_DIR_NAME),
                new File(files, WORKSPACE_DIR_NAME),
                new File(context.getCacheDir(), "tmp"),
                nativeLib,
                new File(nativeLib, "libnode.so"));
    }

    /**
     * Create every directory the engine expects to already exist.
     *
     * <p>These are separate from the asset unpack step because they must exist on
     * every launch, not only after an upgrade. {@code tmpDir} in particular is not
     * optional: the engine's spill store calls {@code mkdtemp} inside TMPDIR
     * during plugin-tree boot, and a missing TMPDIR fails the whole tree with
     * ENOENT rather than degrading.
     */
    static void ensureRuntimeDirectories(Paths paths) throws IOException {
        for (File dir : new File[]{paths.homeDir, paths.workspaceDir, paths.tmpDir}) {
            if (!dir.isDirectory() && !dir.mkdirs()) {
                throw new IOException("cannot create " + dir);
            }
        }
    }

    /**
     * Unpack the packaged engine tree when the marker does not match the version
     * shipped in this APK. Returns true when work was performed.
     */
    static boolean ensureEngineUnpacked(Context context, Paths paths, Progress progress) throws IOException {
        String packaged = readAssetText(context, ENGINE_ASSET_ROOT + "/" + NODE_MODULES + "/" + VERSION_MARKER).trim();
        File marker = new File(new File(paths.engineDir, NODE_MODULES), VERSION_MARKER);
        if (marker.isFile()) {
            String installed = readFileText(marker).trim();
            if (installed.equals(packaged)) {
                Log.i(TAG, "engine tree already unpacked (version " + installed + ")");
                return false;
            }
            Log.i(TAG, "engine version changed " + installed + " -> " + packaged + ", re-unpacking");
        }

        // User data (sessions, credentials, settings) lives in homeDir, which is
        // deliberately outside engineDir so re-unpacking never touches it.
        deleteRecursively(paths.engineDir);
        if (!paths.engineDir.mkdirs() && !paths.engineDir.isDirectory()) {
            throw new IOException("cannot create " + paths.engineDir);
        }
        if (!paths.homeDir.mkdirs() && !paths.homeDir.isDirectory()) {
            throw new IOException("cannot create " + paths.homeDir);
        }
        if (!paths.workspaceDir.mkdirs() && !paths.workspaceDir.isDirectory()) {
            throw new IOException("cannot create " + paths.workspaceDir);
        }

        copyAssetTree(context, ENGINE_ASSET_ROOT, paths.engineDir, progress);
        writeFileText(marker, packaged);
        return true;
    }

    /**
     * Copy the project's own plugins into the profile's node_modules tree.
     *
     * <p>Two different trees resolve plugin names, and only one of them is the
     * engine's:
     *
     * <ul>
     *   <li>The engine entry ({@code engine/node_modules/.../bin.js}) resolves
     *       its own imports through the engine tree, which is why the engine
     *       assets already carry {@code @dsh-mobile/*}.</li>
     *   <li>The <b>loader</b> resolves a configured plugin row's package name
     *       relative to the profile directory, and its error text names that
     *       location exactly:
     *       {@code Cannot find package '@dsh-mobile/attachment-android' imported
     *       from .../dsh-home/profiles/web/}</li>
     * </ul>
     *
     * <p>On the desktop these coincide because pnpm links the profile's
     * node_modules to the install tree. The APK has no such link (assets cannot
     * carry symlinks), so the plugins are staged into the profile tree here.
     * Without this the engine aborts at boot with ERR_MODULE_NOT_FOUND, which is
     * one of the ways "stuck on starting the DSH engine" presents.
     */
    static void ensurePluginsInProfile(Context context, Paths paths) throws IOException {
        File pluginSource = new File(new File(paths.engineDir, NODE_MODULES), "@dsh-mobile");
        if (!pluginSource.isDirectory()) {
            Log.i(TAG, "no bundled @dsh-mobile plugins to stage");
            return;
        }
        // Both candidate roots: the loader's specifier base has moved between
        // versions, and a stray plugin directory in an unused root is inert.
        File[] targets = new File[]{
                new File(paths.homeDir, "profiles/node_modules/@dsh-mobile"),
                new File(paths.homeDir, "profiles/web/node_modules/@dsh-mobile"),
        };
        for (File target : targets) {
            if (!target.isDirectory() && !target.mkdirs()) {
                throw new IOException("cannot create " + target);
            }
            for (File plugin : pluginSource.listFiles()) {
                copyDirectory(plugin, new File(target, plugin.getName()));
            }
        }
        Log.i(TAG, "staged @dsh-mobile plugins into the profile tree");
    }

    /** Recursive copy used for the plugin directories (small, a few files each). */
    private static void copyDirectory(File source, File target) throws IOException {
        if (source.isDirectory()) {
            if (!target.isDirectory() && !target.mkdirs()) {
                throw new IOException("cannot create " + target);
            }
            File[] children = source.listFiles();
            if (children != null) {
                for (File child : children) {
                    copyDirectory(child, new File(target, child.getName()));
                }
            }
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("cannot create " + parent);
        }
        try (InputStream in = new FileInputStream(source);
             OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        }
    }

    /** A bare engine process plus its merged output, for the first boot log. */
    static final class Startup {
        final Process process;
        final StringBuilder log = new StringBuilder();
        /**
         * Written by the output-reading thread and polled by the caller, so the
         * two never block on each other. Volatile because they cross threads.
         */
        volatile String url;
        volatile int port = -1;
        volatile String token;

        Startup(Process process) {
            this.process = process;
        }
    }

    /**
     * Launch {@code dsh web} and wait until it prints its URL, the process exits,
     * or the timeout expires.
     *
     * <p>The wait must not be driven by blocking reads. An earlier version read
     * the merged output line by line on the calling thread and checked the
     * deadline inside that loop, which cannot fire while the process is alive but
     * quiet -- exactly the state a long plugin-tree boot leaves it in. The result
     * was an app that sat on "starting the engine" forever with no error and no
     * timeout. Now a reader thread owns the stream and the caller polls the
     * process plus a volatile URL field, so a silent engine times out properly.
     */
    static Startup startEngine(Context context, Paths paths, long timeoutMs, Progress progress) throws IOException {
        if (!paths.nodeBinary.isFile()) {
            throw new IOException("node runtime missing: " + paths.nodeBinary
                    + " (expected the APK's native library directory)");
        }

        File engineEntry = new File(new File(paths.engineDir, NODE_MODULES), "@deepseek-ai/dsh/lib/bin.js");
        if (!engineEntry.isFile()) {
            throw new IOException("engine entry missing: " + engineEntry);
        }

        // The profile overlay lives outside engineDir so re-unpacking the tree
        // (which deletes that directory) cannot take it with it.
        //
        // It is rewritten on EVERY launch rather than only when missing. The
        // first version of this code wrote it once, and during development the
        // device then kept using an obsolete patch -- the app and the APK
        // disagreed about the plugin tree while every log looked healthy. The
        // file is a few KB, so unconditional freshness is the cheap correct
        // choice; it also means editing the profile needs no other coordination.
        File profile = new File(context.getFilesDir(), PROFILE_FILE_NAME);
        try (InputStream in = context.getAssets().open(PROFILE_ASSET);
             OutputStream out = new FileOutputStream(profile)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        }

        List<String> command = new ArrayList<>();
        command.add(paths.nodeBinary.getAbsolutePath());
        // Must be a Node option, not an NODE_OPTIONS entry: Node rejects
        // --expose-internals from the environment outright ("not allowed in
        // NODE_OPTIONS") and exits 9 before running anything.
        //
        // @deepseek-ai/cordis-plugin-hmr requires it, and the engine
        // instantiates that service even though the composed tree marks its row
        // disabled. Without the flag the URL is printed and the process then
        // exits 1, so the app reaches "engine ready" and immediately loses the
        // engine -- which is exactly how "stuck on starting the DSH engine"
        // presents on a phone: the UI keeps polling a port that already died.
        //
        // HMR itself is inert here; it exists to reload client plugin bundles
        // when `pnpm run dev:web` rebuilds them, which never happens on device.
        command.add("--expose-internals");
        command.add(engineEntry.getAbsolutePath());
        command.add("--profile");
        command.add("web");
        command.add("--patch");
        command.add(profile.getAbsolutePath());
        command.add("--no-open");
        // Port 0: let the OS pick a free port. The actual value comes back in the
        // printed URL, which also avoids colliding with anything already bound.
        command.add("--port");
        command.add("0");

        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(paths.workspaceDir);
        // Merged because the engine logs diagnostics to stderr; a startup failure
        // is only legible when both streams are interleaved in order.
        builder.redirectErrorStream(true);

        java.util.Map<String, String> env = builder.environment();
        env.put("DSH_HOME", paths.homeDir.getAbsolutePath());
        env.put("HOME", context.getFilesDir().getAbsolutePath());
        env.put("TMPDIR", paths.tmpDir.getAbsolutePath());
        env.put("NODE_OPTIONS", "--max-old-space-size=2048");
        // Android has no /etc/ssl bundle path that Node finds on its own.
        env.put("SSL_CERT_DIR", "/system/etc/security/cacerts");
        // The native library directory holds every .so the runtime links against.
        // The executable's DT_RUNPATH is $ORIGIN, which resolves the direct
        // dependencies; LD_LIBRARY_PATH additionally covers transitive ones,
        // which the linker resolves without consulting the caller's RUNPATH.
        env.put("LD_LIBRARY_PATH", paths.nativeLibDir.getAbsolutePath());
        env.put("PATH", paths.nativeLibDir.getAbsolutePath() + ":/system/bin:/system/xbin");

        Log.i(TAG, "launching: " + command);
        Process process = builder.start();
        final Startup startup = new Startup(process);

        Thread reader = new Thread(new Runnable() {
            @Override
            public void run() {
                try (BufferedReader buffered = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = buffered.readLine()) != null) {
                        synchronized (startup.log) {
                            startup.log.append(line).append('\n');
                        }
                        Matcher matcher = URL_LINE.matcher(line);
                        if (matcher.find()) {
                            startup.url = matcher.group(1);
                            startup.port = Integer.parseInt(matcher.group(2));
                            startup.token = startup.url.substring(startup.url.indexOf("token=") + 6);
                        }
                        if (progress != null) {
                            progress.onLogLine(line);
                        }
                    }
                } catch (IOException ignored) {
                    // Stream closes when the process dies; the exit code is the
                    // interesting signal and is reported below.
                }
            }
        }, "dsh-engine-stdout");
        reader.setDaemon(true);
        reader.start();

        final long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (startup.url != null) {
                Log.i(TAG, "engine ready on port " + startup.port);
                return startup;
            }
            if (!process.isAlive()) {
                throw new IOException("engine exited during startup (code "
                        + process.exitValue() + "):\n" + tail(startup.log));
            }
            try {
                Thread.sleep(200L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                process.destroy();
                throw new IOException("interrupted while waiting for the engine");
            }
        }

        process.destroy();
        throw new IOException("engine did not report a URL within " + (timeoutMs / 1000) + "s:\n" + tail(startup.log));
    }

    // ---- helpers -------------------------------------------------------------

    interface Progress {
        void onLogLine(String line);
    }

    private static String tail(StringBuilder log) {
        String text = log.toString();
        int limit = 4000;
        return text.length() <= limit ? text : text.substring(text.length() - limit);
    }

    private static void copyAssetTree(Context context, String assetPath, File destDir, Progress progress)
            throws IOException {
        String[] children = context.getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            copyAssetFile(context, assetPath, destDir);
            return;
        }
        if (!destDir.mkdirs() && !destDir.isDirectory()) {
            throw new IOException("cannot create " + destDir);
        }
        for (String child : children) {
            String childAsset = assetPath + "/" + child;
            String[] grandChildren = context.getAssets().list(childAsset);
            if (grandChildren != null && grandChildren.length > 0) {
                copyAssetTree(context, childAsset, new File(destDir, child), progress);
            } else {
                copyAssetFile(context, childAsset, new File(destDir, child));
            }
        }
    }

    private static void copyAssetFile(Context context, String assetPath, File dest) throws IOException {
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("cannot create " + parent);
        }
        try (InputStream in = context.getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(dest)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        }
    }

    private static String readAssetText(Context context, String assetPath) throws IOException {
        try (InputStream in = context.getAssets().open(assetPath)) {
            byte[] buffer = new byte[Math.max(64, in.available())];
            int read = in.read(buffer);
            return read <= 0 ? "" : new String(buffer, 0, read, StandardCharsets.UTF_8);
        }
    }

    private static String readFileText(File file) throws IOException {
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[(int) Math.max(64, file.length())];
            int read = in.read(buffer);
            return read <= 0 ? "" : new String(buffer, 0, read, StandardCharsets.UTF_8);
        }
    }

    private static void writeFileText(File file, String text) throws IOException {
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    static void deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        if (!file.delete()) {
            Log.w(TAG, "could not delete " + file);
        }
    }
}
