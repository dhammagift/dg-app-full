package gift.dhamma.uposatha;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * The page this app shows, kept up to date without a new APK.
 *
 * The APK carries a snapshot of the calendar page and everything it loads (www/, taken from the site at
 * build time), so the app opens with no network at all. This plugin is the other half: files the site has
 * changed since, which the page bridge (uposatha-bridge.js, updateSite) downloads when the phone is online
 * and hands over here:
 *
 *     Capacitor.Plugins.DgSite.put({ path: "/assets/js/uposatha-calendar.js", data: "<base64>" })
 *     Capacitor.Plugins.DgSite.list()   ->  { files: [ ... ] }
 *     Capacitor.Plugins.DgSite.clear()
 *
 * They are written under files/site/ and served by {@link #serve} in place of the bundled copy — the
 * next time the file is requested, which for the page itself is the next launch. Nothing here decides what
 * is stale: the bridge compares hashes; this only stores and serves.
 */
@CapacitorPlugin(name = "DgSite")
public class DgSitePlugin extends Plugin {

    private static final long MAX_BYTES = 8L * 1024 * 1024;   // no page asset is anywhere near this

    static File root(Context context) {
        return new File(context.getFilesDir(), "site");
    }

    /** A request path inside files/site/, or null when it would leave it. */
    static File resolve(Context context, String path) {
        if (path == null || !path.startsWith("/") || path.length() > 300 || path.indexOf('\0') >= 0) return null;
        try {
            File base = root(context).getCanonicalFile();
            File file = new File(base, path).getCanonicalFile();
            return file.getPath().startsWith(base.getPath() + File.separator) ? file : null;
        } catch (Exception e) {
            return null;
        }
    }

    @PluginMethod
    public void put(PluginCall call) {
        String path = call.getString("path");
        String data = call.getString("data");
        File file = resolve(getContext(), path);
        if (file == null || data == null) {
            call.reject("bad path or no data");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (bytes.length == 0 || bytes.length > MAX_BYTES) {
                call.reject("size out of range");
                return;
            }
            File dir = file.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) {
                call.reject("could not create the directory");
                return;
            }
            // Written beside and renamed: a request that arrives half-way must see the old file or the new
            // one, never half of either.
            File temp = new File(dir, file.getName() + ".part");
            try (FileOutputStream out = new FileOutputStream(temp)) {
                out.write(bytes);
            }
            if (!temp.renameTo(file)) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                call.reject("could not store the file");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("DgSite.put failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray files = new JSArray();
        collect(root(getContext()), "", files);
        JSObject out = new JSObject();
        out.put("files", files);
        call.resolve(out);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        deleteTree(root(getContext()));
        call.resolve();
    }

    private static void collect(File dir, String prefix, JSArray out) {
        File[] entries = dir.listFiles();
        if (entries == null) return;
        for (File f : entries) {
            if (f.isDirectory()) collect(f, prefix + "/" + f.getName(), out);
            else if (!f.getName().endsWith(".part")) out.put(prefix + "/" + f.getName());
        }
    }

    private static void deleteTree(File file) {
        File[] entries = file.listFiles();
        if (entries != null) for (File f : entries) deleteTree(f);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    // ---- serving ------------------------------------------------------------------------------

    // Where the page comes from: the same site as SITE_CONFIG in uposatha-bridge.js (test for now, dhamma.gift later).
    private static final String SITE = "https://test.dhamma.gift";
    private static final Map<String, String> TYPES = new HashMap<>();
    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "application/javascript");
        TYPES.put("mjs", "application/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("woff", "font/woff");
        TYPES.put("wasm", "application/wasm");
        TYPES.put("txt", "text/plain");
    }

    private static String typeOf(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase();
        String known = TYPES.get(ext);
        if (known != null) return known;
        String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return guessed == null ? "application/octet-stream" : guessed;
    }

    private static boolean hasAsset(Context context, String path) {
        try (InputStream in = context.getAssets().open("public" + path)) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static Map<String, String> defaultHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-cache");
        return headers;
    }

    private static InputStream injected(Bridge bridge, String path, InputStream stream) {
        // Capacitor puts its own script into the html it serves only on a WebView too old for document-start
        // scripts; the same call here keeps such a WebView working with a page served from here.
        if (path.endsWith(".html") && bridge != null && bridge.getLocalServer() != null) {
            return bridge.getLocalServer().getJavaScriptInjectedStream(stream);
        }
        return stream;
    }

    /**
     * The downloaded copy of a request's file, or null to let Capacitor serve the bundled one. The page
     * has more than one address (/, /index.html, /uposatha-calendar): all of them are its one HTML.
     */
    static WebResourceResponse serve(Context context, Bridge bridge, WebResourceRequest request) {
        if (!"GET".equals(request.getMethod())) return null;
        Uri uri = request.getUrl();
        if (!"localhost".equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null) return null;
        if (path.equals("/") || path.equals("/index.html") || path.equals("/uposatha-calendar") || path.equals("/uposatha-calendar/")) {
            path = "/uposatha-calendar.html";
        }
        File file = resolve(context, path);
        if (file == null || !file.isFile()) {
            // A file with an extension that neither was downloaded nor is bundled is the site's (and is asked for
            // there); an address without one is the page's own SPA fallback, Capacitor's.
            String last = path.substring(path.lastIndexOf('/') + 1);
            if (last.indexOf('.') > 0 && !path.startsWith("/_capacitor") && !hasAsset(context, path)) return proxy(context, bridge, request);
            return null;
        }
        try {
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-cache");
            InputStream stream = new FileInputStream(file);
            // Capacitor puts its own script into the html it serves only on a WebView too old for document-start
            // scripts; the same call here keeps such a WebView working with a downloaded page.
            if (path.endsWith(".html") && bridge != null && bridge.getLocalServer() != null) {
                stream = bridge.getLocalServer().getJavaScriptInjectedStream(stream);
            }
            return new WebResourceResponse(typeOf(path), "UTF-8", 200, "OK", headers, stream);
        } catch (Exception e) {
            return null;
        }
    }

    /** A file the bundle does not have (the page or a script asks for something the snapshot never saw): fetched from the site, offline answered with the app's "no connection" page. */
    private static WebResourceResponse proxy(Context context, Bridge bridge, WebResourceRequest request) {
        Uri uri = request.getUrl();
        HttpURLConnection connection = null;
        try {
            String target = SITE + uri.getEncodedPath() + (uri.getEncodedQuery() != null ? "?" + uri.getEncodedQuery() : "");
            connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(20000);
            connection.setInstanceFollowRedirects(true);
            for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
                String name = h.getKey();
                if (name.equalsIgnoreCase("User-Agent") || name.equalsIgnoreCase("Accept") || name.equalsIgnoreCase("Accept-Language")) {
                    connection.setRequestProperty(name, h.getValue());
                }
            }
            int status = connection.getResponseCode();
            String contentType = connection.getContentType();
            String mime = contentType == null ? "text/html" : contentType.split(";")[0].trim();
            String charset = "UTF-8";
            if (contentType != null) {
                for (String part : contentType.split(";")) {
                    part = part.trim();
                    if (part.toLowerCase().startsWith("charset=")) charset = part.substring(8).replace("\"", "");
                }
            }
            InputStream body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (body == null) body = new java.io.ByteArrayInputStream(new byte[0]);
            InputStream stream = "text/html".equals(mime) ? injected(bridge, "x.html", body) : body;
            // The connection is closed with the stream (HttpURLConnection releases it at end of stream).
            return new WebResourceResponse(mime, charset, status < 100 || (status >= 300 && status < 400) ? 200 : status,
                    status == 200 ? "OK" : "Site answer", defaultHeaders(), stream);
        } catch (Exception e) {
            if (connection != null) connection.disconnect();
            try {
                return new WebResourceResponse("text/html", "UTF-8", 503, "No connection", defaultHeaders(),
                        injected(bridge, "error.html", context.getAssets().open("public/error.html")));
            } catch (Exception inner) {
                return null;
            }
        }
    }
}
