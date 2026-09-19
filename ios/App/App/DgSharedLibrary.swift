import Foundation
import WebKit
import DgSQLite

// One dg.db in the App Group container, read by the app and by the share extension.
//
// The offline layer (dg-node's public/offline) keeps the library in OPFS, which belongs to the
// process that created it: the share extension, a separate process, could never see the app's
// copy, so sharing text to Dhamma.gift needed the network. A plain file in the group container is
// visible to both, and it also ends the double storage iOS had — the 206 MB archive that nothing
// deleted next to the 584 MB OPFS copy. Here the archive is unpacked into dg.db and removed.
//
// The search core talks to SQLite through one prepare().all() adapter (db-worker.js), and it calls
// it synchronously. So the worker asks this process with a synchronous XMLHttpRequest to
// /dg-sql/... on the page's own origin, and DgSqlSchemeHandler answers with rows as JSON:
//   /dg-sql/status            {present}   — also closes the connection, so a replaced file reopens
//   /dg-sql/query?s=<json>    {cols, rows} for {sql, params}
//   /dg-sql/delete            removes dg.db (Settings → delete the offline library)
// This file is compiled into both targets; the download and unpacking live in DgDownloadPlugin
// (app only), the extension only reads.
enum DgLibrary {
    static let groupId = "group.gift.dhamma.mobile"
    static let endpointPath = "/dg-sql"
    static let dbName = "dg.db"
    static let archiveName = "dg.db.gz"

    // The group container, or — for a build whose App ID has no App Group yet — the app's own
    // Application Support (the same directory builds 170–215 downloaded into). The app works
    // either way; only the extension needs the group.
    static func directory() -> URL {
        let fm = FileManager.default
        let dir = fm.containerURL(forSecurityApplicationGroupIdentifier: groupId)?
            .appendingPathComponent("dg-library", isDirectory: true) ?? legacyDirectory()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func legacyDirectory() -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true))
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("dg-library", isDirectory: true)
    }

    static var dbURL: URL { directory().appendingPathComponent(dbName) }
    static var archiveURL: URL { directory().appendingPathComponent(archiveName) }
    static var isPresent: Bool { FileManager.default.fileExists(atPath: dbURL.path) }

    // Tells src/platform.js (and through it the worker) that SQL runs natively at endpointPath.
    // The site and Android never define it and keep their OPFS path. In the share sheet the page
    // also gets the offline layer's own "a library exists here" flag, because the sheet's WebView
    // has a fresh localStorage and the layer starts its worker only for a reason.
    static func userScript(shareSheet: Bool) -> WKUserScript {
        var js = "window.DG_NATIVE_SQL = '\(endpointPath)';"
        if shareSheet {
            js += "window.DG_SHARE_SHEET = true;"
            if isPresent { js += "try { localStorage.setItem('dg.offline.libraryExists', '1'); } catch (e) {}" }
        }
        return WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }
}

struct DgSqlError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// The regex the core registers as regexp_test (core-bundle.js, registerRegexpTest): a JS RegExp
// with the 'i' flag over a JS callback, which a native SQLite cannot call — so the same function
// is defined here with NSRegularExpression. A C callback cannot capture, hence the static cache.
// ponytail: ICU regex, not JS regex — identical for the words and alternations people search
// for; a pattern that only JS accepts fails here with "invalid regular expression".
private var regexCache: (pattern: String, regex: NSRegularExpression?) = ("", nil)

private func regexpTest(_ ctx: OpaquePointer?, _ argc: Int32, _ argv: UnsafeMutablePointer<OpaquePointer?>?) {
    guard let argv = argv, let p = sqlite3_value_text(argv[0]), let t = sqlite3_value_text(argv[1]) else {
        sqlite3_result_int(ctx, 0)
        return
    }
    let pattern = String(cString: p)
    if regexCache.pattern != pattern {
        regexCache = (pattern, try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]))
    }
    guard let regex = regexCache.regex else {
        sqlite3_result_error(ctx, "invalid regular expression", -1)
        return
    }
    let text = String(cString: t)
    let hit = regex.firstMatch(in: text, options: [], range: NSRange(text.startIndex..., in: text)) != nil
    sqlite3_result_int(ctx, hit ? 1 : 0)
}

final class DgSqlSchemeHandler: NSObject, WKURLSchemeHandler {
    private let queue = DispatchQueue(label: "gift.dhamma.mobile.sql")
    private var db: OpaquePointer?               // touched on `queue` only
    private var live = Set<ObjectIdentifier>()   // main thread only: tasks not yet stopped

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let id = ObjectIdentifier(task as AnyObject)
        live.insert(id)
        let op = url.lastPathComponent
        let payload = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "s" })?.value
        queue.async {
            let (status, body) = self.handle(op: op, payload: payload)
            DispatchQueue.main.async {
                // A task that was stopped must not be touched again — WebKit throws.
                guard self.live.remove(id) != nil else { return }
                let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [
                    "Content-Type": "application/json",
                    "Content-Length": String(body.count),
                    "Cache-Control": "no-store"
                ])!
                task.didReceive(response)
                task.didReceive(body)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        live.remove(ObjectIdentifier(task as AnyObject))
    }

    private func handle(op: String, payload: String?) -> (Int, Data) {
        do {
            switch op {
            case "status":
                close()
                return (200, try json(["present": DgLibrary.isPresent]))
            case "query":
                guard let payload = payload, let data = payload.data(using: .utf8),
                      let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let sql = request["sql"] as? String else {
                    return (400, try json(["error": "bad request"]))
                }
                return (200, try json(try run(sql: sql, params: request["params"] as? [Any] ?? [])))
            case "delete":
                close()
                try? FileManager.default.removeItem(at: DgLibrary.dbURL)
                try? FileManager.default.removeItem(at: DgLibrary.archiveURL)
                return (200, try json(["deleted": true]))
            default:
                return (404, try json(["error": "unknown op \(op)"]))
            }
        } catch {
            return (500, (try? json(["error": error.localizedDescription])) ?? Data())
        }
    }

    private func json(_ object: Any) throws -> Data {
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func close() {
        if let db = db { sqlite3_close(db) }
        db = nil
    }

    // Read-only and immutable: SQLite then never creates -journal/-wal/-shm next to a file that
    // another process is reading, and never takes a lock on it.
    private func open() throws -> OpaquePointer {
        if let db = db { return db }
        guard DgLibrary.isPresent else { throw DgSqlError("the offline library is not downloaded") }
        let path = DgLibrary.dbURL.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? DgLibrary.dbURL.path
        var handle: OpaquePointer?
        let rc = sqlite3_open_v2("file:\(path)?immutable=1", &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX, nil)
        guard rc == SQLITE_OK, let opened = handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open the database"
            if let handle = handle { sqlite3_close(handle) }
            throw DgSqlError(message)
        }
        sqlite3_create_function_v2(opened, "regexp_test", 2, SQLITE_UTF8 | SQLITE_DETERMINISTIC, nil, regexpTest, nil, nil, nil)
        db = opened
        return opened
    }

    // Column-major on purpose: {cols, rows} is a fraction of the JSON of one object per row, and
    // the worker rebuilds objects in a few lines. A search can return tens of thousands of rows.
    private func run(sql: String, params: [Any]) throws -> [String: Any] {
        let db = try open()
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let stmt = statement else {
            throw DgSqlError(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, param) in params.enumerated() {
            let index = Int32(i + 1)
            switch param {
            case let text as String:
                sqlite3_bind_text(stmt, index, text, -1, transient)
            case let number as NSNumber:
                if CFNumberIsFloatType(number) { sqlite3_bind_double(stmt, index, number.doubleValue) }
                else { sqlite3_bind_int64(stmt, index, number.int64Value) }
            default:
                sqlite3_bind_null(stmt, index)
            }
        }
        let count = Int(sqlite3_column_count(stmt))
        let cols = (0..<count).map { String(cString: sqlite3_column_name(stmt, Int32($0))!) }
        var rows: [[Any]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw DgSqlError(String(cString: sqlite3_errmsg(db))) }
            var row: [Any] = []
            row.reserveCapacity(count)
            for c in 0..<count {
                let column = Int32(c)
                switch sqlite3_column_type(stmt, column) {
                case SQLITE_INTEGER: row.append(sqlite3_column_int64(stmt, column))
                case SQLITE_FLOAT: row.append(sqlite3_column_double(stmt, column))
                case SQLITE_TEXT: row.append(String(cString: sqlite3_column_text(stmt, column)!))
                default: row.append(NSNull())
                }
            }
            rows.append(row)
        }
        return ["cols": cols, "rows": rows]
    }
}
