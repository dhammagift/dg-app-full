import Foundation
import Compression
import Capacitor

// The library download, moved off the WebView and onto the system's background transfer service.
//
// Why this exists: the offline layer downloads dg.db.gz (216 MB) with fetch() inside a Web Worker,
// and iOS suspends a WebView's JavaScript the moment the app leaves the foreground — so a reader who
// switches apps or locks the screen stops the transfer mid-way. Android answers that with a
// foreground service (DgDownloadService); iOS's answer is a background URLSession, which the system
// keeps running, and relaunches the app for when it finishes.
//
//   start({url})  -> {path} once dg.db is unpacked in the App Group container (DgSharedLibrary);
//                    "progress" events {loaded, total} while the archive downloads, "unpack"
//                    events {loaded, total} while it is being unpacked
//   existing()    -> {path} or {path: null} if no library is on disk
//   cancel()      -> stops the transfer; the partial file is discarded (the caller can start again)
//
// The archive is unpacked here and deleted at once: the worker reads dg.db in place through
// /dg-sql (DgSharedLibrary.swift), so the file is the library — there is no import into OPFS and
// no second copy. An archive left by an earlier build in Application Support is unpacked too, so
// nobody downloads 216 MB again for the move.
//
// Deliberately no file size in any answer: FileManager's size/metadata reads are Apple's
// required-reason FileTimestamp APIs, and a plugin that does not use them needs no privacy manifest
// of its own. The byte counts the page shows come from the transfer's progress events.
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
    private var unpackError: Error?

    override public func load() {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        // Not discretionary: a discretionary transfer waits for a good moment (charging, Wi-Fi) and
        // the reader is standing there watching a progress card.
        config.isDiscretionary = false
        // Relaunch the app when the transfer finishes, so the unpacking can run.
        config.sessionSendsLaunchEvents = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    @objc func existing(_ call: CAPPluginCall) {
        do {
            try unpackIfNeeded()
            call.resolve(["path": DgLibrary.isPresent ? DgLibrary.dbURL.path : NSNull()])
        } catch {
            call.reject("could not unpack the downloaded archive: \(error.localizedDescription)")
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
        waiting = [call]
        unpackError = nil
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
        if let error = error ?? unpackError {
            calls.forEach { $0.reject("download failed: \(error.localizedDescription)") }
            return
        }
        guard DgLibrary.isPresent else {
            calls.forEach { $0.reject("download failed: no library on disk afterwards") }
            return
        }
        calls.forEach { $0.resolve(["path": DgLibrary.dbURL.path]) }
    }

    // MARK: - Unpacking

    // An archive in the library directory, or one an earlier build left in Application Support,
    // becomes dg.db; the archive is deleted once the file is complete. Nothing to do when dg.db is
    // already there and no newer archive waits beside it.
    private func unpackIfNeeded() throws {
        let fm = FileManager.default
        let target = DgLibrary.archiveURL
        let legacy = DgLibrary.legacyDirectory().appendingPathComponent(DgLibrary.archiveName)
        if !fm.fileExists(atPath: target.path), legacy != target, fm.fileExists(atPath: legacy.path) {
            try fm.moveItem(at: legacy, to: target)
            try? fm.removeItem(at: DgLibrary.legacyDirectory())
        }
        guard fm.fileExists(atPath: target.path) else { return }
        try unpack(archive: target, expectedBytes: 0)
    }

    private func unpack(archive: URL, expectedBytes: Int64) throws {
        let fm = FileManager.default
        let tmp = DgLibrary.dbURL.appendingPathExtension("tmp")
        try? fm.removeItem(at: tmp)
        try Self.gunzip(archive, to: tmp) { loaded in
            self.notifyListeners("unpack", data: ["loaded": loaded, "total": expectedBytes])
        }
        // Replace, not remove-then-move: a reader (or the extension) holding the old file keeps
        // reading it, and there is never a moment without a library.
        if fm.fileExists(atPath: DgLibrary.dbURL.path) {
            _ = try fm.replaceItemAt(DgLibrary.dbURL, withItemAt: tmp)
        } else {
            try fm.moveItem(at: tmp, to: DgLibrary.dbURL)
        }
        try? fm.removeItem(at: archive)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = DgLibrary.dbURL
        try? mutable.setResourceValues(values)
    }

    // gzip = a 10-byte header (+ optional fields), a raw deflate stream, an 8-byte trailer. The
    // Compression framework decodes raw deflate (COMPRESSION_ZLIB); the header is skipped here
    // and the trailer is never reached — the stream ends at the deflate end marker.
    private static func gunzip(_ source: URL, to destination: URL, progress: (Int64) -> Void) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let header = input.readData(ofLength: 10)
        guard header.count == 10, header[0] == 0x1f, header[1] == 0x8b, header[2] == 8 else {
            throw DgSqlError("not a gzip archive")
        }
        let flags = header[3]
        if flags & 0x04 != 0 {
            let extra = input.readData(ofLength: 2)
            guard extra.count == 2 else { throw DgSqlError("truncated gzip header") }
            _ = input.readData(ofLength: Int(extra[0]) | Int(extra[1]) << 8)
        }
        for bit in [UInt8(0x08), UInt8(0x10)] where flags & bit != 0 {
            while let byte = input.readData(ofLength: 1).first, byte != 0 {}
        }
        if flags & 0x02 != 0 { _ = input.readData(ofLength: 2) }

        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw DgSqlError("cannot create \(destination.lastPathComponent)")
        }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }

        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) != COMPRESSION_STATUS_ERROR else {
            throw DgSqlError("cannot start the decoder")
        }
        defer { compression_stream_destroy(stream) }

        let bufferSize = 1 << 20
        let out = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { out.deallocate() }
        var chunk = [UInt8]()
        var offset = 0
        var eof = false
        var consumed: Int64 = 10
        while true {
            if offset == chunk.count && !eof {
                chunk = [UInt8](input.readData(ofLength: bufferSize))
                offset = 0
                eof = chunk.isEmpty
            }
            let status: compression_status = chunk.withUnsafeBufferPointer { buffer in
                stream.pointee.src_ptr = (buffer.baseAddress ?? UnsafePointer(out)) + offset
                stream.pointee.src_size = chunk.count - offset
                stream.pointee.dst_ptr = out
                stream.pointee.dst_size = bufferSize
                let result = compression_stream_process(stream, eof ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0)
                let used = chunk.count - offset - stream.pointee.src_size
                offset += used
                consumed += Int64(used)
                return result
            }
            let produced = bufferSize - stream.pointee.dst_size
            if produced > 0 { output.write(Data(bytesNoCopy: out, count: produced, deallocator: .none)) }
            progress(consumed)
            if status == COMPRESSION_STATUS_END { return }
            guard status == COMPRESSION_STATUS_OK else { throw DgSqlError("the archive is damaged") }
            if eof && produced == 0 && stream.pointee.src_size == 0 { throw DgSqlError("the archive ended early") }
        }
    }

    // MARK: - URLSessionDownloadDelegate

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                           didFinishDownloadingTo location: URL) {
        // Called before didCompleteWithError, and the temporary file is deleted the moment this
        // returns — so the move happens here, synchronously; and so does the unpacking, which the
        // system's background time for a finished transfer covers. If it does not, the archive is
        // still on disk and existing() unpacks it at the next launch.
        let archive = DgLibrary.archiveURL
        do {
            if FileManager.default.fileExists(atPath: archive.path) {
                try FileManager.default.removeItem(at: archive)
            }
            try FileManager.default.moveItem(at: location, to: archive)
            try unpack(archive: archive, expectedBytes: downloadTask.countOfBytesReceived)
            notifyListeners("done", data: ["path": DgLibrary.dbURL.path])
        } catch {
            unpackError = error
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
