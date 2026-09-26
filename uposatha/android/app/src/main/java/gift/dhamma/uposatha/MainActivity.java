package gift.dhamma.uposatha;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.WebViewListener;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Arrays;
import java.util.HashSet;

/**
 * The Uposatha calendar as a Capacitor app.
 *
 * The page is the site's own calendar page, bundled in the APK: www/ is a snapshot of it and of
 * everything it loads (uposatha/tools/snapshot.js, taken at build time), so the app opens with no network
 * at all. When the phone is online the bridge fetches what the site has changed since and DgSitePlugin
 * serves those files in place of the bundled ones. What this file adds is the part a web page cannot do:
 *
 *   - the bridge (www/uposatha-bridge.js, injected below): back button, the next Uposatha days as
 *     launcher shortcuts, the sound source, the rating sheet, the updater;
 *   - DgShortcuts, DgSound and DgSite, three plugins of this package (LocalNotifications, the reminders
 *     themselves, is an npm plugin and needs nothing here);
 *   - the launch routes of the App Shortcuts (res/xml/shortcuts.xml, DgShortcutsPlugin).
 */
public class MainActivity extends BridgeActivity {

    // The origin the injected bridge may run on: the app's own. The page it shows is bundled in the APK
    // (www/, a snapshot of the site's calendar page taken at build time) and served from here; links to the
    // site itself open in the browser.
    private static final HashSet<String> BRIDGE_ORIGINS = new HashSet<>(Arrays.asList("https://localhost"));
    // Where `cap sync` puts src/uposatha-bridge.js (see uposatha/build.js).
    private static final String BRIDGE_ASSET = "public/uposatha-bridge.js";

    // Guards against handling the same launch twice: BridgeActivity.load() — called from its
    // onCreate — ends with this.onNewIntent(getIntent()), so the launch intent already arrives
    // through the override below and no explicit call belongs in onCreate.
    private Intent handledIntent;

    // How long the animated splash mark is held on screen: its own length (1000 ms), so a warm start plays
    // the whole pass and is not made to wait any longer than that.
    private static final long SPLASH_HOLD_MS = 1000;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate(): Capacitor collects the registered plugins while the bridge is
        // being created.
        registerPlugin(DgShortcutsPlugin.class);
        registerPlugin(DgSoundPlugin.class);
        registerPlugin(DgSitePlugin.class);
        registerPlugin(DgAlarmPlugin.class);
        // The launch splash is the animated mark (res/drawable/dg_splash_icon.xml, 1000 ms). The system takes the
        // splash down the moment the first frame is ready, which on a warm start is before the mark has drawn;
        // holding it for the length of the animation is what lets it play, and costs a cold start nothing it
        // was not going to spend loading anyway.
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        final long shownAt = SystemClock.uptimeMillis();
        splash.setKeepOnScreenCondition(() -> SystemClock.uptimeMillis() - shownAt < SPLASH_HOLD_MS);
        super.onCreate(savedInstanceState);

        serveUpdatedFiles();
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
     * Files the page bridge has downloaded since the APK was built (DgSitePlugin) are served in place of
     * the bundled copy; everything else is Capacitor's own.
     */
    private void serveUpdatedFiles() {
        final Bridge bridge = getBridge();
        if (bridge == null) return;
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse updated = DgSitePlugin.serve(MainActivity.this, bridge, request);
                return updated != null ? updated : super.shouldInterceptRequest(view, request);
            }
        });
    }

    /**
     * Injects www/uposatha-bridge.js into the loaded site, plus the installed version as a global so
     * the "App version" row never has to ask the site for something only the package manager knows.
     * Document-start injection runs before the page's own scripts (Chrome 105+); on anything older
     * the listener below injects on every page load instead, a little later but the same.
     */
    private void injectBridge() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final String script = "window.__DG_APP_VERSION__=" + JSONObject.quote(versionString()) + ";\n"
                + readAsset(BRIDGE_ASSET);
        WebView webView = getBridge().getWebView();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                WebViewCompat.addDocumentStartJavaScript(webView, script, BRIDGE_ORIGINS);
                return;
            } catch (IllegalArgumentException e) {
                // Falls through to the listener: an injection that cannot be registered must not
                // cost the reader the bridge.
            }
        }
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                view.evaluateJavascript(script, null);
            }
        });
    }

    /** versionName (versionCode), the string the "App version" row shows. */
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
            // version global and none of the app-only extras.
            return "";
        }
        return out.toString();
    }

    /**
     * A shortcut's "route" extra (res/xml/shortcuts.xml statics, DgShortcutsPlugin's dynamics)
     * turned into a URL and loaded into the WebView. A route starting with "/" is on the app's own
     * (bundled) page; a full URL is used as it is.
     */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String route = intent.getStringExtra("route");
        if (route == null || route.isEmpty()) return;
        String url = route;
        if (!route.startsWith("http")) {
            if (getBridge() == null) return;
            url = getBridge().getLocalUrl() + route;   // https://localhost: the bundled page
        }
        final String finalUrl = url;
        final WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) webView.post(() -> webView.loadUrl(finalUrl));
    }
}
