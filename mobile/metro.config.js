// The app's pure TypeScript (engine, data model, change checks, safety review) lives in ../shared, where the
// desktop's MCP server (../mcp) uses the same files. Metro has to watch that folder and resolve packages from here.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders || []), path.resolve(__dirname, "../shared")];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
