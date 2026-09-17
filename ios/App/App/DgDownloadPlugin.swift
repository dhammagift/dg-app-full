import Foundation
import Capacitor

// The library download, moved off the WebView and onto the system's background transfer service.
//
// Why this exists: the offline layer downloads dg.db.gz (216 MB) with fetch() inside a Web Worker,
// and iOS suspends a WebView's JavaScript the moment the app leaves the foreground — so a reader who
// switches apps or locks the screen stops the transfer mid-way. Android answers that with a
// foreground service (DgDownloadService); iOS's answer is a background URLSession, which the system
// keeps running, and relaunches the app for when it finishes.
//
//   start({url})  -> {path, bytes} once the archive is on disk; "progress" events {loaded, total}
//   existing()    -> {path, bytes} or {path: null} if nothing was downloaded yet
//   cancel()      -> stops the transfer; the partial file is discarded (the caller can start again)
//
// The file lands in Application Support, NOT Caches: Caches can be purged under storage pressure,
// and this is the app's whole offline library. It is also excluded from iCloud backup — 216 MB of
// re-downloadable data has no business in someone's backup quota.
//
// What it deliberately does NOT do: unpack anything. The archive import belongs to the offline layer
// that already knows how (db-worker.js's OPFS SAH-pool path), and it stays there: this plugin's job
// ends at "the bytes are on disk", which is also the only part that has to survive backgrounding.
//
// ponytail: one download at a time, no resume-data bookkeeping (a restart re-requests the file and
// the server's Range support does the rest), no notification and no Live Activity — progress is
// forwarded to the page, which already has a progress card and now also gets DgProgress's idle
// timer. Add resume data if a real network shows the server refusing Range.
@objc(DgDownloadPlugin)
public class DgDownloadPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDownloadDelegate, URLSessionTaskDelegate {
    public let identifier = "DgDownloadPlugin"
    public let jsName = "DgDownload"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "existing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    static let sessionIdentifier = "gift.dhamma.mobile.library"
    // Set by AppDelegate when the system wakes the app to hand over a finished background transfer.
    static var backgroundCompletionHandler: (() -> Void)?

    private var session: URLSession!
    private var task: URLSessionDownloadTask?
    private var waiting: [CAPPluginCall] = []
    private var destination: URL?

    override public func load() {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        // Not discretionary: a discretionary transfer waits for a good moment (charging, Wi-Fi) and
        // the reader is standing there watching a progress card.
        config.isDiscretionary = false
        // Relaunch the app when the transfer finishes, so the import can start.
        config.sessionSendsLaunchEvents = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    private func libraryDir() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("dg-library", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private func fileURL(for url: URL) throws -> URL {
        let name = url.lastPathComponent.isEmpty ? "dg.db.gz" : url.lastPathComponent
        return try libraryDir().appendingPathComponent(name)
    }

    @objc func existing(_ call: CAPPluginCall) {
        do {
            let dir = try libraryDir()
            let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])
            guard let file = files.first else {
                call.resolve(["path": NSNull(), "bytes": 0])
                return
            }
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            call.resolve(["path": file.path, "bytes": size])
        } catch {
            call.reject("could not look for a downloaded archive: \(error.localizedDescription)")
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            call.reject("no url")
            return
        }
        // A second start while one is running joins the running transfer instead of racing it: the
        // page can be reloaded (or the app relaunched) mid-download.
        if task != nil {
            waiting.append(call)
            return
        }
        do {
            destination = try fileURL(for: url)
        } catch {
            call.reject("could not prepare the download directory: \(error.localizedDescription)")
            return
        }
        waiting = [call]
        let newTask = session.downloadTask(with: url)
        task = newTask
        newTask.resume()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        task?.cancel()
        task = nil
        waiting = []
        call.resolve()
    }

    private func finish(error: Error?) {
        let calls = waiting
        waiting = []
        task = nil
        guard let path = destination?.path else {
            calls.forEach { $0.reject("download failed: no destination") }
            return
        }
        if let error = error {
            calls.forEach { $0.reject("download failed: \(error.localizedDescription)") }
            return
        }
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let size = (attrs?[.size] as? Int) ?? 0
        calls.forEach { $0.resolve(["path": path, "bytes": size]) }
    }

    // MARK: - URLSessionDownloadDelegate

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                           didFinishDownloadingTo location: URL) {
        // Called before didCompleteWithError, and the temporary file is deleted the moment this
        // returns — so the move happens here, synchronously.
        guard let destination = destination else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: location, to: destination)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutable = destination
            try? mutable.setResourceValues(values)
            notifyListeners("done", data: ["path": destination.path])
        } catch {
            notifyListeners("failed", data: ["error": error.localizedDescription])
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                           didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                           totalBytesExpectedToWrite: Int64) {
        notifyListeners("progress", data: [
            "loaded": totalBytesWritten,
            "total": totalBytesExpectedToWrite
        ])
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error: error)
    }

    // The system's own "you may go back to sleep" signal for a background session, and the reason
    // AppDelegate has to park the handler this plugin is given: iOS relaunches the app for a
    // finished transfer, hands it a completion handler, and expects it called or the app is killed.
    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let handler = Self.backgroundCompletionHandler else { return }
        Self.backgroundCompletionHandler = nil
        DispatchQueue.main.async { handler() }
    }
}
