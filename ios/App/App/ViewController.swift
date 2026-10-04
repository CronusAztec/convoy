import UIKit
import Capacitor

/// The app's bridge view controller. Capacitor registers the npm plugins
/// (App, Browser, Geolocation) by itself from capacitor.config.json; the one
/// plugin that lives in this target has to be handed to the bridge here.
class ViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundLocationPlugin())
    }
}
