package tech.odoreeci.convoy;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import javax.net.ssl.HttpsURLConnection;

/**
 * Capacitor plugin: OTA live updates for the web layer (the hotfix path).
 *
 * The APK freezes www/ at build time; this plugin lets the server replace it
 * with a newer verified copy, so an HTML/CSS/JS fix reaches installed APKs in
 * minutes instead of a store review. Native changes still need a full release —
 * nothing here touches code, only the WebView's content directory.
 *
 * How it rides on Capacitor instead of fighting it:
 *
 *   · The Bridge ALREADY serves from a persisted path when one is recorded in
 *     the WebView prefs ("CapWebViewSettings"/"serverBasePath") — it applies it
 *     before the first page load, and its own new-binary check (versionCode or
 *     versionName change) clears it, so a fresh APK always serves its own
 *     assets. We only WRITE that pref; Capacitor does the rest.
 *   · Swapping is therefore "stage now, serve next launch": the running
 *     session is never reloaded out from under an active ride.
 *
 * Safety model — a broken bundle must never brick a rider:
 *
 *   1. Every download is sha256-checked against the manifest and unzipped with
 *      a strict no-escape guard before anything is staged.
 *   2. Staging persists "staged" BEFORE the bundle can ever be served. The next
 *      launch serves it and arms a 15s watchdog; js/ota.js must call
 *      notifyReady() from the end of a successful boot. No confirm (crash,
 *      syntax error, white screen) → revert to the previous bundle, or to the
 *      APK's builtin assets if there is none. The watchdog also catches process
 *      death: an unconfirmed "staged" left in prefs arms the same revert on the
 *      launch after.
 *   3. A version that ever failed the handshake is blocked and never staged
 *      again — a broken release can't put the fleet in a crash-revert loop.
 *   4. Every failure here resolves quietly (an event for telemetry, never an
 *      exception into the host app). A broken updater behaves like no updater:
 *      the app falls back to its builtin bundle and keeps working.
 *
 * Privacy: the check POSTs {platform, version_build, version_code,
 * version_name} and NOTHING else — no device or install identifier — keeping
 * the Play Data Safety answer "Device or other IDs: No" true.
 */
@CapacitorPlugin(name = "LiveUpdate")
public class LiveUpdatePlugin extends Plugin {

    /** How long the app has to finish booting and call notifyReady(). */
    private static final long CONFIRM_TIMEOUT_MS = 15_000;
    /** Ceiling on any download, matched server-side. */
    private static final long MAX_BUNDLE_BYTES = 64L * 1024 * 1024;
    private static final int CONNECT_MS = 10_000;
    private static final int READ_MS = 30_000;
    /** The assets dir Capacitor bundles www/ into (Bridge.DEFAULT_WEB_ASSET_DIR). */
    private static final String ASSET_DIR = "public";
    /** Our bookkeeping lives beside Capacitor's WebView path pref. */
    private static final String OTA_PREFS = "ConvoyLiveUpdate";

    private Handler main;
    private final AtomicBoolean busy = new AtomicBoolean(false);

    /* ---------------- lifecycle ---------------- */

    @Override
    public void load() {
        main = new Handler(Looper.getMainLooper());
        resetIfNewBinary();
        // A staged-but-unconfirmed bundle in prefs means THIS launch is running
        // it (the Bridge applied the persisted path) and JS has not yet vouched
        // for it — arm the watchdog whether we crashed last time or booted slow.
        if (!staged().isEmpty()) armWatchdog();
    }

    @Override
    protected void handleOnDestroy() {
        // The watchdog holds no plugin state beyond prefs (which survive); the
        // recreated plugin's load() re-arms it for the same staged bundle.
        if (main != null) main.removeCallbacksAndMessages(null);
        super.handleOnDestroy();
    }

    /** A new APK brings its own current assets: wipe our state and the bundles.
     *  Capacitor has already cleared the WebView path pref for the same reason
     *  (its new-binary check), so nothing stale can be served either way. */
    private void resetIfNewBinary() {
        String key = versionCode() + "/" + versionName();
        SharedPreferences p = prefs();
        if (key.equals(p.getString("nativeKey", ""))) return;
        p.edit()
            .putString("nativeKey", key)
            .putString("active", "")
            .putString("staged", "")
            .putString("previous", "")
            .putString("blocked", "")
            .apply();
        rmrf(new File(root(), "bundles"));
    }

    /* ---------------- JS surface ---------------- */

    /**
     * One update check per app open (js/ota.js init). Resolves immediately;
     * the work happens on our own thread so the shared plugin executor is
     * never blocked by a slow download. Results arrive as "state" events:
     * staged / reverted / failed. Never an error resolution.
     */
    @PluginMethod
    public void check(PluginCall call) {
        String base = call.getString("base", "");
        JSObject out = new JSObject();
        out.put("checking", false);
        if (!base.startsWith("https://")) { call.resolve(out); return; }
        if (!busy.compareAndSet(false, true)) { call.resolve(out); return; }
        final String origin = base.replaceAll("/+$", "");
        out.put("checking", true);
        call.resolve(out);
        new Thread(() -> {
            try { doCheck(origin); }
            finally { busy.set(false); }
        }, "convoy-ota").start();
    }

    /**
     * The health handshake. Called by js/ota.js ONLY from the end of a clean
     * boot: a bundle whose boot threw is exactly the bundle this exists to
     * catch. Promotes the staged bundle to active and prunes old ones.
     */
    @PluginMethod
    public void notifyReady(PluginCall call) {
        SharedPreferences p = prefs();
        String stagedV = staged();
        String active = active();
        if (!stagedV.isEmpty()) {
            active = stagedV;
            String previous = p.getString("previous", "");
            p.edit().putString("active", active).putString("staged", "").apply();
            if (main != null) main.removeCallbacksAndMessages(null);
            cleanupBundles(active, previous);
            event("confirmed", "version", active);
        }
        JSObject out = new JSObject();
        out.put("active", active);
        out.put("confirmed", true);
        call.resolve(out);
    }

    /** Diagnostics for the pre-launch drill and the debug console. */
    @PluginMethod
    public void info(PluginCall call) {
        SharedPreferences p = prefs();
        JSObject o = new JSObject();
        o.put("active", active());
        o.put("staged", staged());
        o.put("previous", p.getString("previous", ""));
        o.put("blocked", p.getString("blocked", ""));
        o.put("versionBuild", versionName());
        o.put("versionCode", versionCode());
        o.put("builtin", webPrefs().getString(capServerPathKey(), "").isEmpty());
        call.resolve(o);
    }

    /* ---------------- the check ---------------- */

    private void doCheck(String origin) {
        try {
            JSONObject body = new JSONObject();
            body.put("platform", "android");
            body.put("version_build", versionName());
            body.put("version_code", versionCode());
            String running = !staged().isEmpty() ? staged() : active();
            body.put("version_name", running.isEmpty() ? "builtin" : running);

            JSONObject offer = httpJson(origin + "/api/ota", body.toString());
            if (offer == null) { event("failed", "error", "check unreachable"); return; }

            String version = offer.optString("version", "");
            String rel = offer.optString("url", "");
            String checksum = offer.optString("checksum", "");
            long size = offer.optLong("size", -1);
            if (version.isEmpty()) return; // up to date — the common case, stay quiet
            // Everything below is shape-checking data that came off the network.
            if (!version.matches("[0-9]+(\\.[0-9]+){0,2}")) { event("failed", "error", "bad version"); return; }
            if (version.equals(staged()) || version.equals(active())) return; // already ours
            if (version.equals(prefs().getString("blocked", ""))) return;     // burned once
            if (!rel.startsWith("/ota/") || rel.contains("..")) { event("failed", "error", "bad url"); return; }
            if (!checksum.matches("[0-9a-f]{64}")) { event("failed", "error", "bad checksum"); return; }
            if (size <= 0 || size > MAX_BUNDLE_BYTES) { event("failed", "error", "bad size"); return; }

            File tmp = new File(root(), ".download-" + version + ".zip.part");
            try {
                String sha = download(origin + rel, tmp, size);
                if (!sha.equals(checksum)) throw new IOException("checksum mismatch");
                File dir = extract(tmp, version);
                // Stage: order matters — record intent in OUR prefs first, then
                // point the WebView at it. A crash between the two lines leaves
                // "staged" set with no served bundle, which the next launch's
                // watchdog handles like any other unconfirmed bundle.
                String previous = active();
                prefs().edit().putString("previous", previous).putString("staged", version).apply();
                // Persist-only: do NOT swap the live session. The Bridge reads
                // this on the NEXT process start and serves the new bundle then.
                webPrefs().edit().putString(capServerPathKey(), dir.getAbsolutePath()).apply();
                event("staged", "version", version);
            } finally {
                tmp.delete();
            }
        } catch (Exception e) {
            event("failed", "error", clip(e.getMessage()));
        }
    }

    /* ---------------- watchdog + revert ---------------- */

    private void armWatchdog() {
        final String expect = staged();
        if (main == null) return;
        main.postDelayed(() -> {
            if (!staged().equals(expect)) return; // confirmed (or replaced) since
            revert(expect);
        }, CONFIRM_TIMEOUT_MS);
    }

    /** Back out of an unconfirmed bundle: previous good one if it still exists
     *  on disk, else the APK's builtin assets. Blocks the bad version. */
    private void revert(String bad) {
        String previous = prefs().getString("previous", "");
        File prevDir = previous.isEmpty() ? null : bundleDir(previous);
        String to;
        if (prevDir != null && new File(prevDir, "index.html").isFile()) {
            prefs().edit()
                .putString("active", previous).putString("staged", "")
                .putString("blocked", bad).apply();
            webPrefs().edit().putString(capServerPathKey(), prevDir.getAbsolutePath()).apply();
            // Live swap so THIS session recovers instead of white-screening.
            try { if (getBridge() != null) getBridge().setServerBasePath(prevDir.getAbsolutePath()); }
            catch (Exception e) { /* next launch serves it from the pref */ }
            to = previous;
        } else {
            prefs().edit()
                .putString("active", "").putString("staged", "")
                .putString("blocked", bad).apply();
            webPrefs().edit().putString(capServerPathKey(), "").apply();
            try { if (getBridge() != null) getBridge().setServerAssetPath(ASSET_DIR); }
            catch (Exception e) { /* same */ }
            to = "builtin";
        }
        event("reverted", "version", bad, "to", to);
    }

    /* ---------------- network ---------------- */

    private JSONObject httpJson(String urlStr, String jsonBody) {
        HttpsURLConnection c = null;
        try {
            c = (HttpsURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(15_000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] b = jsonBody.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(b.length);
            try (OutputStream os = c.getOutputStream()) { os.write(b); }
            if (c.getResponseCode() != 200) return null;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            }
            return new JSONObject(bo.toString("UTF-8"));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Stream to `out` while hashing; returns the hex sha256. Enforces the
     *  declared size (a server that lies is a server we don't trust bytes from). */
    private String download(String urlStr, File out, long expectSize) throws IOException {
        HttpsURLConnection c = null;
        try {
            c = (HttpsURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            MessageDigest md;
            try { md = MessageDigest.getInstance("SHA-256"); }
            catch (Exception de) { throw new IOException("no SHA-256 on this platform"); } // cannot happen
            long cap = Math.min(expectSize + 65536, MAX_BUNDLE_BYTES);
            long total = 0;
            try (InputStream in = new BufferedInputStream(c.getInputStream());
                 OutputStream os = new BufferedOutputStream(new FileOutputStream(out))) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    md.update(buf, 0, n);
                    total += n;
                    if (total > cap) throw new IOException("bundle larger than declared");
                }
            }
            if (total != expectSize) throw new IOException("short download: " + total + " of " + expectSize);
            StringBuilder sb = new StringBuilder();
            for (byte x : md.digest()) sb.append(String.format("%02x", x));
            return sb.toString();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /* ---------------- zip ---------------- */

    /** Unzip into bundles/<version>.new, verify index.html at the root, then
     *  atomically rename into place. Every entry is canonical-path-checked
     *  against the destination: a name like ../../whatever is rejected, not
     *  escaped. */
    private File extract(File zip, String version) throws IOException {
        File top = new File(root(), "bundles");
        File staging = new File(top, version + ".new");
        File dest = new File(top, version);
        rmrf(staging);
        rmrf(dest);
        String topCanonical = staging.getCanonicalPath() + File.separator;
        try (ZipInputStream zin = new ZipInputStream(
                new BufferedInputStream(new FileInputStream(zip)), StandardCharsets.UTF_8)) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                File f = new File(staging, e.getName());
                if (!f.getCanonicalPath().startsWith(topCanonical)) {
                    throw new IOException("zip escape attempt: " + e.getName());
                }
                if (e.isDirectory()) { f.mkdirs(); continue; }
                File parent = f.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream os = new BufferedOutputStream(new FileOutputStream(f))) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
                zin.closeEntry();
            }
        }
        if (!new File(staging, "index.html").isFile()) {
            throw new IOException("bundle has no index.html");
        }
        if (!staging.renameTo(dest)) throw new IOException("could not finalize bundle dir");
        return dest;
    }

    /** Keep only the active and previous bundles; drop everything else
     *  (including .new leftovers from aborted extracts). */
    private void cleanupBundles(String keepA, String keepB) {
        File top = new File(root(), "bundles");
        File[] all = top.listFiles();
        if (all == null) return;
        for (File f : all) {
            String n = f.getName();
            if (n.equals(keepA) || n.equals(keepA + ".new") ||
                n.equals(keepB) || n.equals(keepB + ".new")) continue;
            rmrf(f);
        }
    }

    /* ---------------- state helpers ---------------- */

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(OTA_PREFS, Context.MODE_PRIVATE);
    }

    /** Capacitor's own WebView prefs — the deploy path the Bridge reads before
     *  the first page load (see Bridge.java: WEBVIEW_PREFS_NAME/CAP_SERVER_PATH
     *  in com.getcapacitor.plugin.WebView). */
    private SharedPreferences webPrefs() {
        return getContext().getSharedPreferences(
            com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE);
    }

    private String capServerPathKey() {
        return com.getcapacitor.plugin.WebView.CAP_SERVER_PATH;
    }

    private String active() { return prefs().getString("active", ""); }
    private String staged() { return prefs().getString("staged", ""); }

    private File root() {
        File f = new File(getContext().getFilesDir(), "live-update");
        if (!f.exists()) f.mkdirs();
        return f;
    }

    private File bundleDir(String version) { return new File(new File(root(), "bundles"), version); }

    private String versionName() {
        try {
            String n = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0).versionName;
            return n == null ? "" : n;
        } catch (Exception e) { return ""; }
    }

    private String versionCode() {
        try {
            long v = PackageInfoCompat.getLongVersionCode(getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0));
            return String.valueOf(v);
        } catch (Exception e) { return ""; }
    }

    /* ---------------- misc ---------------- */

    private void event(String t, String k1, Object v1) {
        try {
            JSObject o = new JSObject();
            o.put("t", t);
            o.put(k1, v1);
            notifyListeners("state", o);
        } catch (Exception e) { /* never let an event escape the updater */ }
    }

    private void event(String t, String k1, Object v1, String k2, Object v2) {
        try {
            JSObject o = new JSObject();
            o.put("t", t);
            o.put(k1, v1);
            o.put(k2, v2);
            notifyListeners("state", o);
        } catch (Exception e) { /* same */ }
    }

    private String clip(String s) {
        if (s == null) s = "";
        return s.length() > 80 ? s.substring(0, 80) : s;
    }

    private static void rmrf(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) rmrf(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
