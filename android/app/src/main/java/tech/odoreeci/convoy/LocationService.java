package tech.odoreeci.convoy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * Foreground location service: keeps high-accuracy GPS fixes flowing while the
 * app is backgrounded or the screen is off. Without this, Android throttles
 * location updates for background WebViews and the live rider feed / radar go
 * stale when the user isn't actively holding the phone.
 *
 * Emits the latest fix via a static callback the Capacitor plugin reads, so the
 * JS layer still owns all the map/UI logic — this service just keeps the GPS pipe open.
 */
public class LocationService extends Service {
    public static final String CHANNEL_ID = "convoy_location";
    public static final int NOTIF_ID = 0xC0FFEE; // unique notification id for the location foreground service

    // The plugin sets this before starting the service; the service pushes fixes back.
    public interface FixListener { void onFix(Location loc); }
    public static FixListener listener = null;

    private LocationManager lm;
    private LocationListener gpsListener;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
    }

    private void createChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Convoy location", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps your convoy position live in the background");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = buildNotification("Tracking your convoy position");
        // Android 10+ wants the foreground-service type at the call site; on 14+ (our
        // targetSdk 36) a typed FGS without it can be rejected. Manifest declares it too.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIF_ID, n);
        }
        // Nobody is listening — the app process died and Android relaunched a bare
        // service. Holding GPS at 2s intervals for a consumer that no longer exists
        // is pure battery drain (and, with POST_NOTIFICATIONS ungranted, invisible
        // drain). Shut down instead; the plugin restarts us when the app comes back.
        if (listener == null) { stopForeground(true); stopSelf(); return START_NOT_STICKY; }
        startGps();
        // NOT sticky: this service exists to feed the running app. START_STICKY
        // resurrected it after a swipe-away or a process kill with listener == null,
        // which is exactly the "background location with no user intent" pattern
        // Play's location policy targets.
        return START_NOT_STICKY;
    }

    /** Swipe the app away → stop tracking. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    private void startGps() {
        if (gpsListener != null) return;
        gpsListener = new LocationListener() {
            @Override public void onLocationChanged(Location loc) {
                if (listener != null) {
                    try { listener.onFix(loc); } catch (Exception e) { /* ignore */ }
                }
            }
            @Override public void onProviderEnabled(String p) {}
            @Override public void onProviderDisabled(String p) {}
            @Override public void onStatusChanged(String p, int s, Bundle e) {}
        };
        // High-accuracy, 2s min interval, 5m min distance. The WebView's own
        // watchPosition still runs; this just guarantees the OS keeps sampling.
        try {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) { stopSelf(); return; }
            // Pick the best provider(s). Android 12+ (API 31) exposes a FUSED provider
            // that blends GPS + network + sensors: it cold-starts in ~1s and keeps
            // delivering indoors / in tunnels / on emulators where raw GPS_PROVIDER
            // stays silent — which is exactly why the camera never followed the driver.
            // Older devices request GPS + NETWORK together so a fix arrives from
            // whichever locks first, instead of waiting on raw GPS alone.
            List<String> providers = new ArrayList<>();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                providers.add(LocationManager.FUSED_PROVIDER);
            } else {
                // Register even while a provider is disabled — that's legal, and updates
                // start flowing the moment the user re-enables location. Gating on
                // isProviderEnabled() here left the service registered with NOTHING when
                // location was off at start, and (gpsListener != null guard above) no
                // later call ever re-registered, so fixes never arrived.
                providers.add(LocationManager.GPS_PROVIDER);
                providers.add(LocationManager.NETWORK_PROVIDER);
            }
            Location seed = null;
            for (String prov : providers) {
                // Deliver callbacks on the main looper. (Do NOT call Looper.prepare() here —
                // onStartCommand already runs on the main thread, which has a looper; preparing
                // a second one throws RuntimeException and the service would crash on start.)
                try {
                    lm.requestLocationUpdates(prov, 2000, 5, gpsListener, Looper.getMainLooper());
                } catch (IllegalArgumentException e) { continue; } // provider absent on this device
                Location l = lm.getLastKnownLocation(prov);
                if (l != null && (seed == null || l.getTime() > seed.getTime())) seed = l;
            }
            // Push the last-known fix immediately so the map snaps to the driver on
            // launch instead of waiting up to ~30s for the first live update — but only
            // a RECENT one: a cached fix from hours ago (possibly another city) must not
            // be shown/broadcast as the rider's live position.
            long MAX_SEED_AGE_MS = 2 * 60 * 1000;
            if (seed != null && System.currentTimeMillis() - seed.getTime() > MAX_SEED_AGE_MS) seed = null;
            if (seed != null && listener != null) { try { listener.onFix(seed); } catch (Exception e) { /* ignore */ } }
        } catch (SecurityException e) { /* permission revoked — stop */ stopSelf(); }
    }

    private Notification buildNotification(String text) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Convoy")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_convoy)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    @Override
    public void onDestroy() {
        if (lm != null && gpsListener != null) {
            try { lm.removeUpdates(gpsListener); } catch (SecurityException e) { /* fine */ }
        }
        gpsListener = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
