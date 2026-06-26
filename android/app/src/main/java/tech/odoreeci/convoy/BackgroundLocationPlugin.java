package tech.odoreeci.convoy;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import androidx.core.content.ContextCompat;

/**
 * Capacitor plugin: background location. Lets JS start a foreground service that
 * keeps high-accuracy GPS flowing while the app is backgrounded, and streams each
 * fix back as a "fix" event. JS owns all map/UI logic; this just keeps the pipe open.
 *
 * Requires ACCESS_FINE_LOCATION + (Android 14+) FOREGROUND_LOCATION_SPECIAL.
 * The permission dance runs before the service is started.
 */
@CapacitorPlugin(name = "BackgroundLocation",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "location"),
        @Permission(strings = { Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "coarse")
    })
public class BackgroundLocationPlugin extends Plugin {

    private boolean running = false;

    @Override
    public void load() {
        // Pipe service fixes straight to JS as events.
        LocationService.listener = new LocationService.FixListener() {
            @Override public void onFix(Location loc) {
                JSObject o = new JSObject();
                o.put("lat", loc.getLatitude());
                o.put("lng", loc.getLongitude());
                o.put("accuracy", loc.getAccuracy());
                o.put("speed", loc.hasSpeed() ? loc.getSpeed() : -1);
                o.put("bearing", loc.hasBearing() ? loc.getBearing() : 0);
                o.put("time", loc.getTime());
                notifyListeners("fix", o);
            }
        };
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (running) { call.resolve(); return; }
        if (!hasFineLocation()) {
            requestPermissionForAlias("location", call, "permCallback");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (!hasFineLocation()) {
            call.reject("Location permission denied");
            return;
        }
        begin(call);
    }

    private void begin(PluginCall call) {
        try {
            Intent i = new Intent(getContext(), LocationService.class);
            ContextCompat.startForegroundService(getContext(), i);
            running = true;
            call.resolve(new JSObject().put("running", true));
        } catch (Exception e) {
            call.reject("Could not start location service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), LocationService.class));
        } catch (Exception e) { /* fine */ }
        running = false;
        call.resolve(new JSObject().put("running", false));
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        call.resolve(new JSObject().put("running", running));
    }

    private boolean hasFineLocation() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }
}
