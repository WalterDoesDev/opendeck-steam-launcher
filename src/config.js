const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expandHome } = require('./util');

function defaultOpenDeckDir() {
	if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'opendeck');
	if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opendeck');
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'opendeck');
	return path.join(os.homedir(), '.config', 'opendeck');
}

function defaultConfig() {
	const openDeckDir = defaultOpenDeckDir();
	return {
		openDeckConfigDir: openDeckDir,
		deviceId: null,
		keyCount: null,
		steamProfilesPrefix: 'Steam-Page',
		defaultProfileToExitTo: 'Default',
		showLogos: true,
		enhanceIcons: true,
		aiUpscale: true,
		showAppName: false,
		locationText: 'bottom',
		textSize: 12,
		steamInstall: null,
		useIcons: 'local',
		focusBackend: 'auto',
		display: null,
		checkProcess: true,
		pollIntervalMs: 800,
		focusStabilityPolls: 2,
		libraryRescanIntervalMs: 60000,
		restartOpenDeckOnLibraryChange: false,
		openDeckCommand: null,
		excludeAppIds: [],
		excludeNamePatterns: [],
	};
}

function deepMerge(base, override) {
	const out = { ...base };
	for (const key of Object.keys(override || {})) {
		const value = override[key];
		if (value === undefined) continue;
		if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])) {
			out[key] = deepMerge(base[key], value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function loadConfig(customPath) {
	const filePath = customPath || path.join(__dirname, '..', 'config.json');
	const defaults = defaultConfig();
	let user = {};
	if (fs.existsSync(filePath)) {
		try {
			user = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		} catch (error) {
			console.error(`Failed to parse config at ${filePath}: ${error.message}`);
		}
	}
	if (!fs.existsSync(filePath)) {
		const fresh = { ...defaults };
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
	}

	const merged = deepMerge(defaults, user);
	merged.openDeckConfigDir = expandHome(merged.openDeckConfigDir);
	if (merged.steamInstall) merged.steamInstall = expandHome(merged.steamInstall);
	if (merged.openDeckCommand) merged.openDeckCommand = expandHome(merged.openDeckCommand);
	if (merged.keyCount) merged.keyCount = Number(merged.keyCount);

	const userShort = JSON.parse(JSON.stringify(user));
	merged._configPath = filePath;
	merged._userValues = userShort;
	return merged;
}

module.exports = { loadConfig, defaultOpenDeckDir, defaultConfig, deepMerge };