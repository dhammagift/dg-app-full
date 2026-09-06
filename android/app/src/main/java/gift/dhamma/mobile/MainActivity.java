package gift.dhamma.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
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
        super.onCreate(savedInstanceState);
        // Deliberately no handleIntent() here — see handledIntent above.
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
                url = "https://localhost/?q=" + Uri.encode(sharedText);
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
                // <extra> in shortcuts.xml always yields a String extra (no boolean type there),
                // so this is checked for presence, not parsed as a boolean.
                url = "https://localhost/?_openQuickModal=1";
            }
        }
        if (url == null) return;

        final String finalUrl = url;
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().post(() -> bridge.getWebView().loadUrl(finalUrl));
        }
    }
}
