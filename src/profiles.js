const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { log, atomicWriteJson } = require('./util');
const { slotFor } = require('./pagination');

const STARTERPACK_UUID = 'com.amansprojects.starterpack.sdPlugin';
const NAV_BG_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAJAAAACQCAIAAABoJHXvAAABaElEQVR4nO3RQQ3AIADAQJgNDCAB/8qmgRdpcqegSefaZ9DxvQ7gjmExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExhsUYFmNYjGExho2WHwieAZudd72+AAAAAElFTkSuQmCC';

function ensureNavBackground(config) {
	const rel = 'steam_launcher/nav_background.png';
	const file = path.join(config.openDeckConfigDir, rel);
	if (!fs.existsSync(file)) {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, Buffer.from(NAV_BG_PNG, 'base64'));
		} catch (_) {}
	}
	return rel;
}

const DEFAULT_STATE = {
	alignment: 'middle',
	background_colour: '#000000',
	colour: '#FFFFFF',
	family: 'Liberation Sans',
	image: '',
	image_scale: 100,
	name: '',
	show: true,
	size: 16,
	stroke_colour: '#000000',
	stroke_size: 3,
	style: 'Regular',
	text: '',
	underline: false,
};

function discoverDeviceId(config) {
	if (config.deviceId) return config.deviceId;
	const profilesRoot = path.join(config.openDeckConfigDir, 'profiles');
	let entries = [];
	try {
		entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
	} catch (error) {
		log('warn', `Cannot read profiles directory ${profilesRoot}: ${error.message}`);
		return null;
	}
	const candidates = entries
		.filter((e) => e.isFile() && e.name.endsWith('.json'))
		.map((e) => e.name.slice(0, -5))
		.filter((id) => id.startsWith('sd-'));
	if (candidates.length === 0) {
		const any = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name.slice(0, -5));
		return any[0] || null;
	}
	return candidates.sort()[0];
}

function determineKeyCount(config, deviceId) {
	if (config.keyCount && Number.isFinite(Number(config.keyCount)) && Number(config.keyCount) > 0) {
		return Number(config.keyCount);
	}
	if (deviceId) {
		const profileDir = path.join(config.openDeckConfigDir, 'profiles', deviceId);
		try {
			const files = fs.readdirSync(profileDir).filter((f) => /^.*\.json$/i.test(f) && !f.endsWith('.temp') && !f.endsWith('.bak'));
			let maxKeys = 0;
			for (const file of files) {
				try {
					const value = JSON.parse(fs.readFileSync(path.join(profileDir, file), 'utf8'));
					if (Array.isArray(value.keys)) maxKeys = Math.max(maxKeys, value.keys.length);
				} catch (_) {}
			}
			if (maxKeys > 0) {
				log('info', `Detected ${maxKeys}-key device from existing profiles`);
				return maxKeys;
			}
		} catch (_) {}
	}
	log('warn', 'Could not detect key count, defaulting to 15');
	return 15;
}

function loadDeviceProfiles(config, deviceId) {
	const profileDir = path.join(config.openDeckConfigDir, 'profiles', deviceId);
	const profiles = [];
	try {
		for (const file of fs.readdirSync(profileDir)) {
			if (!/^.*\.json$/i.test(file) || file.endsWith('.temp') || file.endsWith('.bak')) continue;
			try {
				profiles.push({ name: file.slice(0, -5), value: JSON.parse(fs.readFileSync(path.join(profileDir, file), 'utf8')) });
			} catch (_) {}
		}
	} catch (_) {}
	return profiles;
}

function findActionTemplate(profiles, uuid) {
	for (const profile of profiles) {
		if (!Array.isArray(profile.value.keys)) continue;
		for (const key of profile.value.keys) {
			if (key && key.action && key.action.uuid === uuid) return key.action;
		}
	}
	return null;
}

function actionFromManifest(manifest, uuid) {
	if (!manifest || !Array.isArray(manifest.Actions)) return null;
	const action = manifest.Actions.find((a) => a.UUID === uuid);
	if (!action) return null;
	const controllers = Array.isArray(action.Controllers) ? action.Controllers : ['Keypad'];
	return {
		controllers,
		disable_automatic_states: false,
		encoder: null,
		icon: `plugins/${STARTERPACK_UUID}/${action.Icon}.png`,
		name: action.Name || '',
		plugin: STARTERPACK_UUID,
		property_inspector: `plugins/${STARTERPACK_UUID}/${action.PropertyInspectorPath || ''}`,
		states: [
			{
				...DEFAULT_STATE,
				image: `plugins/${STARTERPACK_UUID}/${action.Icon}.png`,
			},
		],
		supported_in_multi_actions: Boolean(action.SupportedInMultiActions),
		tooltip: action.Tooltip || '',
		uuid,
		visible_in_action_list: true,
	};
}

function loadActionTemplates(config, deviceId, manifest) {
	let profiles = [];
	if (deviceId) profiles = loadDeviceProfiles(config, deviceId);
	let openUrl = findActionTemplate(profiles, 'com.amansprojects.starterpack.openurl');
	let switchProfile = findActionTemplate(profiles, 'com.amansprojects.starterpack.switchprofile');
	if (!openUrl) openUrl = actionFromManifest(manifest, 'com.amansprojects.starterpack.openurl');
	if (!switchProfile) switchProfile = actionFromManifest(manifest, 'com.amansprojects.starterpack.switchprofile');
	return { openUrl, switchProfile };
}

function readStarterPackManifest(config) {
	try {
		const manifestPath = path.join(config.openDeckConfigDir, 'plugins', STARTERPACK_UUID, 'manifest.json');
		return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (_) {
		return null;
	}
}

function shortenLabel(name, maxLines = 2, maxLen = 11) {
	const words = name.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
	const lines = [];
	let current = '';
	for (const word of words) {
		if (lines.length >= maxLines) break;
		const piece = word.length > maxLen ? `${word.slice(0, maxLen - 1)}…` : word;
		if (current && (`${current} ${piece}`).length > maxLen) {
			lines.push(current);
			current = '';
		}
		if (lines.length >= maxLines) break;
		current = current ? `${current} ${piece}` : piece;
		if (current.length > maxLen) {
			lines.push(current + '…');
			current = '';
		}
	}
	if (current && lines.length < maxLines) lines.push(current);
	if (lines.length === 0) lines.push(name.slice(0, maxLen));
	return lines.join('\n');
}

function gameKey({ game, actionTemplate, stateTemplate, iconPath, text, size, alignment }) {
	const state = { ...(stateTemplate || DEFAULT_STATE) };
	state.text = text || '';
	if (typeof size === 'number' && Number.isFinite(size) && size > 0) state.size = size;
	if (alignment) state.alignment = alignment;
	if (iconPath) {
		state.image = iconPath;
		state.image_scale = 100;
	}
	return {
		action: actionTemplate,
		children: null,
		context: '',
		current_state: 0,
		settings: {
			anticlockwise: '',
			clockwise: '',
			down: `steam://rungameid/${game.appid}`,
			up: '',
		},
		states: [state],
	};
}

function navKey({ kind, targetProfile, deviceId, actionTemplate, stateTemplate, navImage }) {
	const state = { ...(stateTemplate || DEFAULT_STATE) };
	state.image = navImage || '';
	state.text = kind === 'next' ? 'Next' : '‹ Prev';
	const settings = {
		anticlockwise: 'Default',
		clockwise: 'Default',
		device: deviceId,
		profile: targetProfile,
	};
	return {
		action: actionTemplate,
		children: null,
		context: '',
		current_state: 0,
		settings,
		states: [state],
	};
}

function layoutKeySlots(page, keyCount) {
	const slots = slotFor({ ...page, keyCount });
	const out = [];
	for (let i = 0; i < keyCount; i += 1) {
		out.push(slots[i] || null);
	}
	return out;
}

function normaliseAlignment(locationText) {
	const value = String(locationText || 'bottom').trim().toLowerCase();
	if (value === 'center' || value === 'middle' || value === 'centre') return 'middle';
	if (value === 'top' || value === 'bottom') return value;
	if (value === 'left' || value === 'right') return value;
	return 'bottom';
}

function buildPageProfile({ page, deviceId, keyCount, templates, iconPaths, opts, navImage }) {
	const keys = [];
	const slots = layoutKeySlots(page, keyCount);
	for (let i = 0; i < keyCount; i += 1) {
		const slot = slots[i];
		if (!slot) {
			keys.push(null);
			continue;
		}
		const context = `Keypad.${i}.0`;
		let key;
		if (slot.kind === 'game') {
			key = gameKey({
				game: slot.game,
				actionTemplate: templates.openUrl,
				stateTemplate: templates.openUrl && templates.openUrl.states ? templates.openUrl.states[0] : null,
				iconPath: iconPaths && iconPaths[slot.game.appid],
				text: opts.showAppName ? shortenLabel(slot.game.name) : '',
				size: opts.textSize,
				alignment: opts.alignment,
			});
		} else if (slot.kind === 'next') {
			key = navKey({
				kind: 'next',
				targetProfile: page.nextProfile,
				deviceId,
				actionTemplate: templates.switchProfile,
				stateTemplate: templates.switchProfile && templates.switchProfile.states ? templates.switchProfile.states[0] : null,
				navImage,
			});
		} else {
			key = navKey({
				kind: 'prev',
				targetProfile: page.prevProfile,
				deviceId,
				actionTemplate: templates.switchProfile,
				stateTemplate: templates.switchProfile && templates.switchProfile.states ? templates.switchProfile.states[0] : null,
				navImage,
			});
		}
		key.context = context;
		keys.push(key);
	}
	return { infobars: [], keys, sliders: [] };
}

const ICON_FILE_RE = /^[0-9a-f]{40}\.(jpg|jpeg|png)$/i;

function findClientIcon(appidDir) {
	let best = null;
	try {
		for (const entry of fs.readdirSync(appidDir, { withFileTypes: true })) {
			if (!entry.isFile() || !ICON_FILE_RE.test(entry.name)) continue;
			const file = path.join(appidDir, entry.name);
			let size = 0;
			try {
				size = fs.statSync(file).size;
			} catch (_) {
				continue;
			}
			if (!best || size < best.size) best = { file, size };
		}
	} catch (_) {}
	return best ? best.file : null;
}

function collectLogos(config, games, steamDir) {
	const cacheRoots = [];
	if (steamDir) cacheRoots.push(steamDir);
	if (config.steamInstall) cacheRoots.push(config.steamInstall);

	const found = {};
	for (const game of games) {
		for (const root of cacheRoots) {
			const appidDir = path.join(root, 'appcache', 'librarycache', String(game.appid));
			const icon = findClientIcon(appidDir);
			if (icon) {
				found[game.appid] = icon;
				break;
			}
			const logo = path.join(appidDir, 'logo.png');
			if (fs.existsSync(logo)) {
				found[game.appid] = logo;
				break;
			}
		}
	}
	return found;
}

function copyIfDifferent(source, destination) {
	if (fs.existsSync(destination)) {
		try {
			const a = fs.statSync(source);
			const b = fs.statSync(destination);
			if (a.size === b.size && a.mtimeMs === b.mtimeMs) return false;
		} catch (_) {}
	}
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(source, destination);
	try {
		const st = fs.statSync(source);
		fs.utimesSync(destination, st.atime, st.mtime);
	} catch (_) {}
	return true;
}

const ART_CANDIDATES = ['library_600x900.jpg', 'library_hero.jpg', 'header.jpg'];

function collectArt(config, games, steamDir) {
	const cacheRoots = [];
	if (steamDir) cacheRoots.push(steamDir);
	if (config.steamInstall) cacheRoots.push(config.steamInstall);

	const found = {};
	for (const game of games) {
		for (const root of cacheRoots) {
			const appidDir = path.join(root, 'appcache', 'librarycache', String(game.appid));
			for (const candidate of ART_CANDIDATES) {
				const file = path.join(appidDir, candidate);
				if (fs.existsSync(file)) {
					found[game.appid] = file;
					break;
				}
			}
		}
	}
	return found;
}

function aiUpscaleIcons(config, iconPaths) {
	const bin = path.join(__dirname, '..', 'vendor', 'realesrgan', 'realesrgan-ncnn-vulkan');
	if (!fs.existsSync(bin)) return {};
	const outDir = path.join(config.openDeckConfigDir, 'steam_launcher', 'ai');
	const cachePath = path.join(outDir, '.cache.json');
	let cache = {};
	try {
		cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
	} catch (_) {}
	fs.mkdirSync(outDir, { recursive: true });

	const done = {};
	for (const [appid, rel] of Object.entries(iconPaths || {})) {
		const src = path.join(config.openDeckConfigDir, rel);
		const out = path.join(outDir, `${appid}.png`);
		let m = 0;
		let s = 0;
		try {
			const st = fs.statSync(src);
			m = st.mtimeMs;
			s = st.size;
		} catch (_) {
			continue;
		}
		const key = String(appid);
		if (cache[key] && cache[key].m === m && cache[key].s === s && fs.existsSync(out)) {
			done[appid] = `steam_launcher/ai/${appid}.png`;
			continue;
		}
		const r = childProcess.spawnSync(bin, ['-i', src, '-o', out, '-s', '4', '-n', 'realesrgan-x4plus'], {
			encoding: 'utf8',
			stdio: ['ignore', 'ignore', 'pipe'],
			timeout: 60000,
		});
		if (r.status === 0 && fs.existsSync(out)) {
			cache[key] = { m, s };
			done[appid] = `steam_launcher/ai/${appid}.png`;
		} else {
			console.error(`[aiUpscale] ${appid} failed (${r.status}): ${(r.stderr || '').trim().slice(0, 200)}`);
		}
	}
	try {
		fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
	} catch (_) {}
	return done;
}

function enhanceLogos(config, iconPaths, arts) {
	const pyScript = path.join(__dirname, '..', 'bin', 'enhanceIcons.py');
	const cBin = path.join(__dirname, '..', 'bin', 'enhance_icons');
	const outDir = path.join(config.openDeckConfigDir, 'steam_launcher', 'enhanced');
	const jobs = [];
	for (const [appid, rel] of Object.entries(iconPaths || {})) {
		jobs.push({ appid: Number(appid), icon: path.join(config.openDeckConfigDir, rel), art: arts && arts[appid] ? arts[appid] : null });
	}
	if (!jobs.length) return {};

	const manifestPath = path.join(os.tmpdir(), `opendeck-enhance-manifest-${process.pid}.txt`);
	const lines = jobs.map((j) => `${j.appid}\t${j.icon}${j.art ? `\t${j.art}` : ''}`);
	fs.writeFileSync(manifestPath, lines.join('\n') + '\n');
	fs.mkdirSync(outDir, { recursive: true });

	try {
		if (fs.existsSync(cBin)) {
			const r = childProcess.spawnSync(cBin, ['--manifest', manifestPath, '--outdir', outDir], { encoding: 'utf8' });
			if (r.status === 0) {
				const done = parseDone(r.stdout);
				if (done.length) return doneToMap(done);
			}
			console.error(`[enhanceLogos] enhance_icons reported failure; falling back to python`);
		}
		const r = childProcess.spawnSync('python3', [pyScript, '--infile', manifestPath, '--outdir', outDir], { encoding: 'utf8' });
		if (r.status === 0) return doneToMap(parseDone(r.stdout));
		console.error(`[enhanceLogos] python3 failed (${r.status}): ${(r.stderr || '').trim()}`);
		return {};
	} finally {
		try {
			fs.unlinkSync(manifestPath);
		} catch (_) {}
	}
}

function parseDone(stdout) {
	try {
		return JSON.parse((stdout || '').trim()).done || [];
	} catch (_) {
		return [];
	}
}

function doneToMap(done) {
	const enhanced = {};
	for (const appid of done) {
		enhanced[String(appid)] = `steam_launcher/enhanced/${String(appid)}.png`;
	}
	return enhanced;
}

function syncLogos(config, logoSources) {
	const outDir = path.join(config.openDeckConfigDir, 'steam_launcher');
	const installed = {};
	for (const [appid, source] of Object.entries(logoSources || {})) {
		const ext = path.extname(source).replace(/^\./, '') || 'png';
		const destination = path.join(outDir, `${appid}.${ext}`);
		copyIfDifferent(source, destination);
		installed[appid] = `steam_launcher/${appid}.${ext}`;
	}
	fs.mkdirSync(outDir, { recursive: true });
	const targets = new Set(Object.values(installed).map((rel) => path.basename(rel)));
	targets.add('nav_background.png');
	try {
		for (const entry of fs.readdirSync(outDir)) {
			if (targets.has(entry)) continue;
			try {
				fs.unlinkSync(path.join(outDir, entry));
			} catch (_) {}
		}
	} catch (_) {}
	return installed;
}

function generateProfiles({ config, deviceId, keyCount, pages, templates, steamDir }) {
	const profileDir = path.join(config.openDeckConfigDir, 'profiles', deviceId);
	fs.mkdirSync(profileDir, { recursive: true });

	const showLogos = config.showLogos !== false && config.useIcons !== 'off';
	const opts = {
		showAppName: config.showAppName === true,
		textSize: Number.isFinite(Number(config.textSize)) && Number(config.textSize) > 0 ? Number(config.textSize) : 12,
		alignment: normaliseAlignment(config.locationText),
	};

	let iconPaths = {};
	if (showLogos) {
		const allGames = pages.flatMap((p) => p.games);
		const logos = collectLogos(config, allGames, steamDir);
		iconPaths = syncLogos(config, logos);
		if (config.enhanceIcons !== false) {
			let iconPool = iconPaths;
			if (config.aiUpscale !== false) {
				const ai = aiUpscaleIcons(config, iconPaths);
				if (Object.keys(ai).length) {
					log('info', `AI-upscaled ${Object.keys(ai).length} icons with Real-ESRGAN`);
					iconPool = { ...iconPaths, ...ai };
				}
			}
			const arts = collectArt(config, allGames, steamDir);
			const enhanced = enhanceLogos(config, iconPool, arts);
			if (Object.keys(enhanced).length) {
				log('info', `Enhanced ${Object.keys(enhanced).length} icons with blurred-art backdrops`);
				iconPaths = { ...iconPaths, ...enhanced };
			}
		}
	}

	const navImage = ensureNavBackground(config);

	const writtenProfiles = [];
	for (const page of pages) {
		const profileName = `Steam-Page-${page.number}`;
		const profile = buildPageProfile({ page, deviceId, keyCount, templates, iconPaths, opts, navImage });
		const filePath = path.join(profileDir, `${profileName}.json`);
		atomicWriteJson(filePath, profile);
		writtenProfiles.push({ profileName, filePath, page });
	}
	return writtenProfiles;
}

module.exports = {
	discoverDeviceId,
	determineKeyCount,
	loadActionTemplates,
	readStarterPackManifest,
	generateProfiles,
	collectLogos,
	aiUpscaleIcons,
	shortenLabel,
	DEFAULT_STATE,
	STARTERPACK_UUID,
};