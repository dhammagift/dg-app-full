import UIKit
import WebKit
import UniformTypeIdentifiers

// The Share Extension: text or a link shared from another app is searched for, and the results are
// shown right here in the sheet — from the offline library when it is downloaded, without a network.
//
// It used to hand the text to the app instead, the way Android's ACTION_SEND filter does, and that
// is not a thing iOS allows. A share extension is a separate process living inside someone else's
// sheet, and opening its own app is reserved for Today and iMessage extensions — the documentation
// for NSExtensionContext.open names those two and no others. Four builds each found a different
// wall: 170 called that method (false), 190 the openURL: selector through the responder chain (iOS
// 18 forces it to NO), 193 UIApplication.open directly (Xcode 26 will not build an extension that
// is allowed to see it), 195 the same method through its IMP — which iOS accepted, ignored, and
// never called back, leaving the sheet open on the owner's phone.
//
// So the extension does the work itself, with the app's own pages: the WebView loads the bundled
// www/ (the containing app's public/ directory, through DgBundleSchemeHandler) at the same
// capacitor://localhost origin the app uses, and the offline layer inside it reads dg.db from the
// App Group container through /dg-sql (DgSharedLibrary.swift) — the same file the app downloaded.
// Nothing is interpreted or cleaned on the way, for the reason Android learned the hard way
// (stripping quotes and source URLs breaks whenever a host app changes its format).
//
// Without a downloaded library the page still loads (it is in the bundle) and its search goes to
// the site, as it does in the app. A link to dhamma.gift is opened as the page it names: whoever
// shares a link is online.
class ShareViewController: UIViewController {

    private var webView: WKWebView!
    private let status = UILabel()

    // App.app/PlugIns/ShareExtension.appex → App.app/public, where `cap sync` puts www/.
    private static var appPublicDir: URL {
        return Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("public", isDirectory: true)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(DgBundleSchemeHandler(root: Self.appPublicDir), forURLScheme: "capacitor")
        configuration.userContentController.addUserScript(DgLibrary.userScript(shareSheet: true))
        webView = WKWebView(frame: .zero, configuration: configuration)

        let done = UIButton(type: .system)
        done.setTitle("Done", for: .normal)
        done.addTarget(self, action: #selector(finish), for: .touchUpInside)

        status.text = "Searching…"
        status.textAlignment = .center
        status.textColor = .secondaryLabel

        for child in [done, webView!, status] {
            child.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(child)
        }

        NSLayoutConstraint.activate([
            done.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            done.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            webView.topAnchor.constraint(equalTo: done.bottomAnchor, constant: 8),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            status.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            status.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
        status.numberOfLines = 0
        webView.navigationDelegate = self
        webView.isHidden = true
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        sharedText { [weak self] text in
            guard let self = self else { return }
            let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let payload = trimmed, !payload.isEmpty else {
                self.status.text = "Nothing to search for: the share carried no text or link."
                return
            }
            self.search(for: payload)
        }
    }

    // The first usable attachment: plain text, or a URL (which the site's own `?q=` handling also
    // understands — it strips a trailing source URL, and a shared link IS one).
    private func sharedText(completion: @escaping (String?) -> Void) {
        let attachments = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []
        guard !attachments.isEmpty else {
            completion(nil)
            return
        }

        func firstString(from providers: [NSItemProvider], completion: @escaping (String?) -> Void) {
            guard let provider = providers.first else {
                completion(nil)
                return
            }
            let rest = Array(providers.dropFirst())

            func handle(_ identifier: String) -> Bool {
                guard provider.hasItemConformingToTypeIdentifier(identifier) else { return false }
                provider.loadItem(forTypeIdentifier: identifier, options: nil) { item, _ in
                    var text = item as? String
                    if text == nil, let url = item as? URL { text = url.absoluteString }
                    if text == nil, let attributed = item as? NSAttributedString { text = attributed.string }
                    if text == nil, let data = item as? Data { text = String(data: data, encoding: .utf8) }
                    DispatchQueue.main.async {
                        if let text = text, !text.isEmpty { completion(text) } else { firstString(from: rest, completion: completion) }
                    }
                }
                return true
            }

            if handle(UTType.plainText.identifier) { return }
            if handle(UTType.url.identifier) { return }
            firstString(from: rest, completion: completion)
        }

        firstString(from: attachments, completion: completion)
    }

    private func search(for payload: String) {
        // ponytail: the query rides in the URL, which has a practical ceiling of a few kilobytes. A
        // whole sutta pasted into a share is beyond it; for a word, a phrase or a link — what
        // people actually share — this is enough, and the ceiling is named rather than silently
        // dropping the tail.
        let capped = payload.count > 4000 ? String(payload.prefix(4000)) : payload
        if let shared = URL(string: capped), let host = shared.host,
           host == "dhamma.gift" || host.hasSuffix(".dhamma.gift") {
            webView.load(URLRequest(url: shared))
            return
        }
        guard let encoded = capped.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let url = URL(string: "capacitor://localhost/?q=" + encoded) else {
            status.text = "That text could not be turned into a search."
            return
        }
        webView.load(URLRequest(url: url))
    }

    @objc private func finish() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}

extension ShareViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        status.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        status.text = "The page could not be loaded: \(error.localizedDescription)"
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        status.text = "The page could not be loaded: \(error.localizedDescription)"
    }
}

// capacitor://localhost inside the extension: the app's www/ from the containing app's bundle, and
// /dg-sql from DgSqlSchemeHandler — the same two things Capacitor's asset handler plus
// DgSchemeRouter give the app, so the page cannot tell which process it runs in.
final class DgBundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    private let sql = DgSqlSchemeHandler()

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        if url.path.hasPrefix(DgLibrary.endpointPath + "/") {
            sql.webView(webView, start: task)
            return
        }
        // Capacitor's router: a path without an extension is a SPA route and gets index.html.
        let path = (url.path as NSString).pathExtension.isEmpty ? "/index.html" : url.path
        let file = root.appendingPathComponent(path)
        guard let data = FileManager.default.contents(atPath: file.path) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": Self.mimeType(for: (path as NSString).pathExtension),
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache"
        ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        sql.webView(webView, stop: task)
    }

    // The module worker and sqlite-wasm's loader are strict about these two; the rest is UTType.
    private static func mimeType(for ext: String) -> String {
        switch ext {
        case "js", "mjs": return "text/javascript"
        case "wasm": return "application/wasm"
        case "json": return "application/json"
        case "html": return "text/html"
        case "css": return "text/css"
        case "svg": return "image/svg+xml"
        default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
