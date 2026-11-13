// Let Metro bundle the web app's dependency-free shared contract in ../src/lib (see src/lib/shared.ts).
const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../src/lib")]
module.exports = config
