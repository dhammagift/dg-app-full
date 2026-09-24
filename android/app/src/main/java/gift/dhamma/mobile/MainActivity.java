package gift.dhamma.mobile;

import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;

import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Guards against handling the same launch twice. BridgeActivity.load() — called from its
    // onCreate — ends with `this.onNewIntent(getIntent())`, which lands in the override below.
    // So the launch intent already reaches handleIntent without onCreate doing anything, and the
    // explicit handleIntent(getIntent()) that used to live in onCreate made it run TWICE on every
    // cold start: two loadUrl() calls for one shortcut tap, the second restarting a navigation the
    // first had already begun, racing the bridge's own initial load of the start page.
    private Intent handledIntent;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate(): Capacitor collects the registered plugins while the bridge
        // itself is being created. DgShortcuts is the dynamic-shortcuts bridge (recently read) —
        // see its own comment for why dynamic shortcuts are the reason this app is Capacitor.
        registerPlugin(DgShortcutsPlugin.class);
        // Download progress in the status bar, so backgrounding the app doesn't hide the 509MB
        // transfer (the page keeps reporting it; this only mirrors it natively).
        registerPlugin(DgProgressPlugin.class);
        registerPlugin(DgTtsPlugin.class);
        super.onCreate(savedInstanceState);
        // Deliberately no handleIntent() here — see handledIntent above.

        // And no second WebView, ever. With multiple windows enabled, any target="_blank" or
        // window.open() made Capacitor open another WebView, which loads the same local origin —
        // and this origin has no server behind paths like /sn56.48:1.4, so the reader got Chrome's
        // "Webpage not available (net::ERR_INVALID_RESPONSE)" in a window that also had no back
        // handling: the only way out was killing the app (owner, screenshots). native-bridge.js now
        // rewrites those navigations in place (openInPlace); this is the belt to that suspenders —
        // if anything still asks for a window, the WebView loads it in the current view instead.
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setSupportMultipleWindows(false);
        }

        // After the bridge, deliberately: the Capacitor StatusBar plugin applies its style inside
        // super.onCreate (its load()), and it would undo the theme.
        applyStatusBarIcons();
    }

    /**
     * The strip behind the status bar is the site's own dark band in both themes (issue #15), and
     * the theme says so — {@code windowLightStatusBar=false}, light icons. The Capacitor StatusBar
     * plugin overrides that anyway: with no "style" in capacitor.config.json it applies DEFAULT,
     * which takes the icon colour from the SYSTEM night mode (see its own getStyleForTheme()), so a
     * phone in light mode got dark icons on our dark band and the clock vanished (owner report,
     * 2026-09-24: "чёрное на тёмном, не видел часов" — while every other app was fine, because
     * every other app's strip follows the same theme it derives the icons from).
     *
     * Re-asserted on configuration changes too: that is exactly the moment the plugin re-applies
     * DEFAULT, and the manifest's configChanges list means this activity is not recreated for a
     * uiMode change, so onCreate alone would not run again.
     */
    private void applyStatusBarIcons() {
        WindowInsetsControllerCompat controller =
                new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyStatusBarIcons();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Identity check, not equals(): the point is "this exact delivery was already handled",
        // and two separate taps on the same shortcut produce equal-but-distinct Intents that both
        // must work.
        if (intent == handledIntent) return;
        handledIntent = intent;
        handleIntent(intent);
    }

    // Turns the three ways this activity can be launched with extra data — a shared-text Intent
    // (Web Share Target equivalent, see AndroidManifest.xml's ACTION_SEND filter), a dhamma.gift
    // deep link (ACTION_VIEW filter, same file), or a static App Shortcut's "route" extra
    // (res/xml/shortcuts.xml) — into a URL the WebView loads. None of these are wired up
    // automatically here the way they would be for a Trusted Web Activity reading the site's web
    // manifest; this is the Capacitor equivalent.
    //
    // https://localhost is Capacitor's default local-server origin (capacitor.config.json sets no
    // custom server.hostname/androidScheme) — hardcoded rather than derived because the bridge/
    // webview isn't guaranteed to have already loaded a URL to read the origin back from,
    // especially on the very first onCreate call.
    //
    // Shortcut routes CANNOT be loaded directly (loadUrl("https://localhost/toc/...")) — the
    // static asset server behind that origin has no file at that path (only index.html at root;
    // same reason a raw browser reload of a pushState'd URL 404s, see build-assets.js/app.js
    // comments) — only the SPA's OWN client-side router can turn that path into the TOC view,
    // and it only runs once index.html has actually loaded at "/". So a shortcut route is passed
    // as a query param on the root URL instead; app.js's very first lines (before anything else
    // executes) rewrite the visible location via history.replaceState() to the real target path
    // BEFORE the page's own bootstrap script reads window.location — same trick the SPA already
    // uses everywhere for pushState navigation, just kicked off natively instead of by a click.
    // The shared-text case needs no such rewrite: "/?q=..." on the root IS the real, correct
    // request — initSearchApp() already reads a "q" query param on the home path directly.
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String url = null;
        if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText != null && !sharedText.isEmpty()) {
                // RAW text, deliberately: the shared payload ("<text>" plus the source page's URL,
                // sometimes with a #:~:text= fragment) is cleaned by the SITE, in
                // search/index.html's `?q=` handling — the same code path a web share_target and a
                // plain link already go through, and the same thing dg-twa's LauncherActivity does
                // (it too just passes EXTRA_TEXT through). Cleaning here as well meant two
                // implementations to fix every time Android's share format changed; the copy that
                // used to live in this file was removed for exactly that reason. Nothing about
                // incoming shares belongs in a wrapper.
                url = "https://localhost/?q=" + Uri.encode(sharedText);
            }
        } else if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null
                && "dhammagift".equals(intent.getData().getScheme())) {
            // Google sign-in handoff: dhamma.gift/login/app-google.html (system browser) returns the
            // Google ID token and the app's one-time state as extras. The bundled login page finishes
            // the Firebase sign-in (native-bridge.js googleSignInViaBrowser); they travel in the
            // fragment, which never leaves the WebView.
            String token = intent.getStringExtra("id_token");
            String state = intent.getStringExtra("state");
            if ("auth".equals(intent.getData().getHost()) && token != null && state != null) {
                String page = "ru".equals(intent.getStringExtra("lang")) ? "ru/login/index.html" : "login/index.html";
                url = "https://localhost/" + page + "#dg_google=" + Uri.encode(token) + "&state=" + Uri.encode(state);
            } else if (!"auth".equals(intent.getData().getHost())) {
                // Any other dhammagift:// URL is one of the app's own deep links (docs/DEEP_LINKS.md).
                // Handed over RAW, in the same ?_deepLink= handoff the shortcut routes use: the page
                // maps it in src/deep-link.js, which is also what iOS uses — one implementation for
                // both platforms, so `dhammagift://mn1` cannot come to mean two different things.
                url = "https://localhost/?_deepLink=" + Uri.encode(intent.getData().toString());
            }
        } else if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            // A dhamma.gift/f.dhamma.gift/find.dhamma.gift link opened from outside the app (see
            // the VIEW intent-filter in AndroidManifest.xml) — same _nativeRoute handoff as the
            // App Shortcuts below, just built from the tapped URL's own path+query instead of a
            // fixed extra.
            Uri data = intent.getData();
            String path = data.getPath();
            String route = (path == null || path.isEmpty() ? "/" : path)
                + (data.getQuery() != null ? "?" + data.getQuery() : "");
            url = "https://localhost/?_nativeRoute=" + Uri.encode(route);
        } else {
            String route = intent.getStringExtra("route");
            if (route != null) {
                url = "https://localhost/?_nativeRoute=" + Uri.encode(route);
            } else if (intent.getStringExtra("openQuickModal") != null) {
                // The extra's VALUE is the Quick Modal tab key itself (e.g. "tab-fav",
                // "tab-4as") — settings-bundle.js already listens for exactly this shape on
                // DOMContentLoaded (its own hook, used by the site's "Быстрое окно" doc page), so
                // it needs no shim of its own here beyond forwarding the value through.
                //
                // A custom app.js `_openQuickModal` + `window.addEventListener('load', ...)` used
                // to do this instead, and reportedly just opened the home screen on real devices
                // — `load` waits on every subresource and isn't guaranteed to fire promptly (or
                // to still be pending when the listener attaches) in this WebView, while
                // settings-bundle.js's own hook fires on DOMContentLoaded, which is both earlier
                // and already proven to work for this exact purpose on the live site.
                url = "https://localhost/?action=" + Uri.encode(intent.getStringExtra("openQuickModal"));
            }
        }
        if (url == null) return;

        final String finalUrl = url;
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().post(() -> bridge.getWebView().loadUrl(finalUrl));
        }
    }

    // cleanSharedText() used to live here. Removed on purpose: the site cleans `?q=` itself
    // (search/index.html — strips a trailing source URL, then one wrapping quote pair), which is
    // the one place that also serves the web share_target, the PWA and the TWA. Keeping a second
    // copy in the wrapper is how the two drift apart, and Android's share format is not stable
    // enough for "fix it in every shell" to be a plan. dg-twa's LauncherActivity does the same:
    // it passes EXTRA_TEXT straight through.
}
