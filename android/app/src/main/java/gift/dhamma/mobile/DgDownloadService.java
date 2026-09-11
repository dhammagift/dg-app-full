package gift.dhamma.mobile;

import android.app.Notification;
import android.app.Service;
import android.net.wifi.WifiManager;
import android.os.PowerManager;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;

/**
 * Keeps the process alive while the offline library is downloading, so the transfer the page
 * started actually finishes when the reader switches away or turns the screen off.
 *
 * Why a service and not just a notification: backgrounding the app is when Android starts treating
 * the WebView process as idle, and a 509MB download is minutes of work — the owner's report was
 * "свернута в нитку, там вообще нет процентов". A foreground service with an ongoing notification
 * is the platform's own answer to "this is still doing something the user asked for", and it is
 * exactly what the plan called for (docs/OFFLINE_PWA_PLAN.md: «уведомление о прогрессе» among the
 * five native items).
 *
 * The service owns no download logic and no timers: the page keeps transferring in its own worker
 * (WorkManager/DownloadManager cannot write to OPFS — see the plan), DgProgressPlugin pushes each
 * progress event in as an updated notification, and this class only holds the foreground slot.
 * Every failure to claim that slot is ignored on purpose: the download then simply runs with the
 * app in the background for as long as Android allows, which is what the app did before.
 */
public class DgDownloadService extends Service {

    static final String EXTRA_NOTIFICATION = "notification";
    static final int NOTIFICATION_ID = DgProgressPlugin.NOTIFICATION_ID;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = null;
        if (intent != null && Build.VERSION.SDK_INT >= 33) {
            notification = intent.getParcelableExtra(EXTRA_NOTIFICATION, Notification.class);
        } else if (intent != null) {
            //noinspection deprecation — the typed overload only exists from API 33.
            notification = intent.getParcelableExtra(EXTRA_NOTIFICATION);
        }
        if (notification == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            // The foreground slot alone keeps the PROCESS alive, not the CPU: with the screen off the
            // device suspends and the transfer stops mid-file (owner: "качает и со свёрнутым, но как
            // только выключается экран — останавливается"). A partial wake lock is the platform's
            // answer for exactly this: screen may go off, the CPU and the network read loop stay up.
            acquireLocks();
        } catch (Exception e) {
            // Foreground services are refused in a few states (permission revoked, background
            // start restrictions after the app was killed). Not fatal: the download continues.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dg:offline-download");
                // No timeout on purpose: the lock lives exactly as long as this service, and the
                // service is stopped by DgProgressPlugin.clear() when the download ends (finished,
                // cancelled, failed). A timed lock would silently expire under a slow connection.
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        }
        if (wifiLock == null) {
            // Keeps the Wi-Fi radio out of power save while the screen is off; without it a large
            // transfer on some devices stalls until the next packet the radio wakes for.
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                try {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "dg:offline-download");
                    wifiLock.setReferenceCounted(false);
                    wifiLock.acquire();
                } catch (Exception e) {
                    wifiLock = null; // not fatal: the download just runs on the normal radio policy
                }
            }
        }
    }

    private void releaseLocks() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception e) { /* already gone */ }
        wakeLock = null;
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception e) { /* already gone */ }
        wifiLock = null;
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
