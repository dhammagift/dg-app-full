package gift.dhamma.pali;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Collections;

/**
 * The dictionary as a Capacitor app.
 *
 * There is no bundled UI: capacitor.config.json points server.url at https://dict.dhamma.gift, so
 * the site IS the app's interface, exactly as it was under the Trusted Web Activity this replaces.
 * What changed is the container. A TWA runs inside Chrome's Custom Tab, which is why the owner's
 * two reports existed at all — "не работает стандалон" (a Custom Tab still shows Chrome's own
 * chrome and follows Chrome's display-mode, not the app's) and the burger panel "улетает" (the
 * bottom sheet is positioned against a viewport Chrome resizes as its URL bar hides and shows).
 * A WebView this app owns has neither problem.
 *
 * Everything this file adds is the part a web manifest cannot do: the bridge that puts app-only
 * rows into the site's burger menu (www/dict-bridge.js, injected below), and the launch routes
 * (App Shortcuts, shared text, selected text) that used to live in the TWA's LauncherActivity.
 */
public class MainActivity extends BridgeActivity {

    // The one origin the injected bridge may run on. Capacitor itself allows the same origin from
    // capacitor.config.json's server.url, but this script is ours and does not need to run
    // anywhere else — the reader pages under dhamma.gift are allowed navigation and must not get
    // dictionary-only rows.
    private static final String SITE_ORIGIN = "https://dict.dhamma.gift";
    private static final String SITE_ROOT = SITE_ORIGIN + "/";
    // Where `cap sync` puts the committed src/dict-bridge.js (see dict/build.js).
    private static final String BRIDGE_ASSET = "public/dict-bridge.js";

    // Guards against handling the same launch twice: BridgeActivity.load() — called from its
    // onCreate — ends with this.onNewIntent(getIntent()), so the launch intent already arrives
    // through the override below and no explicit call belongs in onCreate.
    private Intent handledIntent;

    // How long the animated splash mark is held on screen: its own length (see onCreate).
    private static final long SPLASH_HOLD_MS = 900;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate(): Capacitor collects registered plugins while the bridge is being
        // created. DgShortcuts pushes the lookup history into the launcher's long-press menu.
        registerPlugin(DgShortcutsPlugin.class);
        // The launch splash is the animated mark (res/drawable/dg_splash_icon.xml, 900 ms). The system takes the
        // splash down the moment the first frame is ready, which on a warm start is before the mark has drawn;
        // holding it for the length of the animation is what lets it play, and costs a cold start nothing it
        // was not going to spend loading anyway.
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        final long shownAt = SystemClock.uptimeMillis();
        splash.setKeepOnScreenCondition(() -> SystemClock.uptimeMillis() - shownAt < SPLASH_HOLD_MS);
        super.onCreate(savedInstanceState);

        injectBridge();
        // What the WebView shows before the site's first paint is the launch screen's own colour
        // (light/dark by the system theme), so native splash -> web splash has no gap.
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setBackgroundColor(getColor(R.color.dg_splash_bg));
            // No scrollbars, no overscroll glow: the WebView draws its own scroll indicator ABOVE the page
            // (and above the splash), which showed as a strip down the launch screen. The page is the app's
            // whole interface here, and a phone app has no scrollbars on it.
            WebView bare = getBridge().getWebView();
            bare.setVerticalScrollBarEnabled(false);
            bare.setHorizontalScrollBarEnabled(false);
            bare.setOverScrollMode(View.OVER_SCROLL_NEVER);
        }
        // Deliberately no handleIntent(getIntent()) here — see handledIntent above.
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Identity check, not equals(): two separate taps on the same shortcut produce
        // equal-but-distinct Intents and both must work.
        if (intent == handledIntent) return;
        handledIntent = intent;
        handleIntent(intent);
    }

    /**
     * Injects www/dict-bridge.js into the loaded site, plus the installed version as a global so
     * the "App version" row never has to ask the site (or the bridge) for something only the
     * package manager knows.
     *
     * Document-start injection is the supported path and runs before the page's own scripts, so
     * the rows are already in the burger panel the first time it opens. It needs a WebView with
     * DOCUMENT_START_SCRIPT (Chrome 105+); on anything older the listener below re-injects on every
     * page load instead, which is a little later but the same rows.
     */
    private void injectBridge() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final String script = "window.__DG_APP_VERSION__=" + JSONObject.quote(versionString()) + ";\n"
                + readAsset(BRIDGE_ASSET);
        WebView webView = getBridge().getWebView();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton(SITE_ORIGIN));
                return;
            } catch (IllegalArgumentException e) {
                // Falls through to the listener: an injection that cannot be registered must not
                // cost the reader the rows.
            }
        }
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                view.evaluateJavascript(script, null);
            }
        });
    }

    /** versionName (versionCode), the same string the site's own "App version" style uses. */
    private String versionString() {
        try {
            android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            return info.versionName + " (" + code + ")";
        } catch (Exception e) {
            return "";
        }
    }

    private String readAsset(String path) {
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(getAssets().open(path), "UTF-8"))) {
            String line;
            while ((line = reader.readLine()) != null) out.append(line).append('\n');
        } catch (Exception e) {
            // An unreadable bridge is not worth failing the launch over; the page simply gets the
            // version global and no extra rows.
            return "";
        }
        return out.toString();
    }

    /**
     * The three ways this activity can be launched with extra data, turned into a URL: a static or
     * dynamic App Shortcut's "route" extra (res/xml/shortcuts.xml, DgShortcutsPlugin), a shared
     * text (AndroidManifest.xml's ACTION_SEND filter) or a selected text (its PROCESS_TEXT filter).
     *
     * The text is handed over RAW as the site's ?q=, exactly as the TWA's LauncherActivity did and
     * as dg-app-full does: the site owns the cleaning, and a second copy of it in a wrapper is how
     * the two drift apart.
     */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String url = null;
        String route = intent.getStringExtra("route");
        if (route != null && !route.isEmpty()) {
            url = route.startsWith("http") ? route : SITE_ORIGIN + route;
        } else if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (shared != null && !shared.isEmpty()) url = SITE_ROOT + "?q=" + Uri.encode(shared);
        } else if (Intent.ACTION_PROCESS_TEXT.equals(intent.getAction())) {
            // getCharSequenceExtra, not getStringExtra: a selection arrives as a Spannable.
            CharSequence selected = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
            if (selected != null && selected.length() > 0) url = SITE_ROOT + "?q=" + Uri.encode(selected.toString());
        }
        if (url == null) return;

        final String finalUrl = url;
        final WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) webView.post(() -> webView.loadUrl(finalUrl));
    }
}
