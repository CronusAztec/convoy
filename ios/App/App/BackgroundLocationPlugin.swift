import Foundation
import Capacitor
import CoreLocation

/// Capacitor plugin: background location (the iOS half of
/// android/.../BackgroundLocationPlugin.java, same JS surface).
///
/// Keeps GPS fixes flowing while the app is in the background or the screen
/// is off, so a rider's pin stays live for their convoy and the walkie-talkie
/// keeps a position to be proximity-matched against. JS owns all map/UI logic;
/// this only keeps the pipe open and streams each fix back as a "fix" event:
///   { lat, lng, accuracy (m), speed (m/s, -1 when unknown), bearing (deg), time (ms) }
///
/// Permission model: "When In Use" is all that is asked for. Combined with the
/// `location` entry in UIBackgroundModes and allowsBackgroundLocationUpdates,
/// iOS keeps delivering updates after the rider backgrounds the app from a
/// foreground session, and shows the blue status indicator while it does —
/// which is exactly the visibility the store policies want. "Always" is never
/// requested: the app has no reason to locate a rider who has not opened it.
@objc(BackgroundLocationPlugin)
public class BackgroundLocationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "BackgroundLocationPlugin"
    public let jsName = "BackgroundLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isRunning", returnType: CAPPluginReturnPromise)
    ]

    private var manager: CLLocationManager?
    private var running = false
    private var pendingStart: CAPPluginCall?

    override public func load() {
        let m = CLLocationManager()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyBest
        m.distanceFilter = 5
        m.activityType = .automotiveNavigation
        m.pausesLocationUpdatesAutomatically = false
        manager = m
    }

    private func authorized(_ status: CLAuthorizationStatus) -> Bool {
        return status == .authorizedWhenInUse || status == .authorizedAlways
    }

    private func currentStatus() -> CLAuthorizationStatus {
        if #available(iOS 14.0, *) {
            return manager?.authorizationStatus ?? .notDetermined
        }
        return CLLocationManager.authorizationStatus()
    }

    @objc func start(_ call: CAPPluginCall) {
        if running { call.resolve(["running": true]); return }
        let status = currentStatus()
        if authorized(status) { begin(call); return }
        if status == .notDetermined {
            pendingStart = call
            call.keepAlive = true
            manager?.requestWhenInUseAuthorization()
            return
        }
        call.reject("Location permission denied")
    }

    private func begin(_ call: CAPPluginCall) {
        guard let m = manager else { call.reject("Location unavailable"); return }
        // Only honoured when Info.plist lists `location` under UIBackgroundModes;
        // setting it without that entry throws at runtime, so guard on the
        // bundle rather than trusting the build configuration.
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        if modes.contains("location") {
            m.allowsBackgroundLocationUpdates = true
            m.showsBackgroundLocationIndicator = true
        }
        m.startUpdatingLocation()
        running = true
        call.resolve(["running": true])
    }

    @objc func stop(_ call: CAPPluginCall) {
        manager?.stopUpdatingLocation()
        running = false
        call.resolve(["running": false])
    }

    @objc func isRunning(_ call: CAPPluginCall) {
        call.resolve(["running": running])
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard let call = pendingStart else { return }
        let status = currentStatus()
        if status == .notDetermined { return }   // the prompt is still up
        pendingStart = nil
        call.keepAlive = false
        if authorized(status) { begin(call) } else { call.reject("Location permission denied") }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        // Negative accuracy means the fix is invalid per CoreLocation's contract.
        if loc.horizontalAccuracy < 0 { return }
        notifyListeners("fix", data: [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "accuracy": loc.horizontalAccuracy,
            "speed": loc.speed >= 0 ? loc.speed : -1,
            "bearing": loc.course >= 0 ? loc.course : 0,
            "time": loc.timestamp.timeIntervalSince1970 * 1000
        ])
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Transient (no signal, denied mid-session). Nothing to tell JS that a
        // missing fix does not already say; the next successful update resumes.
    }
}
