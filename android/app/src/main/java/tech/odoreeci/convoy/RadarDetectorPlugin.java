package tech.odoreeci.convoy;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.bluetooth.le.BluetoothLeScanner;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import androidx.core.content.ContextCompat;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Capacitor plugin: hardware radar detectors over BLE — multi-brand.
 *
 * Supports the major detector families that expose a Bluetooth alert link:
 *   - Escort / Beltronics / Cobra — Nordic-UART serial framing (esclib protocol)
 *   - Valentine One (V1 Gen2 / V1connection LE) — infDisplayData BLE service
 *   - Radenso / Genevo — vendor GATT with a notify characteristic
 *   - Uniden / Whistler — recognized + connectable; alert framing best-effort
 *
 * Two ways to connect:
 *   listDevices()      — scan, return every nearby BLE device with a compatibility
 *                        guess ({id,name,rssi,brand,family,compatible,stream}), so
 *                        the app can show a picker. Streams 'device' events live.
 *   connect(deviceId)  — connect to a chosen device by MAC address.
 *   startScan()        — legacy auto-connect: grab the first compatible detector.
 *
 * Alert events to JS: { band, strength(0..9), freq?, direction?, family }.
 * State events: { connected, name?, family? }.
 *
 * Escort/V1 protocols are undocumented by the vendors; the frame parsers follow
 * public reverse-engineering notes (esclib, V1 serial spec) and are best-effort
 * until validated against each physical model.
 */
@CapacitorPlugin(name = "RadarDetector",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN }, alias = "scan"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "connect")
    })
public class RadarDetectorPlugin extends Plugin {

    // Nordic UART Service — Escort/Beltronics/Cobra serial-over-BLE transport.
    private static final UUID NUS_SERVICE = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    private static final UUID NUS_RX      = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e"); // notify
    // Valentine One "V1connection LE" service + the infDisplayData notify char.
    private static final UUID V1_SERVICE  = UUID.fromString("92a0aff4-9e05-11e2-aa59-f23c91aec05e");
    private static final UUID V1_NOTIFY   = UUID.fromString("92a0b2ce-9e05-11e2-aa59-f23c91aec05e");
    private static final UUID CCCD        = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    // Name signatures → { family, brand, stream }. Mirrors js/detectors.js so the
    // UI compatibility list and the native matcher agree on what's supported.
    private static final class Sig {
        final Pattern re; final String family, brand; final boolean stream; final String proto;
        Sig(String re, String family, String brand, boolean stream, String proto) {
            this.re = Pattern.compile(re, Pattern.CASE_INSENSITIVE);
            this.family = family; this.brand = brand; this.stream = stream; this.proto = proto;
        }
    }
    private static final Sig[] SIGS = new Sig[] {
        new Sig("^(escort|max\\s?3|max\\s?360|maxcam|redline|passport|ix\\b)", "escort", "Escort", true, "nus"),
        new Sig("^(bel\\b|beltronics|gt-?7|gt-?360|gt-?2)", "beltronics", "Beltronics", true, "nus"),
        new Sig("^(v1|valentine|v1c|v1connection)", "valentine", "Valentine One", true, "v1"),
        new Sig("^(cobra|rad\\s?\\d|iradar|drive\\s?smart)", "cobra", "Cobra", true, "nus"),
        new Sig("^(radenso|theia|ds1|pro\\s?m)", "radenso", "Radenso", true, "ble"),
        new Sig("^(genevo)", "genevo", "Genevo", true, "ble"),
        new Sig("^(uniden|r[3478]\\b|dfr\\d)", "uniden", "Uniden", false, "name"),
        new Sig("^(whistler|z-?\\d)", "whistler", "Whistler", false, "name"),
        new Sig("(nordic|nus|uart)", "escortgen", "Escort (generic)", true, "nus")
    };

    private static Sig sigFor(String name) {
        if (name == null) return null;
        for (Sig s : SIGS) if (s.re.matcher(name).find()) return s;
        return null;
    }

    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private boolean scanning = false;
    private boolean listing = false;   // scanning to enumerate (not auto-connect)
    private String connectFamily = null;
    private final Handler main = new Handler(Looper.getMainLooper());
    // onScanResult lands on a BLE Binder thread while the 6s resolve runnable
    // (main) and the next listDevices() (bridge) iterate/clear — a plain
    // HashMap threw ConcurrentModificationException under exactly that overlap.
    private final Map<String, JSObject> found = new ConcurrentHashMap<>();
    private PluginCall pendingConnect = null; // connect target held across a permission prompt
    private int listGen = 0;                 // generation token for listDevices' 6s resolve

    /* ============================ device listing ============================ */
    @PluginMethod
    public void listDevices(PluginCall call) {
        BluetoothAdapter adapter = btAdapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("Bluetooth is off"); return; }
        if (!hasScan() || !hasConnect()) {
            requestPermissionForAliases(new String[]{ "scan", "connect" }, call, "listPermCb");
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { call.reject("BLE scanner unavailable"); return; }

        // Stop any running auto-connect scan FIRST. It used to keep running
        // under the picker's flags, and the 6s resolve then stopped ONLY listCb
        // — leaving a SCAN_MODE_LOW_LATENCY scan live for the rest of the app's
        // life (battery, BT stack busy, surprise auto-connects).
        stopLeScan();
        found.clear();
        listing = true; scanning = true;
        try {
            scanner.startScan(null, new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), listCb);
        } catch (Exception e) { call.reject("Scan failed: " + e.getMessage()); return; }

        // Collect for 6s, then resolve with everything seen (detectors first).
        // listGen makes the resolve single-shot per CALL: a rapid re-entry used to
        // leave the first 6s runnable armed alongside the second, and whichever
        // fired first resolved ITS call with a scan the other call had already
        // stopped/restarted — mixed device lists, and both runnables firing.
        final int gen = ++listGen;
        main.postDelayed(() -> {
            if (gen != listGen) return; // superseded by a newer listDevices()
            stopLeScan();
            JSArray arr = new JSArray();
            for (JSObject o : found.values()) arr.put(o);
            JSObject res = new JSObject();
            res.put("devices", arr);
            call.resolve(res);
        }, 6000);
    }

    @PermissionCallback
    private void listPermCb(PluginCall call) {
        if (!hasScan() || !hasConnect()) { call.reject("Bluetooth permission denied"); return; }
        listDevices(call);
    }

    private final ScanCallback listCb = new ScanCallback() {
        @Override public void onScanResult(int type, ScanResult result) {
            BluetoothDevice dev = result.getDevice();
            if (dev == null) return;
            String addr = dev.getAddress();
            String name = safeName(dev, result);
            Sig sig = sigFor(name);
            // Also match by advertised NUS/V1 service UUID for unnamed detectors.
            if (sig == null && advertisesDetectorService(result)) sig = SIGS[SIGS.length - 1];
            JSObject o = new JSObject();
            o.put("id", addr);
            o.put("name", name != null ? name : "(unnamed)");
            o.put("rssi", result.getRssi());
            o.put("compatible", sig != null);
            o.put("brand", sig != null ? sig.brand : null);
            o.put("family", sig != null ? sig.family : null);
            o.put("stream", sig != null && sig.stream);
            found.put(addr, o);
            notifyListeners("device", o); // live-stream results into the picker
        }
    };

    private boolean advertisesDetectorService(ScanResult r) {
        ScanRecord rec = r.getScanRecord();
        if (rec == null || rec.getServiceUuids() == null) return false;
        for (ParcelUuid p : rec.getServiceUuids()) {
            UUID u = p.getUuid();
            if (NUS_SERVICE.equals(u) || V1_SERVICE.equals(u)) return true;
        }
        return false;
    }

    /* ============================ connect by id ============================ */
    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("Missing device id"); return; }
        BluetoothAdapter adapter = btAdapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("Bluetooth is off"); return; }
        if (!hasScan() || !hasConnect()) {
            pendingConnect = call;
            requestPermissionForAliases(new String[]{ "scan", "connect" }, call, "connectPermCb");
            return;
        }
        stopLeScan();
        closeGatt();
        try {
            BluetoothDevice dev = adapter.getRemoteDevice(id);
            // Optional family hint from the picker (listDevices supplied it) so
            // alert events match the auto-connect path's shape. JS already has
            // it; the picker path used to null it and emit family-less alerts
            // for the SAME device the scan path reported with one.
            String family = call.getString("family");
            connectFamily = family != null && !family.isEmpty() ? family : null;
            gatt = dev.connectGatt(getContext(), false, gattCb, BluetoothDevice.TRANSPORT_LE);
            call.resolve(new JSObject().put("connecting", true));
        } catch (Exception e) { call.reject("Connect failed: " + e.getMessage()); }
    }

    @PermissionCallback
    private void connectPermCb(PluginCall call) {
        pendingConnect = null;
        if (!hasScan() || !hasConnect()) { call.reject("Bluetooth permission denied"); return; }
        connect(call);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        stopLeScan();
        closeGatt();
        notifyListeners("state", new JSObject().put("connected", false));
        call.resolve();
    }

    /* ===================== legacy auto-connect scan ===================== */
    @PluginMethod
    public void startScan(PluginCall call) {
        BluetoothAdapter adapter = btAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is not available or not enabled"); return;
        }
        if (!hasScan() || !hasConnect()) {
            requestPermissionForAliases(new String[]{ "scan", "connect" }, call, "permCallback");
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { call.reject("BLE scanner unavailable"); return; }

        listing = false; scanning = true;
        try {
            scanner.startScan(null, new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), autoCb);
            call.resolve(new JSObject().put("scanning", true));
        } catch (Exception e) { call.reject("Scan failed: " + e.getMessage()); }
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (!hasScan() || !hasConnect()) { call.reject("Bluetooth permissions denied"); return; }
        startScan(call);
    }

    // Auto-connect: grab the first device that looks like a supported detector.
    // connectLock makes check-then-connectGatt atomic: two detectors (or two scan
    // callbacks) arriving near-simultaneously both passed the `gatt != null` check
    // and each called connectGatt — one handle leaked and alerts were attributed
    // to whichever family the loser had stamped into connectFamily.
    private final Object connectLock = new Object();
    private final ScanCallback autoCb = new ScanCallback() {
        @Override public void onScanResult(int type, ScanResult result) {
            BluetoothDevice dev = result.getDevice();
            if (dev == null) return;
            Sig sig = sigFor(safeName(dev, result));
            if (sig == null && !advertisesDetectorService(result)) return; // not a detector
            if (!hasConnect()) return;
            synchronized (connectLock) {
                if (gatt != null) return;
                connectFamily = sig != null ? sig.family : null;
                stopLeScan();
                gatt = dev.connectGatt(getContext(), false, gattCb, BluetoothDevice.TRANSPORT_LE);
            }
        }
    };

    /* ============================ GATT + parsing ============================ */
    private BluetoothGattCharacteristic notifyChar;
    private String parseProto = "nus"; // which frame parser onCharacteristicChanged uses

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            if (state == BluetoothProfile.STATE_CONNECTED) {
                if (hasConnect()) g.discoverServices();
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                // Release the handle. Leaving `gatt` set after a link loss made
                // isConnected() lie (true while the detector is off), blocked
                // autoCb's `if (gatt != null) return` forever, and leaked the
                // native connection slot the BT stack expects to get back.
                // onConnectionStateChange arrives on a Binder thread, and close()
                // is the one GATT call that is safe from any thread.
                if (gatt != null) { try { gatt.close(); } catch (Exception e) {} }
                gatt = null;
                notifyChar = null;
                notifyListeners("state", new JSObject().put("connected", false));
            }
        }

        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            // Prefer a known service; fall back to the first notify characteristic
            // any service exposes (covers vendor GATTs we don't have UUIDs for).
            BluetoothGattCharacteristic rx = null;
            BluetoothGattService nus = g.getService(NUS_SERVICE);
            BluetoothGattService v1 = g.getService(V1_SERVICE);
            if (v1 != null) { rx = v1.getCharacteristic(V1_NOTIFY); parseProto = "v1"; }
            if (rx == null && nus != null) { rx = nus.getCharacteristic(NUS_RX); parseProto = "nus"; }
            if (rx == null) { rx = firstNotifyChar(g); parseProto = "generic"; }
            if (rx == null) { notifyListeners("state", new JSObject().put("connected", false)); return; }

            notifyChar = rx;
            g.setCharacteristicNotification(rx, true);
            BluetoothGattDescriptor d = rx.getDescriptor(CCCD);
            if (d != null) {
                d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                g.writeDescriptor(d);
            }
            JSObject st = new JSObject();
            st.put("connected", true);
            if (connectFamily != null) st.put("family", connectFamily);
            notifyListeners("state", st);
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            byte[] v = c.getValue();
            if (v == null || v.length < 2) return;
            // "generic" means a vendor GATT we have no framing spec for, so those
            // bytes are NOT esclib frames — parseNus on them read every random byte
            // as a band and invented false Ka alerts. Strict mode demands the full
            // documented esclib shape (band 1..5 AND strength 0..9) before a frame
            // may become an alert.
            boolean strict = "generic".equals(parseProto);
            JSObject o = "v1".equals(parseProto) ? parseV1(v) : parseNus(v, strict);
            if (o != null) {
                if (connectFamily != null) o.put("family", connectFamily);
                notifyListeners("alert", o);
            }
        }
    };

    private BluetoothGattCharacteristic firstNotifyChar(BluetoothGatt g) {
        List<BluetoothGattService> svcs = g.getServices();
        if (svcs == null) return null;
        for (BluetoothGattService s : svcs) {
            for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
                if ((c.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) return c;
            }
        }
        return null;
    }

    // Escort/Beltronics/Cobra Nordic-UART alert frame (esclib subset):
    //   byte0 band (1=X,2=K,3=Ka,4=Laser,5=Ku), byte1 strength 0..9, byte2/3 freq (MHz, LE).
    // `strict` = caller has no framing spec for these bytes (generic vendor GATT),
    // so anything outside the documented band/strength ranges is dropped rather
    // than clamped into a fake alert.
    private JSObject parseNus(byte[] v, boolean strict) {
        String band = bandName(v[0] & 0xFF);
        if (band == null) return null;
        int strength = v.length > 1 ? (v[1] & 0xFF) : 0;
        if (strict && strength > 9) return null;
        JSObject o = new JSObject();
        o.put("band", band);
        o.put("strength", Math.max(0, Math.min(9, strength)));
        if (v.length >= 4) {
            int freq = (v[2] & 0xFF) | ((v[3] & 0xFF) << 8);
            if (freq > 0) o.put("freq", freq);
        }
        return o;
    }

    // Valentine One infDisplayData frame: bogey/band bitfield + signal strength.
    // The V1 packs bands into a bitfield byte; we map the dominant band + bars.
    private JSObject parseV1(byte[] v) {
        // Heuristic on the documented V1 display packet layout (bandArrowDefinition
        // at byte 3, front/rear strength at bytes 4/5 on Gen2). Best-effort.
        int bandBits = v.length > 3 ? (v[3] & 0xFF) : 0;
        String band = (bandBits & 0x01) != 0 ? "Laser"
                    : (bandBits & 0x02) != 0 ? "Ka"
                    : (bandBits & 0x04) != 0 ? "K"
                    : (bandBits & 0x08) != 0 ? "X"
                    : (bandBits & 0x10) != 0 ? "Ku" : null;
        if (band == null) return null;
        int front = v.length > 4 ? (v[4] & 0xFF) : 0;
        int rear = v.length > 5 ? (v[5] & 0xFF) : 0;
        int bars = Math.max(front, rear);           // 0..255 raw
        int strength = Math.max(0, Math.min(9, bars * 9 / 255));
        JSObject o = new JSObject();
        o.put("band", band);
        o.put("strength", strength);
        o.put("direction", front >= rear ? "front" : "rear");
        return o;
    }

    private String bandName(int b) {
        switch (b) {
            case 1: return "X";
            case 2: return "K";
            case 3: return "Ka";
            case 4: return "Laser";
            case 5: return "Ku";
            default: return null;
        }
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        stopLeScan();
        closeGatt();
        call.resolve();
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        call.resolve(new JSObject().put("connected", gatt != null));
    }

    /* ============================ helpers ============================ */
    private void stopLeScan() {
        if (scanning && scanner != null) {
            // Stop BOTH callbacks: the registered one is whichever scan is (or
            // was) live, and picking by the `listing` flag missed the other.
            try { scanner.stopScan(listCb); } catch (Exception e) {}
            try { scanner.stopScan(autoCb); } catch (Exception e) {}
        }
        scanning = false; listing = false;
    }
    private void closeGatt() {
        if (gatt != null) {
            if (hasConnect()) { try { gatt.close(); } catch (Exception e) {} }
            gatt = null;
        }
        notifyChar = null;
    }
    private String safeName(BluetoothDevice dev, ScanResult r) {
        try {
            if (hasConnect() && dev.getName() != null) return dev.getName();
        } catch (SecurityException e) { /* fall through */ }
        ScanRecord rec = r.getScanRecord();
        return rec != null ? rec.getDeviceName() : null;
    }
    private BluetoothAdapter btAdapter() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }
    private boolean hasConnect() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH)
                == PackageManager.PERMISSION_GRANTED;
        }
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
            == PackageManager.PERMISSION_GRANTED;
    }
    // BLUETOOTH_SCAN/CONNECT exist only on API 31+. minSdk is 24, so on
    // Android 7–11 those names are unknown to checkSelfPermission and these
    // used to return PERMISSION_DENIED unconditionally — the whole detector
    // feature was dead on every pre-12 device. Down there the legacy
    // BLUETOOTH/BLUETOOTH_ADMIN pair (install-time, manifest-gated) is the
    // grant that matters.
    private boolean hasScan() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH)
                == PackageManager.PERMISSION_GRANTED;
        }
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_SCAN)
            == PackageManager.PERMISSION_GRANTED;
    }
}
