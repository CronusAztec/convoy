package tech.odoreeci.convoy;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    public static final int REQ_NOTIF = 4002;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native plugins before the bridge initializes.
        registerPlugin(BackgroundLocationPlugin.class);
        registerPlugin(RadarDetectorPlugin.class);
        registerPlugin(SabrePlugin.class);
        registerPlugin(VoicePlugin.class);
        registerPlugin(AuthPlugin.class);
        registerPlugin(LiveUpdatePlugin.class);
        super.onCreate(savedInstanceState);

        // POST_NOTIFICATIONS (Android 13+). The location foreground service's
        // ongoing notification is suppressed without it — which means background
        // GPS running with no visible indicator, exactly what Play's location
        // policy exists to prevent. This one IS asked for at launch because the
        // background service starts at launch, so it is in context.
        // Asked at most TWICE, ever: Android 13+ silently auto-denies after two
        // refusals, and re-calling requestPermissions on every launch after that
        // just burned a permission cycle and logged. The preference records that
        // the rider has had their say; a user who changes their mind can grant it
        // in system settings (the settings UI links there on denial).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
            android.content.SharedPreferences sp = getSharedPreferences("convoy", MODE_PRIVATE);
            boolean askedBefore = sp.getBoolean("notif_asked", false);
            if (!askedBefore || ActivityCompat.shouldShowRequestPermissionRationale(this,
                    Manifest.permission.POST_NOTIFICATIONS)) {
                sp.edit().putBoolean("notif_asked", true).apply();
                ActivityCompat.requestPermissions(
                    this, new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIF);
            }
        }
    }

    // RECORD_AUDIO is NOT requested here any more — see VoicePlugin, which asks
    // for it on demand when the rider first opens voice chat.
}
