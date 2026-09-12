const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { log, expandHome } = require('./util');
const { parseVdfFile, isBlock } = require('./vdf');

const APP_STATE_FULLY_INSTALLED = 4;

const DEFAULT_TOOL_APPIDS = new Set([
	'228980',
	'228981',
	'228983',
	'1070560',
	'1391110',
	'4183110',
	'1628350',
	'961940',
	'1493710',
	'1054830',
	'1580130',
	'4628710',
	'250820',
	'1996311',
	'1839100',
]);

const DEFAULT_TOOL_NAME_PATTERNS = [
	/^steamworks common redistributables/i,
	/^steam linux runtime/i,
	/^steam runtime/i,
	/^proton(\s|-)/i,
	/^steamvr(\s|$)/i,
	/^steam vr/i,
	/^steam india/i,
	/^steam beta/i,
];

function defaultSteamCandidates(platform) {
	const home = os.homedir();
	if (platform === 'win32') {
		return [
			path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
			path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
		];
	}
	return [
		path.join(home, '.local', 'share', 'Steam'),
		path.join(home, '.steam', 'steam'),
		path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
		'/var/lib/flatpak/app/com.valvesoftware.Steam/current/active/files/extra/Steam',
	];
}

function findSteamInstall(config) {
	if (config.steamInstall) {
		const dir = expandHome(config.steamInstall);
		if (fs.existsSync(path.join(dir, 'steamapps'))) return dir;
	}
	for (const candidate of defaultSteamCandidates(process.platform)) {
		try {
			if (fs.existsSync(path.join(candidate, 'steamapps'))) return candidate;
		} catch (_) {}
	}
	return null;
}

function resolveLibraryFolders(steamDir) {
	const libraries = [];
	const primaryApps = path.join(steamDir, 'steamapps');
	if (fs.existsSync(primaryApps)) libraries.push(steamDir);
	else if (fs.existsSync(path.join(steamDir, '..', 'steamapps'))) libraries.push(path.normalize(path.join(steamDir, '..')));

	const vdfPath = path.join(steamDir, 'steamapps', 'libraryfolders.vdf');
	const vdf = fs.existsSync(vdfPath) ? parseVdfFile(vdfPath, fs) : null;
	if (vdf && isBlock(vdf.libraryfolders)) {
		for (const key of Object.keys(vdf.libraryfolders)) {
			const entry = vdf.libraryfolders[key];
			if (!isBlock(entry) || typeof entry.path !== 'string' || !entry.path) continue;
			const lib = path.resolve(entry.path);
			if (!libraries.includes(lib) && fs.existsSync(path.join(lib, 'steamapps'))) libraries.push(lib);
		}
	}
	return libraries;
}

function readAppManifest(manifestPath) {
	const vdf = parseVdfFile(manifestPath, fs);
	if (!vdf) return null;
	const state = vdf.AppState || Object.values(vdf).find((v) => isBlock(v)) || null;
	if (!state) return null;
	const appid = String(state.appid ?? '');
	const name = (state.name ?? '').toString().trim();
	const installdir = (state.installdir ?? '').toString().trim();
	const stateFlags = Number(state.StateFlags ?? 0);
	if (!appid || !name) return null;
	return { appid, name, installdir, stateFlags };
}

function readInstalledApps(steamDir) {
	const libraries = resolveLibraryFolders(steamDir);
	const seen = new Set();
	const apps = [];

	for (const lib of libraries) {
		const appsDir = path.join(lib, 'steamapps');
		let entries;
		try {
			entries = fs.readdirSync(appsDir);
		} catch (_) {
			continue;
		}
		for (const entry of entries) {
			const match = /^appmanifest_(\d+)\.acf$/i.exec(entry);
			if (!match) continue;
			if (seen.has(match[1])) continue;
			seen.add(match[1]);
			const app = readAppManifest(path.join(appsDir, entry));
			if (app && (app.stateFlags & APP_STATE_FULLY_INSTALLED) !== 0) apps.push(app);
		}
	}
	return apps;
}

function buildToolFilters(config) {
	const denyAppIds = new Set([...DEFAULT_TOOL_APPIDS, ...(config.excludeAppIds || []).map((v) => String(v))]);
	const patterns = [
		...DEFAULT_TOOL_NAME_PATTERNS,
		...(config.excludeNamePatterns || []).map((v) => (v instanceof RegExp ? v : new RegExp(v, 'i'))),
	];
	return { denyAppIds, patterns };
}

function toGames(apps, filters) {
	const games = [];
	for (const app of apps) {
		const lower = app.name.toLowerCase();
		if (!filters.denyAppIds.has(app.appid) && !filters.patterns.some((re) => re.test(lower))) {
			games.push({ appid: app.appid, name: app.name, installdir: app.installdir });
		}
	}
	games.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
	return games;
}

function scanGames(config) {
	const steamDir = findSteamInstall(config);
	if (!steamDir) {
		log('warn', 'Steam installation not found');
		return { steamDir: null, apps: [], games: [], libraries: [] };
	}
	const apps = readInstalledApps(steamDir);
	const filters = buildToolFilters(config);
	const games = toGames(apps, filters);
	log('info', `Scanned ${apps.length} installed apps, ${games.length} playable games`, { steamDir });
	return { steamDir, apps, games, libraries: resolveLibraryFolders(steamDir), filters };
}

module.exports = { scanGames, buildToolFilters, toGames, findSteamInstall, resolveLibraryFolders, DEFAULT_TOOL_APPIDS, DEFAULT_TOOL_NAME_PATTERNS };