import UIKit
import WebKit
import Capacitor

// The app's own bridge view controller: CAPBridgeViewController plus the plugins that live in this
// target rather than in an npm package.
//
// Capacitor loads the npm plugins (App, Browser, Dialog, Network, Share, StatusBar) from the
// package list `cap sync` writes; anything written here has to be registered by hand, and it has to
// happen before the page loads. capacitorDidLoad() is Capacitor's own hook for exactly that: the
// bridge exists, the first navigation has not started.
//
// What is registered here, and why:
//   DgProgressPlugin  the idle timer that keeps the screen awake while the library downloads
//   DgTtsPlugin       the reader's voice (WKWebView's own speechSynthesis has no voices)
//   DgDownloadPlugin  the library download, on a background URLSession
//   DgShortcutsPlugin quick actions: the dynamic "recently read" list, and what a tap does
//   DgSelfTestPlugin  debug builds only: the CI simulator run's way of getting results out
//
// Note for the next plugin: Capacitor 8's iOS CAPPlugin has no handleOnDestroy (Android's has), so a
// cleanup hook has to be a deinit — an @objc override of it fails the build with "does not override
// any method from its superclass".
class DgBridgeViewController: CAPBridgeViewController {

    // Capacitor registers its asset handler for capacitor://localhost on the configuration this
    // returns, after it returns — the one moment /dg-sql can be put on the same origin, which is
    // what lets the worker reach it with a plain same-origin XMLHttpRequest. So the configuration is
    // a subclass that wraps whatever handler is registered on it (DgSchemeRouter), and this method
    // mirrors CAPBridgeViewController.webViewConfiguration(for:) setting by setting, because super
    // would hand back a plain WKWebViewConfiguration.
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = DgWebViewConfiguration()
        configuration.websiteDataStore.httpCookieStore.add(CapacitorWKCookieObserver())
        configuration.allowsInlineMediaPlayback = true
        configuration.suppressesIncrementalRendering = false
        configuration.allowsAirPlayForMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.limitsNavigationsToAppBoundDomains = instanceConfiguration.limitsNavigationsToAppBoundDomains
        if #available(iOS 15.4, *) {
            configuration.preferences.isElementFullscreenEnabled = true
        }
        if let appendUserAgent = instanceConfiguration.appendedUserAgentString {
            if let appName = configuration.applicationNameForUserAgent {
                configuration.applicationNameForUserAgent = "\(appName) \(appendUserAgent)"
            } else {
                configuration.applicationNameForUserAgent = appendUserAgent
            }
        }
        if let preferredContentMode = instanceConfiguration.preferredContentMode {
            var mode = WKWebpagePreferences.ContentMode.recommended
            if preferredContentMode == "mobile" {
                mode = .mobile
            } else if preferredContentMode == "desktop" {
                mode = .desktop
            }
            configuration.defaultWebpagePreferences.preferredContentMode = mode
        }
        return configuration
    }

    override func capacitorDidLoad() {
        // Edge swipe = browser Back. WKWebView leaves it off by default, and Android's system Back
        // already does this, so on iOS a reader who taps a link by accident had no way back to the
        // sutta (a tester's report). Uses the WebView's own history, so it only goes back when there
        // is somewhere to go.
        webView?.allowsBackForwardNavigationGestures = true

        // The page learns that SQL runs natively (DgSharedLibrary.swift). Added here and not in
        // webViewConfiguration(for:), because Capacitor replaces the user content controller after
        // that call.
        webView?.configuration.userContentController.addUserScript(DgLibrary.userScript(shareSheet: false))

        // Ships in the app: it keeps the screen awake while the offline library downloads
        // (DgProgressPlugin.swift), which is what stops iOS suspending the transfer mid-way.
        bridge?.registerPluginInstance(DgProgressPlugin())
        // Also shipped: the WebView's own speechSynthesis has no voices (see DgTtsPlugin.swift), and
        // the reader's voice player is part of the reader.
        bridge?.registerPluginInstance(DgTtsPlugin())
        // The library download on the system's background transfer service (DgDownloadPlugin.swift):
        // the WebView's own fetch dies when the app leaves the foreground, and this is the iOS
        // answer to Android's foreground service.
        bridge?.registerPluginInstance(DgDownloadPlugin())
        // The Home Screen's long-press menu: the dynamic "recently read" items the page hands over,
        // and the handler that makes a tap open its route (DgShortcutsPlugin.swift).
        bridge?.registerPluginInstance(DgShortcutsPlugin())

        #if DEBUG
        // Debug builds only, and deliberately so: this plugin lets the page write a file into the
        // app's Documents directory, which no shipped build may be able to do on a web page's
        // behalf. A release build's `Capacitor.Plugins.DgSelfTest` is therefore undefined.
        bridge?.registerPluginInstance(DgSelfTestPlugin())
        #endif
    }
}

final class DgWebViewConfiguration: WKWebViewConfiguration {
    override func setURLSchemeHandler(_ urlSchemeHandler: WKURLSchemeHandler?, forURLScheme urlScheme: String) {
        super.setURLSchemeHandler(urlSchemeHandler.map { DgSchemeRouter(inner: $0) }, forURLScheme: urlScheme)
    }
}

// /dg-sql/* goes to the SQL handler, everything else to Capacitor's asset handler.
final class DgSchemeRouter: NSObject, WKURLSchemeHandler {
    private let inner: WKURLSchemeHandler
    private let sql = DgSqlSchemeHandler()

    init(inner: WKURLSchemeHandler) {
        self.inner = inner
    }

    private func isSql(_ task: WKURLSchemeTask) -> Bool {
        return task.request.url?.path.hasPrefix(DgLibrary.endpointPath + "/") == true
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        (isSql(urlSchemeTask) ? sql : inner).webView(webView, start: urlSchemeTask)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        (isSql(urlSchemeTask) ? sql : inner).webView(webView, stop: urlSchemeTask)
    }
}
