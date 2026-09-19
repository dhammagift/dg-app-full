import UIKit
import UniformTypeIdentifiers

// The Share Extension: text (or a link) shared from another app opens Dhamma.gift with it as a
// search. This is what Android's ACTION_SEND filter does for the APK, and the iOS app had no way to
// receive a share at all until this target existed.
//
// What it deliberately does NOT do: clean or interpret the shared text. Android learned this the hard
// way — the wrapper used to strip the source URL and the wrapping quotes, and had to be fixed every
// time a host app changed its share format. The site does it once, for every platform, in
// search/index.html's `?q=` handling (the same path the web share_target and a plain link take), so
// the raw payload is passed through untouched.
//
// How it reaches the app: the app's own URL scheme. `dhammagift://search?q=…` is already the mapping
// the app answers (docs/DEEP_LINKS.md, src/deep-link.js), and it turns into `/?q=…` — the same URL
// Android's MainActivity builds for a share. Nothing new to receive, nothing to keep in step.
class ShareViewController: UIViewController {

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        sharedText { [weak self] text in
            guard let self = self else { return }
            let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let payload = trimmed, !payload.isEmpty else {
                self.finish()
                return
            }
            self.handToApp(payload)
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

            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                    let text = (item as? String) ?? (item as? NSAttributedString)?.string
                    DispatchQueue.main.async {
                        if let text = text, !text.isEmpty { completion(text) } else { firstString(from: rest, completion: completion) }
                    }
                }
                return
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                    var text: String?
                    if let url = item as? URL { text = url.absoluteString }
                    else if let url = item as? NSURL { text = url.absoluteString }
                    else if let string = item as? String { text = string }
                    DispatchQueue.main.async {
                        if let text = text, !text.isEmpty { completion(text) } else { firstString(from: rest, completion: completion) }
                    }
                }
                return
            }
            firstString(from: rest, completion: completion)
        }

        firstString(from: attachments, completion: completion)
    }

    private func handToApp(_ payload: String) {
        // ponytail: the payload rides in the URL, which has a practical ceiling of a few kilobytes.
        // A whole sutta pasted into a share is beyond it; the upgrade path is an App Group container
        // the app reads on `dhammagift://share` (an entitlement, so it waits until there is a Team
        // ID). For the lengths people actually share — a word, a phrase, a link — this is enough, and
        // the ceiling is named rather than silently dropping the tail.
        let capped = payload.count > 4000 ? String(payload.prefix(4000)) : payload
        guard let encoded = capped.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let url = URL(string: "dhammagift://search?q=" + encoded) else {
            finish()
            return
        }
        openHostApp(url)
        // The open is handed to the system asynchronously; completing the request in the same turn
        // tears the extension down before it is delivered (the sheet flashed and nothing opened).
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.finish() }
    }

    // NSExtensionContext.open(_:) is honoured only by Today and iMessage extensions; in a share
    // extension it returns false without opening anything. The app is reached the way share
    // extensions have always done it: UIApplication sits at the end of the responder chain, and its
    // openURL: selector is callable from there even though UIApplication.shared is not.
    @objc private func openURL(_ url: URL) -> Bool { return false }

    private func openHostApp(_ url: URL) {
        let selector = #selector(openURL(_:))
        var responder: UIResponder? = self
        while let current = responder {
            if current !== self && current.responds(to: selector) {
                current.perform(selector, with: url)
                return
            }
            responder = current.next
        }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}
