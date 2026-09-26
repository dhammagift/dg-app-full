package gift.dhamma.uposatha;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.TileService;

/**
 * Uposatha in the Quick Settings shade, as the dictionary and the reader have: one tap from inside
 * any app. It carries no logic: the tap starts MainActivity with the same "route" extra a launcher
 * shortcut uses, and MainActivity loads it, so the tile, a shortcut and a shared link share one path.
 *
 * The tile is invisible until the reader adds it (pull the shade down, edit the tiles, drag
 * "Uposatha" into the panel): Android's rule for every app.
 */
public class DgTileService extends TileService {

    private static final String ROUTE = "/uposatha-calendar?app=1";

    @Override
    @SuppressWarnings("deprecation") // startActivityAndCollapse(Intent) below API 34
    public void onClick() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.putExtra("route", ROUTE);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // The PendingIntent form is the supported one from API 34.
            PendingIntent pending = PendingIntent.getActivity(this, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            startActivityAndCollapse(pending);
        } else {
            startActivityAndCollapse(intent);
        }
    }
}
