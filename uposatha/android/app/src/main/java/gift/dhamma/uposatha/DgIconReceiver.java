package gift.dhamma.uposatha;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Puts the launcher icon of the phase in force on: when the next one is due, after a reboot, and after an update. */
public class DgIconReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        DgIconPlugin.apply(context);
    }
}
