package tech.odoreeci.convoy;

import android.Manifest;
import android.content.pm.PackageManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Capacitor plugin: microphone permission for the walkie-talkie.
 *
 * The Android WebView will only grant a getUserMedia() request once the app
 * already holds the RECORD_AUDIO runtime permission, so something native has to
 * ask first. That used to happen unconditionally in MainActivity.onCreate —
 * a mic prompt on a cold launch, before the map had drawn, with nothing on
 * screen explaining why. Play flags permission requests made outside the flow
 * that needs them, and an unexplained prompt gets denied far more often, which
 * then breaks voice permanently for that install.
 *
 * So: JS calls ensure() at the moment the rider actually opens the walkie-talkie
 * or joins a convoy, after showing its own one-line rationale. Resolves
 * { granted: bool } either way — never rejects, so the caller can just fall back
 * to text chat.
 */
@CapacitorPlugin(name = "Voice",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic")
    })
public class VoicePlugin extends Plugin {

    private boolean granted() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
    }

    /** Already held? Cheap check so JS can decide whether to show a rationale first. */
    @PluginMethod
    public void has(PluginCall call) {
        call.resolve(new JSObject().put("granted", granted()));
    }

    /** Request it if we don't have it. Always resolves with the final state. */
    @PluginMethod
    public void ensure(PluginCall call) {
        if (granted()) { call.resolve(new JSObject().put("granted", true)); return; }
        requestPermissionForAlias("mic", call, "micCallback");
    }

    @PermissionCallback
    private void micCallback(PluginCall call) {
        call.resolve(new JSObject().put("granted", granted()));
    }
}
