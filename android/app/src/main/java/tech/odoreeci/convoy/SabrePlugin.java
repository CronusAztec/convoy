package tech.odoreeci.convoy;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Capacitor plugin: SABRE crowd-source bridge.
 *
 * SABRE (https://sabre.app/tech) is an Android inter-app protocol for exchanging
 * crowd-sourced police/hazard alerts. A SABRE *host* app (e.g. Highway Radar) talks
 * to a *proxy* app via explicit broadcasts on a package-prefix channel. A web app
 * can't send/receive Android broadcasts — but this native plugin can, so Convoy can
 * receive alerts published by any installed SABRE host on the device.
 *
 * The plugin registers a BroadcastReceiver for the SABRE action + categories and
 * relays each received alert to JS as a "crowd" event with the host's payload.
 * To publish (report) an alert back, we send an explicit broadcast to the host.
 *
 * No alert data is invented: if no host app is installed, no events arrive and
 * publish() silently finds no receiver — matching the real protocol.
 */
@CapacitorPlugin(name = "Sabre")
public class SabrePlugin extends Plugin {

    // SABRE v1.x action and categories (per sabre.app/tech).
    private static final String ACTION_SABRE = "app.sabre.CROWD";
    private static final String CAT_HOST = "app.sabre.HOST";
    private static final String CAT_PROXY = "app.sabre.PROXY";
    private static final String EXTRA_PAYLOAD = "payload";

    private BroadcastReceiver rx;
    private boolean registered = false;

    @PluginMethod
    public void startListening(PluginCall call) {
        if (registered) { call.resolve(); return; }
        rx = new BroadcastReceiver() {
            @Override public void onReceive(Context ctx, Intent intent) {
                if (intent == null) return;
                Bundle extras = intent.getExtras();
                JSObject o = new JSObject();
                if (extras != null && extras.containsKey(EXTRA_PAYLOAD)) {
                    // Payloads are JSON strings per the SABRE spec.
                    String raw = extras.getString(EXTRA_PAYLOAD);
                    try { o.put("payload", new JSONObject(raw)); }
                    catch (JSONException je) { o.put("payload", raw); }
                }
                o.put("action", intent.getAction());
                notifyListeners("crowd", o);
            }
        };
        try {
            IntentFilter filter = new IntentFilter(ACTION_SABRE);
            filter.addCategory(CAT_PROXY);   // we are the proxy side of the protocol
            // Android 13+ requires an explicit export flag. This receiver exists to
            // hear broadcasts from a SEPARATE app (the SABRE host), so it must be
            // EXPORTED — RECEIVER_NOT_EXPORTED means "same-app broadcasts only" and
            // silently killed the entire feature on every device at API 33+.
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                getContext().registerReceiver(rx, filter, Context.RECEIVER_EXPORTED);
            } else {
                getContext().registerReceiver(rx, filter);
            }
            registered = true;
            call.resolve(new JSObject().put("listening", true));
        } catch (Exception e) {
            call.reject("Could not register SABRE receiver: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        if (registered) {
            try { getContext().unregisterReceiver(rx); } catch (Exception e) { /* fine */ }
            registered = false;
        }
        call.resolve(new JSObject().put("listening", false));
    }

    // Publish a crowd report (police/hazard) to any installed SABRE host.
    // The host decides whether/where to forward it; if none is installed, this is a no-op.
    @PluginMethod
    public void publish(PluginCall call) {
        JSObject payload = call.getObject("payload", new JSObject());
        Intent i = new Intent(ACTION_SABRE);
        i.addCategory(CAT_HOST);
        i.putExtra(EXTRA_PAYLOAD, payload.toString());
        // Explicit broadcast to SABRE-host packages only — no recipients ⇒ no-op (matches spec).
        android.content.pm.PackageManager pm = getContext().getPackageManager();
        for (android.content.pm.ResolveInfo r : pm.queryBroadcastReceivers(
                new Intent(ACTION_SABRE).addCategory(CAT_HOST), 0)) {
            if (r.activityInfo != null) {
                i.setPackage(r.activityInfo.packageName);
                getContext().sendBroadcast(i);
            }
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (registered) {
            try { getContext().unregisterReceiver(rx); } catch (Exception e) { /* fine */ }
            registered = false;
        }
    }
}
