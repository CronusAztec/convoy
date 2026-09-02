package tech.odoreeci.convoy;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin: social sign-in for the APK.
 *
 * WHY THIS EXISTS AT ALL. On the web, starting a provider sign-in is one line —
 * set location.href and let the page navigate. Neither half of that works here:
 *
 *   1. Google (and, increasingly, everyone else) REFUSES OAuth inside an
 *      embedded WebView and answers `disallowed_useragent`. The sanctioned path
 *      on Android is a Custom Tab: the user's real browser, with its real
 *      session and its real address bar, rendered over the app. That is what
 *      open() launches.
 *   2. The Capacitor WebView runs at https://localhost, so there is no origin
 *      for the provider to redirect back TO. Instead the round-trip ends at a
 *      custom scheme this app owns (see the intent-filter in
 *      AndroidManifest.xml), which Android hands back to MainActivity — and
 *      which arrives here as handleOnNewIntent.
 *
 * SECURITY. A custom scheme can, in principle, be claimed by another installed
 * app, so the authorization code in the redirect is not treated as a secret.
 * The flow is PKCE and Convoy holds the code_verifier ON THE SERVER (see
 * server/oauth.js) — it is never in the app, never in the URL, and never in the
 * browser. An intercepted redirect is therefore worth nothing on its own: the
 * code can only be redeemed by a caller who can also present the verifier, and
 * the one-time state is consumed server-side on first use.
 *
 * MAILED LINKS come in here too. Password resets, email confirmations,
 * passwordless sign-in links and email-change confirmations are ordinary https
 * links to https://odoreeci.tech/l/<kind>?token=…, and on a phone with the app
 * installed Android delivers them here as App Links rather than opening a
 * browser (see the autoVerify intent-filter in AndroidManifest.xml). Without
 * the app — or on a desktop — the same URL opens the site, which redirects to
 * the in-page flow. Both routes end up in the same JS handler.
 *
 * The plugin itself deliberately does no interpretation: it forwards whatever
 * came back to JS and lets js/auth.js decide what it means, exactly as the web
 * build does with its query string.
 */
@CapacitorPlugin(name = "Auth")
public class AuthPlugin extends Plugin {

    // Must match the intent-filter in AndroidManifest.xml and the redirect the
    // server hands to GoTrue (OAUTH_NATIVE_REDIRECT in server/.env).
    private static final String SCHEME = "tech.odoreeci.convoy";
    private static final String HOST = "auth";

    // The mailed-link path prefix, and the four kinds that can follow it. An
    // allowlist rather than "whatever came after /l/": this string is chosen by
    // whoever sent the link, and it goes on to select a code path in JS.
    private static final String LINK_PREFIX = "/l/";
    private static final String[] LINK_KINDS = { "reset", "verify", "magic", "change" };

    /**
     * Open a provider sign-in URL in the browser, over the app.
     *
     * A Custom Tab keeps the user in the app's task, so the redirect back
     * collapses it automatically: MainActivity is launchMode="singleTask", and
     * the incoming VIEW intent brings it to the front and clears the tab above
     * it. No explicit "close the browser" call is needed or possible.
     */
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("No URL to open");
            return;
        }
        // Only ever an https provider URL. A custom scheme here would let a
        // compromised page in the WebView fire arbitrary intents through us.
        if (!url.startsWith("https://")) {
            call.reject("Refusing to open a non-https URL");
            return;
        }
        Uri uri = Uri.parse(url);
        // Launched from the ACTIVITY, and deliberately WITHOUT
        // FLAG_ACTIVITY_NEW_TASK. That flag would put the browser in a task of
        // its own, which breaks the whole return path described above: the
        // redirect brings MainActivity forward and clears what sits above it IN
        // THE SAME TASK, so a separate task would survive as a stray browser the
        // rider can swipe back to, still showing the consumed sign-in page.
        // getActivity() rather than getContext() because only the former is
        // guaranteed to be an Activity, and starting an activity from a
        // non-activity context is what makes NEW_TASK mandatory in the first place.
        android.app.Activity activity = getActivity();
        if (activity == null) { call.reject("No activity to sign in from"); return; }
        try {
            CustomTabsIntent tab = new CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build();
            tab.launchUrl(activity, uri);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            // No Custom Tabs provider (a stripped ROM, or every browser
            // disabled). Fall back to a plain VIEW intent — the sign-in still
            // works, it just looks like a full browser rather than a tab.
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
                call.resolve();
            } catch (ActivityNotFoundException e2) {
                call.reject("No browser is available to sign in with");
            }
        }
    }

    /**
     * The redirect coming back from the provider.
     *
     * Fires for both cases, and they are genuinely different: a warm return
     * (the app stayed alive behind the Custom Tab) arrives here directly, while
     * a cold start — the app was killed mid-sign-in — is replayed through the
     * same path by BridgeActivity when the bridge loads.
     *
     * That second case is why the event is emitted with retainUntilConsumed:
     * on a cold start this runs BEFORE js/auth.js has attached its listener, and
     * an un-retained event would be dropped into a WebView that isn't listening
     * yet, stranding the rider on the sign-in screen with no way to know why.
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri uri = intent.getData();
        if (uri == null) return;

        // The provider round-trip, on the app's own scheme.
        //
        // The intent-filters already narrow both of these, but an intent can be
        // sent directly to an exported activity by any app on the device, so the
        // shape is re-checked here rather than assumed.
        if (SCHEME.equalsIgnoreCase(uri.getScheme()) && HOST.equalsIgnoreCase(uri.getHost())) {
            JSObject data = new JSObject();
            data.put("code", param(uri, "code"));
            data.put("state", param(uri, "cvst"));
            // The provider says no the same way it says yes: as a redirect. Pass
            // the refusal through so the app can tell "cancelled" from "never
            // returned".
            data.put("error", param(uri, "error"));
            data.put("errorDescription", param(uri, "error_description"));
            notifyListeners("redirect", data, true);
            return;
        }

        // A mailed link: https://odoreeci.tech/l/<kind>?token=…
        // HOST CHECK, same as the OAuth branch above: MainActivity is exported,
        // so any installed app can hand it an explicit VIEW intent that never
        // went through the manifest's intent-filter matching. Without this, a
        // hostile app could deliver https://evil.example/l/magic?token=<its own
        // valid token> and silently sign the victim's device into the attacker's
        // account.
        if ("https".equalsIgnoreCase(uri.getScheme())) {
            String host = uri.getHost();
            if (!"odoreeci.tech".equalsIgnoreCase(host) && !"www.odoreeci.tech".equalsIgnoreCase(host)) return;
            String kind = linkKind(uri.getPath());
            String token = param(uri, "token");
            if (kind == null || token.isEmpty()) return;
            JSObject data = new JSObject();
            data.put("kind", kind);
            data.put("token", token);
            // Retained for the same reason the OAuth event is: opening one of
            // these from a mail app very often COLD-STARTS Convoy, and the event
            // fires before the WebView has loaded js/auth.js.
            notifyListeners("link", data, true);
        }
    }

    // Map a path onto one of the four known link kinds, or null. Nothing else
    // reaches JS — the path segment comes from whoever composed the link.
    private static String linkKind(String path) {
        if (path == null || !path.startsWith(LINK_PREFIX)) return null;
        String kind = path.substring(LINK_PREFIX.length());
        // Tolerate a trailing slash; a mail client that "helpfully" appends one
        // should not silently break the link.
        if (kind.endsWith("/")) kind = kind.substring(0, kind.length() - 1);
        for (String k : LINK_KINDS) if (k.equals(kind)) return k;
        return null;
    }

    // getQueryParameter throws on a URI it considers opaque (no leading "//"),
    // which is exactly what a malformed or hostile deep link would be.
    private static String param(Uri uri, String key) {
        try {
            String v = uri.getQueryParameter(key);
            return v == null ? "" : v;
        } catch (UnsupportedOperationException e) {
            return "";
        }
    }
}
