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
//
// Nothing here fails silently: a share that cannot be handed over says why in the sheet, because
// "the sheet flashed and the home screen came back" (owner, twice) is not something a phone can be
// debugged from.
class ShareViewController: UIViewController {

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        sharedText { [weak self] text, seen in
            guard let self = self else { return }
            let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let payload = trimmed, !payload.isEmpty else {
                self.fail("Nothing to search for: the share carried no text or link (" + seen + ").")
                return
            }
            self.handToApp(payload)
        }
    }

    // The first usable attachment: plain text, or a URL (which the site's own `?q=` handling also
    // understands — it strips a trailing source URL, and a shared link IS one). `seen` lists the
    // type identifiers that were offered, for the message when none of them worked.
    private func sharedText(completion: @escaping (String?, String) -> Void) {
        let attachments = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []
        let seen = attachments.flatMap { $0.registeredTypeIdentifiers }.joined(separator: ", ")
        guard !attachments.isEmpty else {
            completion(nil, "no attachments")
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
                    var text = (item as? String) ?? (item as? NSAttributedString)?.string
                    if text == nil, let data = item as? Data { text = String(data: data, encoding: .utf8) }
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
                    else if let data = item as? Data { text = String(data: data, encoding: .utf8) }
                    DispatchQueue.main.async {
                        if let text = text, !text.isEmpty { completion(text) } else { firstString(from: rest, completion: completion) }
                    }
                }
                return
            }
            firstString(from: rest, completion: completion)
        }

        firstString(from: attachments) { completion($0, seen) }
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
            fail("The shared text could not be put into a link.")
            return
        }
        openHostApp(url) { [weak self] opened in
            guard let self = self else { return }
            if opened {
                self.finish()
            } else {
                self.fail("iOS refused to open dhammagift:// from the share sheet (open returned false).")
            }
        }
    }

    // NSExtensionContext.open(_:) is honoured only by Today and iMessage extensions; in a share
    // extension it returns false without opening anything (build 170). UIApplication sits at the end
    // of the responder chain, but iOS 18 forces the old openURL: selector to return NO (build 190:
    // "BUG IN CLIENT OF UIKIT … migrate to open(_:options:completionHandler:)"), and Xcode 26
    // refuses to build an extension without APPLICATION_EXTENSION_API_ONLY, which hides the new
    // method from the compiler (build 193). So the new method is called through its IMP with the
    // real C signature — the one form that both compiles and is not the deprecated entry point —
    // and its completion says whether the open happened.
    private func openHostApp(_ url: URL, completion: @escaping (Bool) -> Void) {
        typealias OpenURL = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?) -> Void
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current !== self, current.responds(to: selector), let imp = current.method(for: selector) {
                let open = unsafeBitCast(imp, to: OpenURL.self)
                open(current, selector, url as NSURL, NSDictionary(), { ok in DispatchQueue.main.async { completion(ok) } })
                return
            }
            responder = current.next
        }
        completion(false)
    }

    private func fail(_ reason: String) {
        let alert = UIAlertController(title: "Dhamma.gift could not open", message: reason, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in self?.finish() })
        present(alert, animated: true)
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}
