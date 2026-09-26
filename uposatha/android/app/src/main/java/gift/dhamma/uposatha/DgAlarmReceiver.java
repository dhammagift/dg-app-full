package gift.dhamma.uposatha;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Plays a reminder's sound on the ALARM stream (see DgAlarmPlugin), and re-sets the reminders after a reboot.
 *
 * The receiver stays alive for the sound through goAsync() and a partial wake lock; the sound is cut after 20 seconds
 * (a gong is a few seconds, a long picked file is not meant to play to its end), and it is not played when the
 * alarm volume is 0: the reader's own setting decides how loud a reminder is.
 */
public class DgAlarmReceiver extends BroadcastReceiver {

    private static final long MAX_MS = 20000;

    @Override
    public void onReceive(final Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            DgAlarmPlugin.restore(context);
            return;
        }
        if (!DgAlarmPlugin.ACTION_PLAY.equals(action)) return;
        final String sound = intent.getStringExtra("sound");
        if (sound == null || sound.isEmpty()) return;

        final PendingResult result = goAsync();
        final PowerManager.WakeLock wake = context.getSystemService(PowerManager.class)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dg:reminder-sound");
        wake.acquire(MAX_MS + 5000);
        final AudioManager audio = context.getSystemService(AudioManager.class);
        final Handler handler = new Handler(Looper.getMainLooper());
        final MediaPlayer[] player = new MediaPlayer[1];
        final AudioFocusRequest[] focus = new AudioFocusRequest[1];
        final boolean[] done = { false };
        final Runnable finish = new Runnable() {
            @Override
            public void run() {
                if (done[0]) return;
                done[0] = true;
                try { if (player[0] != null) { player[0].stop(); player[0].release(); } } catch (Exception e) { /* already gone */ }
                if (focus[0] != null && audio != null) audio.abandonAudioFocusRequest(focus[0]);
                if (wake.isHeld()) wake.release();
                result.finish();
            }
        };
        try {
            if (audio != null && audio.getStreamVolume(AudioManager.STREAM_ALARM) == 0) {
                finish.run();   // the reader turned the alarm volume to nothing: that is an answer
                return;
            }
            Uri uri = uriOf(context, sound);
            if (uri == null) {
                finish.run();
                return;
            }
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            if (audio != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focus[0] = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(attributes).build();
                audio.requestAudioFocus(focus[0]);
            }
            MediaPlayer mp = new MediaPlayer();
            player[0] = mp;
            mp.setAudioAttributes(attributes);
            mp.setDataSource(context, uri);
            mp.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer m) { handler.post(finish); }
            });
            mp.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(MediaPlayer m, int what, int extra) { handler.post(finish); return true; }
            });
            mp.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer m) { m.start(); }
            });
            mp.prepareAsync();
            handler.postDelayed(finish, MAX_MS);
        } catch (Exception e) {
            finish.run();
        }
    }

    /** A res/raw file by name, or the reader's own file (its address is kept by DgSoundPlugin). */
    private static Uri uriOf(Context context, String sound) {
        if ("own".equals(sound)) {
            SharedPreferences prefs = context.getSharedPreferences(DgSoundPlugin.PREFS, Context.MODE_PRIVATE);
            String own = prefs.getString("own_uri", null);
            return own == null ? null : Uri.parse(own);
        }
        int res = context.getResources().getIdentifier(sound, "raw", context.getPackageName());
        return res == 0 ? null : Uri.parse("android.resource://" + context.getPackageName() + "/" + res);
    }
}
