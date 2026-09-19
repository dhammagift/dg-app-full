// swift-tools-version: 5.9
import PackageDescription

// SQLite compiled into the app and the share extension, instead of the system's libsqlite3.
//
// dg.db's full-text index is `fts5(... tokenize='trigram remove_diacritics 1')`, and the
// remove_diacritics option of the trigram tokenizer exists only since SQLite 3.45 (January 2024).
// The system library on iOS 16-18 is older, so the first MATCH on those devices would fail with
// "unrecognized option". sqlite3.c is the amalgamation from sqlite.org (3.53.4), unmodified.
let package = Package(
    name: "DgSQLite",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "DgSQLite", targets: ["DgSQLite"])
    ],
    targets: [
        .target(
            name: "DgSQLite",
            cSettings: [
                .define("SQLITE_ENABLE_FTS5"),
                .define("SQLITE_THREADSAFE", to: "2"),
                .define("SQLITE_DQS", to: "0"),
                .define("SQLITE_DEFAULT_MEMSTATUS", to: "0"),
                .define("SQLITE_OMIT_LOAD_EXTENSION"),
                .define("SQLITE_OMIT_DEPRECATED"),
                .define("SQLITE_OMIT_SHARED_CACHE"),
                .define("HAVE_ISNAN", to: "1")
            ]
        )
    ]
)
