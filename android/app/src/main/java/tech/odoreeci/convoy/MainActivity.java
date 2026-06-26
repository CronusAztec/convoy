package tech.odoreeci.convoy;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native plugins before the bridge initializes.
        registerPlugin(BackgroundLocationPlugin.class);
        registerPlugin(RadarDetectorPlugin.class);
        registerPlugin(SabrePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
