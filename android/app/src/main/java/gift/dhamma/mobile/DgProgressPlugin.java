package gift.dhamma.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Download progress in the status bar — the one thing the reader loses by backgrounding the app,
 * and the reason docs/OFFLINE_PWA_PLAN.md lists notifications among the five native items.
 *
 * The page already knows everything: dg-node's offline layer emits `dg:dl-progress` with
 * loaded/total/phase every ~200ms while the 509MB library crosses the connection
 * (public/offline/db-worker.js). Native cannot see that or WebView's console, so native-bridge.js
 * forwards each event here and this plugin mirrors it into an ONGOING notification with a real
 * progress bar. Nothing here downloads anything: the transfer still runs in the page's own worker
 * (workmanager cannot write OPFS — see the plan), so this is informational: with the app in the
 * background the reader at least sees that it is still moving, and Android is far less likely to
 * treat the process as idle.
 *
 * Android 13+ needs POST_NOTIFICATIONS at runtime; a denial is not an error (the app works, the
 * notification is simply absent), so every method resolves instead of rejecting.
 */
@CapacitorPlugin(
        name = "DgProgress",
        permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class DgProgressPlugin extends Plugin {

    private static final String CHANNEL_ID = "dg_download_v2";
    static final int NOTIFICATION_ID = 4711;
    // Asked once per process: one prompt, not one per progress event.
    private boolean notificationsAsked = false;

    @PluginMethod
    public void update(PluginCall call) {
        // Post FIRST, ask second. The old order returned as soon as the permission was missing, so
        // the very progress event that triggered the dialog was swallowed and nothing appeared
        // until the next one — and if the reader granted the permission and then backgrounded the
        // app (exactly what someone does while a 509MB download runs), not a single notification
        // had been posted yet: "попросила доступ к нотификациям, но прогресс в трее не показывает"
        // (owner). Posting is harmless without the permission — the platform drops it — so this
        // tries on every event, which also recovers the moment the reader allows it.
        post(call);
        if (Build.VERSION.SDK_INT >= 33
                && !notificationsAsked
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            // One prompt, on the first progress event (i.e. right after the reader agreed to the
            // download). Permission prompts that appear before anything is happening are the ones
            // people refuse.
            notificationsAsked = true;
            requestPermissionForAlias("notifications", call, "afterPermission");
        }
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        post(call);
    }

    private void post(PluginCall call) {
        Context context = getContext();
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            call.resolve();
            return;
        }
        ensureChannel(manager);

        int percent = call.getInt("percent", -1);
        String text = call.getString("text", "");
        String title = call.getString("title", "Dhamma.gift");

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(context, 0, open, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                // DEFAULT, not LOW: a LOW-importance channel lands in the shade's collapsed
                // "Silent notifications" section, which is where the owner looked and did not find
                // it. setSilent keeps it from making a sound on every update, which was the actual
                // reason for LOW.
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setSilent(true);
        if (Build.VERSION.SDK_INT >= 31) {
            // Without this Android may defer a foreground-service notification for ~10 seconds,
            // which reads as "the app shows no progress" on a download that is already running.
            builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        }

        if (percent >= 0) {
            builder.setProgress(100, Math.min(100, percent), false);
            builder.setSubText(percent + "%");
        } else {
            // No fraction yet (before Content-Length is known, or while the file is being opened):
            // an indeterminate bar, the same thing the page's own card shows.
            builder.setProgress(0, 0, true);
        }

        Notification built = builder.build();
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, built);
            // Claim the foreground slot with the same notification, so the WebView process is not
            // treated as idle while 509MB are still crossing the connection. Starting it on every
            // update is harmless (onStartCommand just re-posts) and means no separate "download
            // started" signal is needed from the page — the first progress event is that signal.
            Intent service = new Intent(context, DgDownloadService.class);
            service.putExtra(DgDownloadService.EXTRA_NOTIFICATION, built);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
            else context.startService(service);
            JSObject result = new JSObject();
            result.put("shown", true);
            call.resolve(result);
        } catch (Exception e) {
            // Permission revoked between the check and the post, or background-start restrictions:
            // the in-page card still shows progress, so this is not a failure.
            call.resolve();
        }
    }

    /** The download stopped being interesting: finished, cancelled, or failed. */
    @PluginMethod
    public void clear(PluginCall call) {
        try {
            NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);
        } catch (Exception e) {
            // Nothing to cancel is not a problem.
        }
        try {
            getContext().stopService(new Intent(getContext(), DgDownloadService.class));
        } catch (Exception e) {
            // Already stopped.
        }
        call.resolve();
    }

    private void ensureChannel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < 26) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Offline library download",
                // DEFAULT so the notification sits in the normal shade section (LOW put it under
                // "Silent notifications", where it was not found); the updates themselves stay
                // silent via setSilent/setOnlyAlertOnce, which is what LOW was really for.
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Progress of the offline library download");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    /** Kept for the permission dialog's own bookkeeping (unused variables otherwise). */
    @SuppressWarnings("unused")
    private boolean hasNotificationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }
}
