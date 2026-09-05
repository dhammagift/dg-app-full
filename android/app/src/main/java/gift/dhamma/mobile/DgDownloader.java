package gift.dhamma.mobile;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;

/**
 * Hands the offline library's download to Android's DownloadManager instead of fetching it inside
 * the WebView.
 *
 * The WebView could already stream the file straight into OPFS, and still does when this plugin is
 * absent (a browser, the dev server). What it cannot do is survive the reader leaving: background
 * a WebView and Android throttles its timers and network, then reclaims the process under memory
 * pressure, and 170MB of progress goes with it. Notification permission does not change that — it
 * grants the right to SHOW something, not the right to keep running. Staying alive would mean a
 * foreground service, which is a lot of machinery to reimplement what the system already does.
 *
 * DownloadManager is that machinery. The download belongs to the system, so it continues while the
 * app is backgrounded or closed, it survives a reboot, it resumes after the connection drops
 * instead of starting 170MB over, and it draws its own progress in the notification shade for
 * free. Owner asked for the shade progress and for being able to minimise; this is both, without a
 * service of our own.
 *
 * What it costs: the file lands on disk first and is then imported into OPFS, so the peak is two
 * copies. The temporary one is deleted as soon as the import succeeds (see clear()), and it lives
 * in the app's own external files dir — no storage permission, and it goes away with the app.
 *
 * Progress is polled by the page rather than pushed from here. DownloadManager's own progress is a
 * cursor query, so a listener would be a timer on this side instead of that one, with a bridge
 * hop added; nothing is gained.
 */
@CapacitorPlugin(
    name = "DgDownloader",
    permissions = {
        // Only meaningful on API 33+. Without it the download still runs — Android simply does not
        // draw the notification, which costs the reader the progress they were promised, so it is
        // asked for before the first download rather than never.
        @Permission(alias = DgDownloader.NOTIFICATIONS, strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class DgDownloader extends Plugin {

    static final String NOTIFICATIONS = "notifications";
    private static final String FILE_NAME = "dg-mobile.db";

    /**
     * PluginCall.getLong() casts the bridged value to Long, and a JS number arrives through
     * org.json as an Integer — so the cast fails and returns null, and every status() call was
     * rejected with "id is required" while the download itself ran fine. Read the raw value and
     * widen it instead. A DownloadManager id can outgrow an int, so both widths are accepted, and
     * so is a string, which is what a caller reaches for after being bitten by this once.
     */
    private Long readId(PluginCall call) {
        Object raw = call.getData().opt("id");
        if (raw instanceof Number) return ((Number) raw).longValue();
        if (raw instanceof String) {
            try { return Long.parseLong(((String) raw).trim()); } catch (NumberFormatException e) { return null; }
        }
        return null;
    }

    /** DownloadManager.PAUSED_* constants have no name lookup of their own. */
    private static String pausedReasonName(int reason) {
        switch (reason) {
            case DownloadManager.PAUSED_WAITING_TO_RETRY: return "waiting to retry after an error";
            case DownloadManager.PAUSED_WAITING_FOR_NETWORK: return "waiting for network";
            case DownloadManager.PAUSED_QUEUED_FOR_WIFI: return "queued for Wi-Fi";
            case DownloadManager.PAUSED_UNKNOWN: return "unknown";
            default: return "code " + reason;
        }
    }

    /** DownloadManager.ERROR_* constants have no name lookup of their own. */
    private static String failureReasonName(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_CANNOT_RESUME: return "cannot resume";
            case DownloadManager.ERROR_DEVICE_NOT_FOUND: return "no storage found";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS: return "file already exists";
            case DownloadManager.ERROR_FILE_ERROR: return "file error";
            case DownloadManager.ERROR_HTTP_DATA_ERROR: return "HTTP data error";
            case DownloadManager.ERROR_INSUFFICIENT_SPACE: return "not enough storage space";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS: return "too many redirects";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE: return "unhandled HTTP code";
            case DownloadManager.ERROR_UNKNOWN: return "unknown";
            default: return "HTTP " + reason;
        }
    }

    private DownloadManager manager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    /**
     * Enqueues the download and returns its id. The id is what the page polls and, on a later
     * launch, what tells it a download it started earlier is still running.
     */
    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState(NOTIFICATIONS) != com.getcapacitor.PermissionState.GRANTED) {
            // Saved and resumed in the callback below, so the answer — either answer — is followed
            // by the download rather than replacing it.
            requestPermissionForAlias(NOTIFICATIONS, call, "afterNotificationPermission");
            return;
        }
        enqueue(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        // The result is deliberately not checked. A refused notification costs visibility, not the
        // download, and refusing to download because someone declined a notification would be
        // punishing them for an unrelated answer.
        enqueue(call);
    }

    private void enqueue(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        String title = call.getString("title", "Dhamma.gift");
        String description = call.getString("description", "Offline library");

        try {
            // A leftover from an earlier attempt would otherwise make DownloadManager write
            // dg-mobile-1.db beside it, and the page would import the wrong file.
            File target = new File(getContext().getExternalFilesDir(null), FILE_NAME);
            if (target.exists() && !target.delete()) {
                call.reject("could not clear the previous download at " + target.getAbsolutePath());
                return;
            }

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setTitle(title)
                .setDescription(description)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationInExternalFilesDir(getContext(), null, FILE_NAME)
                .setAllowedOverRoaming(false);
            // The reader has already been asked about mobile data by this point (or is on Wi-Fi),
            // so both transports are allowed here; the question belongs in the app's own dialog,
            // where it can state the size, not in a flag that silently refuses to start.
            request.setAllowedNetworkTypes(
                DownloadManager.Request.NETWORK_WIFI | DownloadManager.Request.NETWORK_MOBILE);

            long id = manager().enqueue(request);
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("could not start the download: " + e.getMessage(), e);
        }
    }

    /**
     * Where a download has got to. `state` is one of pending | running | paused | done | failed,
     * and on done it carries the path of the finished file so the page can hand it to the worker.
     */
    @PluginMethod
    public void status(PluginCall call) {
        Long id = readId(call);
        if (id == null) {
            call.reject("id is required");
            return;
        }
        Cursor cursor = null;
        try {
            cursor = manager().query(new DownloadManager.Query().setFilterById(id));
            JSObject result = new JSObject();
            if (cursor == null || !cursor.moveToFirst()) {
                // The entry is gone: cleared by us, or wiped with the system's own downloads. The
                // page treats this as "start again" rather than as an error.
                result.put("state", "missing");
                call.resolve(result);
                return;
            }

            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long loaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            result.put("loaded", loaded);
            // DownloadManager reports -1 until the server's length is known; the page draws an
            // indeterminate bar for that rather than a fabricated fraction.
            result.put("total", total < 0 ? 0 : total);

            switch (status) {
                case DownloadManager.STATUS_SUCCESSFUL: {
                    result.put("state", "done");
                    String local = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                    String path = local != null ? Uri.parse(local).getPath() : null;
                    if (path == null) {
                        result.put("state", "failed");
                        result.put("reason", "the download finished without a local path");
                    } else {
                        result.put("path", path);
                    }
                    break;
                }
                case DownloadManager.STATUS_FAILED: {
                    result.put("state", "failed");
                    int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    result.put("reason", "DownloadManager error " + reason + " (" + failureReasonName(reason) + ")");
                    break;
                }
                case DownloadManager.STATUS_PAUSED: {
                    result.put("state", "paused");
                    int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    result.put("reason", "paused: " + pausedReasonName(reason) + " (" + reason + ")");
                    break;
                }
                case DownloadManager.STATUS_PENDING:
                    result.put("state", "pending");
                    result.put("reason", "queued, not started yet");
                    break;
                default:
                    result.put("state", "running");
            }
            call.resolve(result);
        } catch (Exception e) {
            call.reject("could not read the download's status: " + e.getMessage(), e);
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    /**
     * Drops the DownloadManager entry and the file it wrote. Called once the bytes are safely in
     * OPFS — leaving them would mean carrying the library twice for the life of the install — and
     * also to abandon a failed attempt before starting another.
     */
    @PluginMethod
    public void clear(PluginCall call) {
        Long id = readId(call);
        try {
            if (id != null) manager().remove(id);
            File target = new File(getContext().getExternalFilesDir(null), FILE_NAME);
            if (target.exists()) target.delete();
            call.resolve();
        } catch (Exception e) {
            // Not fatal: this is cleanup, and failing it must not fail an import that worked.
            call.resolve();
        }
    }
}
