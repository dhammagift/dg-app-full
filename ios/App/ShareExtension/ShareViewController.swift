import UIKit
import WebKit
import UniformTypeIdentifiers

// The Share Extension: text or a link shared from another app is searched for, and the results are
// shown right here in the sheet.
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
// So the extension does the work instead of delegating it, which is what iOS extensions are for:
// share a phrase from any app and see where it occurs in the suttas without leaving that app. The
// site answers the same `?q=` that the app, the web share target and a plain link all use, so there
// is nothing here to keep in step with it — and nothing is interpreted or cleaned on the way, for the reason
// Android learned the hard way (stripping quotes and source URLs breaks whenever a host app changes
// its format).
class ShareViewController: UIViewController {

    private let webView = WKWebView(frame: .zero)
    private let status = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let done = UIButton(type: .system)
        done.setTitle("Done", for: .normal)
        done.addTarget(self, action: #selector(finish), for: .touchUpInside)

        status.text = "Searching…"
        status.textAlignment = .center
        status.textColor = .secondaryLabel

        for child in [done, webView, status] {
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
        // whole sutta pasted into a share is beyond it; the upgrade path is an App Group container
        // the sheet reads from. For a word, a phrase or a link — what people actually share — this
        // is enough, and the ceiling is named rather than silently dropping the tail.
        let capped = payload.count > 4000 ? String(payload.prefix(4000)) : payload
        // A link to the site is already the page someone means: open it, and a sutta reference lands
        // in the reader instead of becoming a search for its own address.
        if let shared = URL(string: capped), let host = shared.host,
           host == "dhamma.gift" || host.hasSuffix(".dhamma.gift") {
            webView.load(URLRequest(url: shared))
            return
        }
        guard let encoded = capped.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let url = URL(string: "https://dhamma.gift/?q=" + encoded) else {
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

    // The search needs the site: the offline library lives in the app's own container, which this
    // process cannot read. Say so plainly instead of showing an empty white sheet.
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        status.text = "Dhamma.gift could not be reached. Open the app to search the offline library."
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        status.text = "Dhamma.gift could not be reached. Open the app to search the offline library."
    }
}
