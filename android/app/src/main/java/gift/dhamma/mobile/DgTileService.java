package gift.dhamma.mobile;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.TileService;

/**
 * The Quick Settings tile — Android's answer to the Control Center button on iOS: Dhamma.gift in
 * the shade, one tap from anywhere, offline, with no Assistant/Gemini in between.
 *
 * It carries no logic of its own. The tap builds the same Intent the dynamic shortcuts use (the
 * "route" extra MainActivity.handleIntent already turns into
 * https://localhost/?_nativeRoute=…), so the tile, the launcher shortcuts and a shared link all
 * arrive through one path and there is no second router to keep in step.
 *
 * The tile is invisible until the reader adds it: pull the shade down, edit the tiles, drag
 * "Dhamma.gift" into the panel. That is Android's rule for every app, not something we can skip.
 */
public class DgTileService extends TileService {

    // What the tile opens. Empty = the app's own start page, i.e. exactly what the launcher icon
    // does. "/4as" would land on Favorites & History instead — one line, one decision.
    private static final String ROUTE = "";

    @Override
    @SuppressWarnings("deprecation") // startActivityAndCollapse(Intent) below API 34
    public void onClick() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (!ROUTE.isEmpty()) {
            intent.putExtra("route", ROUTE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34 deprecated the Intent overload; the PendingIntent form is the supported one
            // there (and is what a tile must use to be allowed to start an activity at all).
            PendingIntent pending = PendingIntent.getActivity(this, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            startActivityAndCollapse(pending);
        } else {
            startActivityAndCollapse(intent);
        }
    }
}
