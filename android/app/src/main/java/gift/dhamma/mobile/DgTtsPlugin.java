package gift.dhamma.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Android's own TextToSpeech for the reader's voice player. Android System WebView has no
 * window.speechSynthesis, so read/js/voice.js (the site's player, unchanged) found nothing to
 * speak with and threw on its first call — no sound, and a close button that never closed.
 * src/tts.js installs a small speechSynthesis stand-in over this plugin.
 *
 *   speak({ id, text, lang, rate, voice })  -> resolves when queued; "tts" event {id, type:end|error}
 *   cancel()                                 -> stops; no event, like Web Speech after onend=null
 *   getVoices()                              -> { voices: [{ name, lang, localService }] }
 *
 * And the lock screen. voice.js already describes what is playing through navigator.mediaSession —
 * title, artwork, play/pause handlers — and in a browser that is all it takes. Android WebView has
 * never implemented that API (the Chromium issue is years old), so in the app those lines reached
 * nobody: the PWA showed a player on the lock screen and the app, built from the same code, showed
 * nothing. src/tts.js fills the gap with a stand-in that forwards to the methods below, so the site
 * keeps one player and this class owns the platform side of it:
 *
 *   setMediaMetadata({ title, artist, album, artwork }) -> what the lock screen shows
 *   setPlaybackState({ state })                         -> playing | paused | none (none tears it down)
 *   "media" event { action }                            -> play | pause | stop | previoustrack | nexttrack
 */
// POST_NOTIFICATIONS is declared here, not only in the manifest: since Android 13 the notification
// this plugin posts IS the controls, and an ungranted permission makes notify() a silent no-op —
// the reading plays and nothing appears anywhere, which is exactly how this looked on a device.
@CapacitorPlugin(name = "DgTts", permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class DgTtsPlugin extends Plugin implements TextToSpeech.OnInitListener {

    private static final String CHANNEL_ID = "dg_playback";
    private static final String ACTION_PREFIX = "gift.dhamma.mobile.MEDIA_";
    private static final int NOTIFICATION_ID = 0x64677474; // "dgtt"

    private TextToSpeech tts;
    private Boolean ready = null; // null until the engine has answered onInit
    private final List<Runnable> waiting = new ArrayList<>();

    private MediaSessionCompat session;
    private String title = "Dhamma.gift";
    private String artist = "";
    private Bitmap artwork;
    private AudioFocusRequest focusRequest;
    // Asked at most once per process. Android stops showing the dialog after two refusals anyway,
    // and a reader who said no should not be asked again every time they press play.
    private boolean askedNotifications;
    // null while nothing is posted; otherwise the state the posted notification was drawn for.
    private Boolean showing;

    private final BroadcastReceiver buttons = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String a = intent.getAction();
            if (a != null && a.startsWith(ACTION_PREFIX)) action(a.substring(ACTION_PREFIX.length()));
        }
    };

    @Override
    public void load() {
        IntentFilter filter = new IntentFilter();
        for (String a : new String[] { "play", "pause", "stop" }) filter.addAction(ACTION_PREFIX + a);
        ContextCompat.registerReceiver(getContext(), buttons, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        tts = new TextToSpeech(getContext(), this);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { emit(id, "end", null); }
            @Override public void onError(String id) { emit(id, "error", "synthesis failed"); }
            @Override public void onError(String id, int code) { emit(id, "error", "synthesis failed: " + code); }
        });
    }

    @Override
    public void onInit(int status) {
        synchronized (waiting) {
            ready = status == TextToSpeech.SUCCESS;
            for (Runnable r : waiting) r.run();
            waiting.clear();
        }
    }

    // Runs now if the engine is up, otherwise right after onInit (the first speak can arrive first).
    private void whenReady(PluginCall call, Runnable work) {
        synchronized (waiting) {
            if (ready == null) { waiting.add(() -> whenReady(call, work)); return; }
        }
        if (!ready) { call.reject("TextToSpeech is not available on this device"); return; }
        work.run();
    }

    private void emit(String id, String type, String error) {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("type", type);
        if (error != null) o.put("error", error);
        notifyListeners("tts", o);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        whenReady(call, () -> {
            String id = call.getString("id", "");
            String voiceName = call.getString("voice");
            String lang = call.getString("lang");
            Voice chosen = null;
            Set<Voice> voices = tts.getVoices();
            if (voiceName != null && voices != null) {
                for (Voice v : voices) if (v.getName().equals(voiceName)) chosen = v;
            }
            if (chosen != null) {
                tts.setVoice(chosen);
            } else if (lang != null && !lang.isEmpty()) {
                int r = tts.setLanguage(Locale.forLanguageTag(lang));
                // A rejection is what lets the player fall back to another language (pi-dev -> sa-IN -> ...).
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                    call.reject("language not supported: " + lang);
                    return;
                }
            }
            tts.setSpeechRate(call.getDouble("rate", 1.0).floatValue());
            if (tts.speak(call.getString("text", ""), TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.SUCCESS) {
                call.resolve();
            } else {
                call.reject("speak failed");
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        whenReady(call, () -> {
            JSArray list = new JSArray();
            Set<Voice> voices = tts.getVoices();
            if (voices != null) {
                for (Voice v : voices) {
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("lang", v.getLocale().toLanguageTag());
                    o.put("localService", !v.isNetworkConnectionRequired());
                    list.put(o);
                }
            }
            JSObject result = new JSObject();
            result.put("voices", list);
            call.resolve(result);
        });
    }

    // MARK: - the lock screen

    @PluginMethod
    public void setMediaMetadata(PluginCall call) {
        title = call.getString("title", "Dhamma.gift");
        artist = call.getString("artist", "");
        // The artwork voice.js names is a site path (/assets/img/albumart.png), and the same file
        // travels inside the APK under public/. Read it from there rather than over the WebView's
        // own scheme: the lock screen has to work with the network off.
        String art = call.getString("artwork");
        if (art != null && !art.isEmpty()) artwork = assetBitmap(art);
        getActivity().runOnUiThread(() -> {
            if (session != null) session.setMetadata(metadata());
            // And post it again if it is already up. voice.js sets playbackState BEFORE metadata,
            // so the first notification is always drawn with no title and no cover; older Androids
            // read the picture off the notification's own large icon rather than off the session,
            // and never learn about it otherwise. This is what puts our album art on the screen.
            if (showing != null) show(showing);
        });
        call.resolve();
    }

    @PluginMethod
    public void setPlaybackState(PluginCall call) {
        // The one honest moment to ask: the reader has just started a reading, and the permission
        // buys them the controls for it. Asking at launch would be a dialog about nothing.
        if (!"none".equals(call.getString("state", "none")) && needsNotificationPermission()) {
            askedNotifications = true;
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        applyPlaybackState(call);
    }

    // Granted or refused, the reading goes on — a refusal costs the controls, not the audio.
    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        applyPlaybackState(call);
    }

    private boolean needsNotificationPermission() {
        // Before Android 13 there is no such runtime permission, and asking for one that does not
        // exist answers DENIED forever.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false;
        if (askedNotifications) return false;
        return getPermissionState("notifications") != PermissionState.GRANTED;
    }

    private void applyPlaybackState(PluginCall call) {
        String state = call.getString("state", "none");
        getActivity().runOnUiThread(() -> {
            if ("none".equals(state)) { teardown(); return; }
            boolean playing = "playing".equals(state);
            ensureSession();
            if (playing) requestFocus(); else abandonFocus();
            session.setActive(true);
            session.setMetadata(metadata());
            session.setPlaybackState(new PlaybackStateCompat.Builder()
                    .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                            | PlaybackStateCompat.ACTION_STOP | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT)
                    .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                            PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                    .build());
            show(playing);
        });
        call.resolve();
    }

    private MediaMetadataCompat metadata() {
        MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist);
        if (artwork != null) b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        return b.build();
    }

    private Bitmap assetBitmap(String webPath) {
        String path = "public" + (webPath.startsWith("/") ? webPath : "/" + webPath);
        try (InputStream in = getContext().getAssets().open(path)) {
            return BitmapFactory.decodeStream(in);
        } catch (Exception e) {
            return null; // no picture is a cosmetic loss; the controls still work
        }
    }

    private void ensureSession() {
        if (session != null) return;
        session = new MediaSessionCompat(getContext(), "DgTts");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { action("play"); }
            @Override public void onPause() { action("pause"); }
            @Override public void onStop() { action("stop"); }
            @Override public void onSkipToPrevious() { action("previoustrack"); }
            @Override public void onSkipToNext() { action("nexttrack"); }
        });
    }

    // The buttons do not speak or stop anything here: voice.js knows what "pause" means for a text
    // being read in pieces, and it has already registered the handlers. This only carries the press.
    private void action(String name) {
        JSObject o = new JSObject();
        o.put("action", name);
        notifyListeners("media", o);
    }

    private void show(boolean playing) {
        Context ctx = getContext();
        channel(ctx);
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
                .setContentTitle(title)
                .setContentText(artist)
                .setLargeIcon(artwork)
                .setContentIntent(tap)
                .setOngoing(playing)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .addAction(playing
                        ? new NotificationCompat.Action(android.R.drawable.ic_media_pause, "Pause", button("pause"))
                        : new NotificationCompat.Action(android.R.drawable.ic_media_play, "Play", button("play")))
                .addAction(new NotificationCompat.Action(android.R.drawable.ic_menu_close_clear_cancel, "Stop",
                        button("stop")))
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1));
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, b.build());
            showing = playing;
        } catch (SecurityException e) {
            // Android 13+ without POST_NOTIFICATIONS: the lock screen controls are gone, the reading
            // is not. Nothing to recover from, and nothing worth failing a speak() over.
        }
    }

    // The buttons drawn on the lock screen are the system's own and arrive through the session
    // callback above. These are the ones in the notification itself, and they come back as a
    // broadcast to this plugin — androidx's MediaButtonReceiver would have wanted a media service,
    // which this app has no other reason to own.
    private PendingIntent button(String action) {
        Intent i = new Intent(ACTION_PREFIX + action).setPackage(getContext().getPackageName());
        return PendingIntent.getBroadcast(getContext(), action.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void channel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = ctx.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel c = new NotificationChannel(CHANNEL_ID, "Reading aloud", NotificationManager.IMPORTANCE_LOW);
        c.setDescription("Controls for the text being read aloud");
        c.setShowBadge(false);
        manager.createNotificationChannel(c);
    }

    // Ducking, not pausing: a TTS reading is speech, and the system handles the mixing. Transient
    // loss (a call, a notification) is left to Android's own behaviour rather than second-guessed.
    private void requestFocus() {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build())
                        .build();
            }
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
    }

    private void abandonFocus() {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
        } else {
            am.abandonAudioFocus(null);
        }
    }

    private void teardown() {
        abandonFocus();
        showing = null;
        NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        try { getContext().unregisterReceiver(buttons); } catch (Exception ignored) { }
        teardown();
        if (tts != null) tts.shutdown();
    }
}
