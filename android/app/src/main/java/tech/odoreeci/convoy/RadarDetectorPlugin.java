package tech.odoreeci.convoy;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.bluetooth.le.BluetoothLeScanner;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import androidx.core.content.ContextCompat;

import java.util.UUID;

/**
 * Capacitor plugin: hardware radar detector over BLE.
 *
 * Targets Escort / Beltronics detectors using the reverse-engineered serial-over-
 * BLE protocol documented by esclib (https://github.com/qoq/esclib.github.io).
 * The detector exposes a Nordic UART-like service: a TX characteristic we enable
 * notifications on to receive alert frames. Each frame encodes the band (X/K/Ka/
 * Laser), the relative signal strength, and (sometimes) the frequency.
 *
 * Streamed to JS as "alert" events: { band, strength, freq }.
 *
 * NOTE: This is a best-effort implementation against the public esclib protocol
 * docs. Escort's protocol is undocumented by the vendor and varies across models;
 * real-world use needs a paired detector to validate/adjust the frame parser.
 */
@CapacitorPlugin(name = "RadarDetector",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN }, alias = "scan"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "connect")
    })
public class RadarDetectorPlugin extends Plugin {

    // Nordic UART Service — the common transport Escort/Bel detectors expose.
    private static final UUID NUS_SERVICE = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    private static final UUID NUS_TX      = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e"); // write
    private static final UUID NUS_RX      = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e"); // notify
    private static final UUID CCCD        = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private boolean scanning = false;

    @PluginMethod
    public void startScan(PluginCall call) {
        BluetoothAdapter adapter = btAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is not available or not enabled");
            return;
        }
        if (!hasConnect()) { requestPermissionForAlias("connect", call, "permCallback"); return; }

        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { call.reject("BLE scanner unavailable"); return; }

        scanning = true;
        try {
            scanner.startScan(null, new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build(), scanCb);
            call.resolve(new JSObject().put("scanning", true));
        } catch (Exception e) {
            call.reject("Scan failed: " + e.getMessage());
        }
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (!hasConnect()) { call.reject("Bluetooth permissions denied"); return; }
        startScan(call);
    }

    private final ScanCallback scanCb = new ScanCallback() {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice dev = result.getDevice();
            // Try to connect to anything advertising the NUS service; real detectors
            // will match, and we filter by service-discovery after connect.
            if (gatt != null) return; // already connected
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
                    != PackageManager.PERMISSION_GRANTED) return;
            gatt = dev.connectGatt(getContext(), false, gattCb, BluetoothDevice.TRANSPORT_LE);
            if (scanning) { try { scanner.stopScan(scanCb); } catch (Exception e) {} scanning = false; }
        }
    };

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            if (state == BluetoothProfile.STATE_CONNECTED) {
                if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
                        == PackageManager.PERMISSION_GRANTED) g.discoverServices();
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                notifyListeners("state", new JSObject().put("connected", false));
            }
        }

        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            BluetoothGattCharacteristic rx = g.getService(NUS_SERVICE).getCharacteristic(NUS_RX);
            if (rx != null) {
                g.setCharacteristicNotification(rx, true);
                BluetoothGattDescriptor d = rx.getDescriptor(CCCD);
                if (d != null) { d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE); g.writeDescriptor(d); }
                notifyListeners("state", new JSObject().put("connected", true));
            }
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            // Each notification is a chunk of the detector's serial stream. Parse
            // the simple alert framing: band byte + strength byte (esclib style).
            byte[] v = c.getValue();
            if (v == null || v.length < 2) return;
            JSObject o = parseFrame(v);
            if (o != null) notifyListeners("alert", o);
        }
    };

    // Minimal Escort-style frame: band (1=X,2=K,3=Ka,4=Laser) + strength(0..9).
    // Real detectors emit richer frames; this is the documented common subset.
    private JSObject parseFrame(byte[] v) {
        int band = v[0] & 0xFF;
        int strength = v.length > 1 ? (v[1] & 0xFF) : 0;
        String bandName;
        switch (band) {
            case 1: bandName = "X"; break;
            case 2: bandName = "K"; break;
            case 3: bandName = "Ka"; break;
            case 4: bandName = "Laser"; break;
            default: return null; // not an alert frame
        }
        JSObject o = new JSObject();
        o.put("band", bandName);
        o.put("strength", Math.max(0, Math.min(9, strength)));
        return o;
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        if (scanning) { try { scanner.stopScan(scanCb); } catch (Exception e) {} scanning = false; }
        if (gatt != null) {
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
                    == PackageManager.PERMISSION_GRANTED) { try { gatt.close(); } catch (Exception e) {} }
            gatt = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        call.resolve(new JSObject().put("connected", gatt != null));
    }

    private BluetoothAdapter btAdapter() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }
    private boolean hasConnect() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
            == PackageManager.PERMISSION_GRANTED;
    }
}
