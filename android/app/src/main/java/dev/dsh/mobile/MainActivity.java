package dev.dsh.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;

/**
 * The app surface: a WebView pointed at the on-device engine, plus a boot screen
 * shown while the engine starts.
 *
 * <p>The WebView is configured around one assumption: it talks to exactly one
 * origin, {@code http://127.0.0.1:<port>}, and nothing else. Local file access is
 * off and navigation is pinned to the loopback authority, because the agent
 * generates HTML that gets rendered here -- a model-authored page must not be
 * able to read local files or navigate the shell somewhere else.
 *
 * <p>The engine authenticates the browser with a per-process launch token: the
 * activity loads {@code /?token=...} once, the engine exchanges it for an
 * HttpOnly, SameSite=Strict cookie and redirects to {@code /}, and every
 * subsequent request and WebSocket carries that cookie.
 */
public class MainActivity extends Activity {

    private static final String TAG = "DshMainActivity";

    private static final long POLL_INTERVAL_MS = 400L;

    private FrameLayout root;
    private WebView webView;
    private LinearLayout bootOverlay;
    private TextView bootTitle;
    private TextView bootDetail;
    private TextView bootLog;
    private Button retryButton;
    private Button copyButton;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean webViewLoaded;
    private boolean started;
    /** When the boot screen first appeared, for the stall hint. */
    private final long bootStartedAt = System.currentTimeMillis();
    /** How long to wait before saying this looks stuck rather than merely slow. */
    private static final long STALL_HINT_MS = 150_000L;

    /**
     * Engine state as published by {@link EngineService}.
     *
     * <p>Read from a file, not from {@code EngineService.LocalState}: the service
     * lives in the {@code :engine} process, so its statics are a different
     * instance from anything this activity can see. An earlier version polled
     * that in-memory state directly, which meant the activity waited forever for
     * a URL written in another process while the engine ran perfectly.
     */
    private static final class EngineState {
        String status = "idle";
        String url;
        String error;
    }

    private EngineState readEngineState() {
        EngineState state = new EngineState();
        File file = new File(getFilesDir(), "engine-state.txt");
        if (!file.isFile()) {
            return state;
        }
        try {
            java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(new java.io.FileInputStream(file), "UTF-8"));
            try {
                String line;
                while ((line = reader.readLine()) != null) {
                    int at = line.indexOf('=');
                    if (at <= 0) {
                        continue;
                    }
                    String key = line.substring(0, at);
                    String value = unescape(line.substring(at + 1));
                    if ("status".equals(key)) {
                        state.status = value;
                    } else if ("url".equals(key)) {
                        state.url = value.isEmpty() ? null : value;
                    } else if ("error".equals(key)) {
                        state.error = value.isEmpty() ? null : value;
                    }
                }
            } finally {
                reader.close();
            }
        } catch (java.io.IOException failure) {
            Log.w(TAG, "could not read engine state: " + failure.getMessage());
        }
        return state;
    }

    /** Inverse of the service's field escaping. */
    private static String unescape(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c != '\\' || i + 1 >= value.length()) {
                out.append(c);
                continue;
            }
            char next = value.charAt(++i);
            switch (next) {
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'u':
                    if (i + 4 < value.length()) {
                        try {
                            out.append((char) Integer.parseInt(value.substring(i + 1, i + 5), 16));
                            i += 4;
                        } catch (NumberFormatException malformed) {
                            out.append(next);
                        }
                    }
                    break;
                default: out.append(next);
            }
        }
        return out.toString();
    }

    // Anonymous classes rather than lambdas: javac runs with android.jar as
    // -bootclasspath (which is what keeps Android API discipline), and that
    // hides java.lang.invoke, so LambdaMetafactory cannot be resolved.
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            renderEngineState();
            handler.postDelayed(this, POLL_INTERVAL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();

        // Prune the WebView's cache directory: an engine upgrade can leave stale
        // bundles behind, and the GUI is fully served from loopback anyway.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                WebView.setWebContentsDebuggingEnabled(true);
            }
        } catch (Throwable ignored) {
            // Debugging hooks are optional.
        }

        startEngineIfNeeded();
        handler.post(poll);
        maybeShowBootState();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(poll);
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ---- UI ------------------------------------------------------------------

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(getColorCompat(R.color.boot_background));

        webView = new WebView(this);
        webView.setVisibility(View.GONE);
        webView.setBackgroundColor(getColorCompat(R.color.boot_background));
        configureWebView(webView);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        bootOverlay = new LinearLayout(this);
        bootOverlay.setOrientation(LinearLayout.VERTICAL);
        bootOverlay.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = dp(28);
        bootOverlay.setPadding(pad, dp(72), pad, pad);

        bootTitle = new TextView(this);
        bootTitle.setText(R.string.boot_title);
        bootTitle.setTextColor(getColorCompat(R.color.boot_text));
        bootTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f);
        bootTitle.setGravity(Gravity.CENTER);
        bootOverlay.addView(bootTitle);

        bootDetail = new TextView(this);
        bootDetail.setText(R.string.boot_preparing);
        bootDetail.setTextColor(getColorCompat(R.color.boot_muted));
        bootDetail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
        bootDetail.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        detailParams.topMargin = dp(12);
        bootOverlay.addView(bootDetail, detailParams);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams buttonsParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonsParams.topMargin = dp(20);

        retryButton = new Button(this);
        retryButton.setText(R.string.retry);
        retryButton.setVisibility(View.GONE);
        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                startEngineIfNeeded();
                maybeShowBootState();
            }
        });
        buttons.addView(retryButton);

        copyButton = new Button(this);
        copyButton.setText(R.string.copy_diagnostics);
        copyButton.setVisibility(View.GONE);
        copyButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                copyDiagnostics();
            }
        });
        buttons.addView(copyButton);
        bootOverlay.addView(buttons, buttonsParams);

        ScrollView scroller = new ScrollView(this);
        bootLog = new TextView(this);
        bootLog.setTextColor(getColorCompat(R.color.boot_muted));
        bootLog.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        bootLog.setTypeface(android.graphics.Typeface.MONOSPACE);
        scroller.addView(bootLog);
        LinearLayout.LayoutParams scrollerParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        scrollerParams.topMargin = dp(20);
        bootOverlay.addView(scroller, scrollerParams);

        root.addView(bootOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // The loopback engine serves plain HTTP, so mixed content has to be
        // allowed for the WS/RPC carriers; nothing leaves the device.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // Tighten the surface: the agent authors HTML that renders here.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setGeolocationEnabled(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, false);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView webView, String url, android.graphics.Bitmap favicon) {
                // Runs before the document's own scripts, so the polyfills are in
                // place for the app bundle and for every lazily loaded plugin
                // bundle. See WebViewPolyfills for why they are needed at all.
                webView.evaluateJavascript(WebViewPolyfills.SOURCE, null);
                // The viewport meta must request cover or the platform safe-area
                // insets are not honoured and content renders under the camera.
                webView.evaluateJavascript(WebViewPolyfills.VIEWPORT_FIT, null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView ignored, String url) {
                return handleNavigation(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView ignored, String url) {
                showWebView();
            }

            @Override
            public void onReceivedError(WebView ignored, WebResourceRequest request, android.webkit.WebResourceError error) {
                // A load that fails (typically the engine restarted and the port
                // moved) must not strand the user on the browser error page: fall
                // back to the boot screen, which keeps polling and will load the
                // engine again once it publishes a fresh URL.
                if (request != null && request.isForMainFrame()) {
                    Log.w(TAG, "engine page load failed: " + error.getDescription()
                            + " (" + error.getErrorCode() + ")");
                    webViewLoaded = false;
                    if (webView != null) {
                        webView.setVisibility(View.GONE);
                    }
                    if (bootOverlay != null) {
                        bootOverlay.setVisibility(View.VISIBLE);
                        bootDetail.setText(R.string.boot_starting);
                        bootDetail.setTextColor(getColorCompat(R.color.boot_muted));
                        bootTitle.setText(R.string.boot_title);
                        retryButton.setVisibility(View.GONE);
                        copyButton.setVisibility(View.GONE);
                    }
                }
            }
        });
    }

    /**
     * Keep loopback navigation inside the WebView and hand everything else to the
     * system browser, so the shell cannot be navigated off-origin.
     */
    private boolean handleNavigation(Uri uri) {
        String scheme = uri.getScheme();
        String host = uri.getHost();
        boolean loopback = "http".equals(scheme)
                && ("127.0.0.1".equals(host) || "localhost".equals(host));
        if (loopback) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException notFound) {
            Log.w(TAG, "no activity for " + uri);
        }
        return true;
    }

    // ---- engine wiring -------------------------------------------------------

    private void startEngineIfNeeded() {
        started = true;
        EngineService.start(this);
    }

    private void maybeShowBootState() {
        renderEngineState();
    }

    private void renderEngineState() {
        EngineState state = readEngineState();

        // Only a "running" record carries a URL that is known to be alive. An
        // intermediate record can briefly hold a URL while the engine is already
        // dying -- the engine prints its URL and can then exit (a failed plugin
        // row), and loading that URL produces ERR_CONNECTION_REFUSED instead of
        // the boot progress the user should see.
        if ("running".equals(state.status) && state.url != null && !webViewLoaded) {
            loadEngineUrl(state.url);
            return;
        }
        if (webViewLoaded) {
            return;
        }

        if ("preparing".equals(state.status)) {
            bootDetail.setText(R.string.boot_preparing);
            bootLog.setText(tailLines(readBootLog(), 8));
        } else if ("starting".equals(state.status)) {
            bootDetail.setText(R.string.boot_starting);
            String log = readBootLog();
            bootLog.setText(tailLines(log, 15));
            // A stall and slow progress look identical on a static screen. After a
            // while, say so and show where it stopped -- this is the information
            // that previously required connecting a cable.
            if (System.currentTimeMillis() - bootStartedAt > STALL_HINT_MS) {
                bootTitle.setText(R.string.boot_stalled_title);
                bootDetail.setText(getString(R.string.boot_stalled_detail,
                        (System.currentTimeMillis() - bootStartedAt) / 1000));
                copyButton.setVisibility(View.VISIBLE);
            }
        } else if ("stopped".equals(state.status) || "failed".equals(state.status) || state.error != null) {
            // Distinguishing "still starting" from "started and then died" is the
            // single most useful signal when there are no logs to hand: the first
            // means the engine never became ready, the second means it was ready
            // and something killed it afterwards. Both used to render as the same
            // motionless boot screen.
            bootTitle.setText(R.string.boot_failed_title);
            bootDetail.setTextColor(getColorCompat(R.color.boot_error));
            bootDetail.setText(state.error == null ? "the engine stopped unexpectedly" : state.error);
            String diagnostics = readFailureDiagnostics();
            bootLog.setText(diagnostics.isEmpty() ? tailLines(readBootLog(), 30) : diagnostics);
            retryButton.setVisibility(View.VISIBLE);
            copyButton.setVisibility(View.VISIBLE);
        }
    }

    /**
     * The service mirrors every engine output line here, so the boot screen can
     * show what is actually happening instead of only a spinner.
     */
    private String readBootLog() {
        File file = new File(getFilesDir(), EngineService.BOOT_LOG_FILE);
        if (!file.isFile()) {
            return "";
        }
        try {
            byte[] buffer = new byte[(int) Math.min(file.length(), 64_000L)];
            java.io.FileInputStream in = new java.io.FileInputStream(file);
            try {
                int read = in.read(buffer);
                return read <= 0 ? "" : new String(buffer, 0, read, "UTF-8");
            } finally {
                in.close();
            }
        } catch (java.io.IOException failure) {
            return "";
        }
    }

    /** Last {@code count} lines of a text block, for a small on-screen log view. */
    private static String tailLines(String text, int count) {
        if (text == null || text.isEmpty()) {
            return "";
        }
        String[] lines = text.split("\n");
        int from = Math.max(0, lines.length - count);
        StringBuilder out = new StringBuilder();
        for (int i = from; i < lines.length; i++) {
            out.append(lines[i]).append('\n');
        }
        return out.toString();
    }

    /** The service writes the complete boot failure here (app-private storage). */
    private String readFailureDiagnostics() {
        File file = new File(getFilesDir(), "engine-boot-failure.log");
        if (!file.isFile()) {
            return "";
        }
        try {
            byte[] buffer = new byte[(int) Math.min(file.length(), 200_000L)];
            java.io.FileInputStream in = new java.io.FileInputStream(file);
            try {
                int read = in.read(buffer);
                return read <= 0 ? "" : new String(buffer, 0, read, "UTF-8");
            } finally {
                in.close();
            }
        } catch (java.io.IOException failure) {
            return "";
        }
    }

    private void loadEngineUrl(String url) {
        if (webViewLoaded) {
            return;
        }
        webViewLoaded = true;
        Log.i(TAG, "loading engine url: " + url);
        webView.loadUrl(url);
    }

    private void showWebView() {
        if (webView == null) {
            return;
        }
        webView.setVisibility(View.VISIBLE);
        bootOverlay.setVisibility(View.GONE);
    }

    private void copyDiagnostics() {
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard == null) {
            return;
        }
        EngineState state = readEngineState();
        String text = "status=" + state.status
                + "\nurl=" + state.url
                + "\nerror=" + state.error
                + "\n\n" + readFailureDiagnostics();
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("DSH diagnostics", text));
        copyButton.setText("Copied");
    }

    // ---- misc ----------------------------------------------------------------

    @Override
    public void onBackPressed() {
        if (webView != null && webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private int getColorCompat(int resId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return getColor(resId);
        }
        return getResources().getColor(resId);
    }
}
