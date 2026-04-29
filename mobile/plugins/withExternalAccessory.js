/**
 * Expo config plugin to add MFi External Accessory protocol strings to Info.plist.
 *
 * This is required for iOS to recognize the VLinker MS as an MFi accessory.
 * The protocol string must be obtained from Vgate (email support@vgate.com.cn).
 *
 * Usage in app.json:
 *   ["./plugins/withExternalAccessory", {
 *     "protocols": ["com.vgate.vlinkerms"]
 *   }]
 *
 * Once you have the real protocol string from Vgate, replace the placeholder.
 */
const { withInfoPlist } = require('expo/config-plugins');

function withExternalAccessory(config, { protocols = [] } = {}) {
  return withInfoPlist(config, (mod) => {
    // Add UISupportedExternalAccessoryProtocols
    mod.modResults.UISupportedExternalAccessoryProtocols = protocols;

    // Ensure Bluetooth usage description is set
    if (!mod.modResults.NSBluetoothAlwaysUsageDescription) {
      mod.modResults.NSBluetoothAlwaysUsageDescription =
        'ProMaster Dash connects to your VLinker OBD2 adapter via Bluetooth to read vehicle data.';
    }

    return mod;
  });
}

module.exports = withExternalAccessory;
