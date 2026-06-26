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
        startGps();
        return START_STICKY; // restart if killed
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
                    == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                // Deliver callbacks on the main looper. (Do NOT call Looper.prepare() here —
                // onStartCommand already runs on the main thread, which has a looper; preparing
                // a second one throws RuntimeException and the service would crash on start.)
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000, 5, gpsListener, Looper.getMainLooper());
            }
        } catch (SecurityException e) { /* permission revoked — stop */ stopSelf(); }
    }

    private Notification buildNotification(String text) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Convoy")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
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
