const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add CSV to asset extensions so we can import dtc_codes.csv
config.resolver.assetExts.push('csv');

module.exports = config;
