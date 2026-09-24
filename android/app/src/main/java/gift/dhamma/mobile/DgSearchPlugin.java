package gift.dhamma.mobile;

import android.app.appsearch.AppSearchManager;
import android.app.appsearch.AppSearchResult;
import android.app.appsearch.AppSearchSchema;
import android.app.appsearch.AppSearchSession;
import android.app.appsearch.GenericDocument;
import android.app.appsearch.PutDocumentsRequest;
import android.app.appsearch.RemoveByDocumentIdRequest;
import android.app.appsearch.SearchResult;
import android.app.appsearch.SearchResults;
import android.app.appsearch.SearchSpec;
import android.app.appsearch.SetSchemaRequest;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

/**
 * OS-level search: the library's metadata goes into Android's own AppSearch, so a sutta can be
 * found from the phone's search and opened without going through the app first.
 *
 * Metadata only, deliberately (docs/OS_SEARCH.md): id, title, a folded title, category, one
 * snippet line and the public URL. Full texts stay in dg.db — indexing them would duplicate 612MB
 * into a system index for nothing, and the app already has real full-text search offline.
 *
 * Platform AppSearch, not androidx: android.app.appsearch has been public API since Android 12 and
 * is already on the device, so this costs the APK zero bytes. The androidx backport would work on
 * older releases, but it ships AndroidX's own native index — several MB per ABI — and pre-12 phones
 * keep the dynamic shortcuts they already have. Below API 31 every method resolves with
 * available=false instead of failing.
 *
 * setSchemaTypeDisplayedBySystem is the "global search" flag from the task: the schema type is
 * allowed to be shown by the system's own search surface (the launcher), not only queried by us.
 * Whether a given launcher actually renders it is the launcher's decision — that is exactly what a
 * device check has to answer, which is why query() exists here: it proves the index and the
 * documents from inside the app, independently of any launcher.
 */
@CapacitorPlugin(name = "DgSearch")
public class DgSearchPlugin extends Plugin {

    private static final String DB_NAME = "dhamma_search";
    private static final String SCHEMA_TYPE = "DhammaSutta";
    // AppSearch has a binder transaction limit, so documents go in chunks rather than one request.
    private static final int BATCH = 200;

    private Executor executor;
    private Executor getExecutor() {
        if (executor == null) executor = ContextCompat.getMainExecutor(getContext());
        return executor;
    }

    private static boolean supported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", supported());
        result.put("api", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    /**
     * Replaces the index with the given items.
     * call: { items: [ { id, title, titleFolded, category, snippet, url } ] }
     */
    @PluginMethod
    public void index(PluginCall call) {
        if (!supported()) {
            JSObject result = new JSObject();
            result.put("available", false);
            result.put("count", 0);
            call.resolve(result);
            return;
        }
        JSArray items = call.getArray("items");
        if (items == null) {
            call.reject("items missing");
            return;
        }
        indexItems(items, new IndexResult() {
            @Override
            public void done(int count) {
                JSObject result = new JSObject();
                result.put("available", true);
                result.put("count", count);
                call.resolve(result);
            }

            @Override
            public void fail(String message) {
                call.reject(message);
            }
        });
    }

    // ponytail: spike-only seed (docs/OS_SEARCH.md). Six real texts so the device check can answer
    // "does the phone's own search show our index at all" before any dg.db plumbing exists. Delete
    // this and the six rows go with it (clear()), once the launcher question is answered.
    private static final boolean SPIKE_SEED = true;

    @Override
    public void load() {
        if (!SPIKE_SEED || !supported()) return;
        String[][] seed = {
                {"mn1", "Mūlapariyāyasutta"},
                {"mn5", "Anaṅgaṇasutta"},
                {"mn10", "Satipaṭṭhānasutta"},
                {"dn22", "Mahāsatipaṭṭhānasutta"},
                {"sn56.11", "Dhammacakkappavattanasutta"},
                {"an3.1", "Bālasutta"},
        };
        JSArray items = new JSArray();
        for (String[] row : seed) {
            JSObject item = new JSObject();
            item.put("id", row[0]);
            item.put("title", row[1]);
            item.put("titleFolded", fold(row[1]));
            item.put("category", "spike");
            item.put("snippet", row[1] + " — " + row[0]);
            item.put("url", "https://dhamma.gift/" + row[0]);
            items.put(item);
        }
        indexItems(items, new IndexResult() {
            @Override
            public void done(int count) {
                android.util.Log.i("DgSearch", "spike seed indexed: " + count);
            }

            @Override
            public void fail(String message) {
                android.util.Log.w("DgSearch", "spike seed failed: " + message);
            }
        });
    }

    private interface IndexResult {
        void done(int count);
        void fail(String message);
    }

    private void indexItems(JSArray items, IndexResult out) {
        final List<GenericDocument> documents = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item;
            try {
                item = items.getJSONObject(i);
            } catch (Exception e) {
                continue;
            }
            String id = item.optString("id", "");
            if (id.isEmpty()) continue;
            GenericDocument.Builder<?> doc = new GenericDocument.Builder<>(NAMESPACE, id, SCHEMA_TYPE)
                    .setPropertyString("id", id)
                    .setPropertyString("title", item.optString("title", id))
                    .setPropertyString("snippet", item.optString("snippet", ""))
                    .setPropertyString("category", item.optString("category", ""))
                    .setPropertyString("url", item.optString("url", "https://dhamma.gift/" + id));
            String folded = item.optString("titleFolded", "");
            if (!folded.isEmpty()) doc.setPropertyString("titleFolded", folded);
            documents.add(doc.build());
        }

        withSession(out::fail, session -> session.setSchema(schemaRequest(), getExecutor(), getExecutor(),
                schemaResult -> {
                    if (!schemaResult.isSuccess()) {
                        out.fail("setSchema failed: " + schemaResult.getErrorMessage());
                        return;
                    }
                    putBatch(out, session, documents, 0, 0);
                }));
    }

    /** Plain-ASCII copy for the OS tokenizers that will not fold diacritics themselves. */
    private static String fold(String text) {
        return java.text.Normalizer.normalize(
                        java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFD)
                                .replaceAll("\\p{M}+", ""),
                        java.text.Normalizer.Form.NFC)
                .replace('’', '\'');
    }

    /** Queries our own index — the proof that documents are there, with no launcher involved. */
    @PluginMethod
    public void query(PluginCall call) {
        if (!supported()) {
            JSObject result = new JSObject();
            result.put("available", false);
            result.put("items", new JSArray());
            call.resolve(result);
            return;
        }
        String term = call.getString("q", "");
        Integer limitArg = call.getInt("limit");
        final int limit = limitArg == null ? 20 : limitArg;

        SearchSpec spec = new SearchSpec.Builder()
                .addFilterSchemas(SCHEMA_TYPE)
                .setTermMatch(SearchSpec.TERM_MATCH_PREFIX)
                .setRankingStrategy(SearchSpec.RANKING_STRATEGY_RELEVANCE_SCORE)
                .setResultCountPerPage(limit)
                .setSnippetCount(1)
                .setSnippetCountPerProperty(1)
                .setMaxSnippetSize(160)
                .build();

        withSession(message -> call.reject(message), session -> {
            SearchResults results = session.search(term, spec);
            results.getNextPage(getExecutor(), page -> {
                if (!page.isSuccess()) {
                    call.reject("search failed: " + page.getErrorMessage());
                    return;
                }
                JSArray out = new JSArray();
                for (SearchResult r : page.getResultValue()) {
                    GenericDocument doc = r.getGenericDocument();
                    JSObject item = new JSObject();
                    item.put("id", doc.getPropertyString("id"));
                    item.put("title", doc.getPropertyString("title"));
                    item.put("category", doc.getPropertyString("category"));
                    item.put("url", doc.getPropertyString("url"));
                    String snippet = doc.getPropertyString("snippet");
                    if (snippet != null && !snippet.isEmpty()) item.put("snippet", snippet);
                    out.put(item);
                }
                JSObject result = new JSObject();
                result.put("available", true);
                result.put("items", out);
                call.resolve(result);
            });
        });
    }

    /** Everything we indexed, gone — used when the library's build_id changes. */
    @PluginMethod
    public void clear(PluginCall call) {
        if (!supported()) {
            call.resolve();
            return;
        }
        withSession(message -> call.reject(message), session -> {
            SearchSpec all = new SearchSpec.Builder().addFilterSchemas(SCHEMA_TYPE).build();
            session.remove("", all, getExecutor(), result -> {
                if (!result.isSuccess()) {
                    call.reject("clear failed: " + result.getErrorMessage());
                    return;
                }
                JSObject out = new JSObject();
                out.put("cleared", true);
                call.resolve(out);
            });
        });
    }

    // -----------------------------------------------------------------------------------------

    private static final String NAMESPACE = "sutta";

    private interface SessionUser {
        void use(AppSearchSession session);
    }

    private void withSession(java.util.function.Consumer<String> onFail, SessionUser user) {
        AppSearchManager manager = getContext().getSystemService(AppSearchManager.class);
        if (manager == null) {
            onFail.accept("AppSearch is not available on this device");
            return;
        }
        AppSearchManager.SearchContext context =
                new AppSearchManager.SearchContext.Builder(DB_NAME).build();
        manager.createSearchSession(context, getExecutor(),
                result -> {
                    if (!result.isSuccess()) {
                        onFail.accept("createSearchSession failed: " + result.getErrorMessage());
                        return;
                    }
                    user.use(result.getResultValue());
                });
    }

    private SetSchemaRequest schemaRequest() {
        AppSearchSchema schema = new AppSearchSchema.Builder(SCHEMA_TYPE)
                .addProperty(stringProperty("id", true))
                .addProperty(stringProperty("title", true))
                .addProperty(stringProperty("titleFolded", true))
                .addProperty(stringProperty("category", true))
                .addProperty(stringProperty("snippet", true))
                .addProperty(stringProperty("url", false))
                .build();
        return new SetSchemaRequest.Builder()
                .addSchemas(schema)
                // The "available to the device's search" flag: without it the type exists but no
                // system surface is allowed to show it.
                .setSchemaTypeDisplayedBySystem(SCHEMA_TYPE, true)
                .build();
    }

    private AppSearchSchema.StringPropertyConfig stringProperty(String name, boolean indexed) {
        return new AppSearchSchema.StringPropertyConfig.Builder(name)
                .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL)
                .setIndexingType(indexed
                        ? AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES
                        : AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_NONE)
                .setTokenizerType(AppSearchSchema.StringPropertyConfig.TOKENIZER_TYPE_PLAIN)
                .build();
    }

    private void putBatch(IndexResult out, AppSearchSession session, List<GenericDocument> documents,
                          int from, int stored) {
        if (from >= documents.size()) {
            out.done(stored);
            return;
        }
        int to = Math.min(from + BATCH, documents.size());
        PutDocumentsRequest request = new PutDocumentsRequest.Builder()
                .addGenericDocuments(documents.subList(from, to))
                .build();
        session.put(request, getExecutor(), batch -> {
            int ok = batch.getSuccesses() == null ? 0 : batch.getSuccesses().size();
            if (batch.getFailures() != null && !batch.getFailures().isEmpty()) {
                AppSearchResult<Void> first = batch.getFailures().values().iterator().next();
                out.fail("put failed: " + first.getErrorMessage());
                return;
            }
            putBatch(out, session, documents, to, stored + ok);
        });
    }

    /** Kept for the follow-up (a real re-index removes ids the new library no longer has). */
    @SuppressWarnings("unused")
    private void removeByIds(AppSearchSession session, List<String> ids) {
        if (ids.isEmpty()) return;
        session.remove(new RemoveByDocumentIdRequest.Builder(NAMESPACE).addIds(ids).build(),
                getExecutor(), batch -> { });
    }
}
