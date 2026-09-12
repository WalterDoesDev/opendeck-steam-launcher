const path = require('node:path');
const { scanGames } = require('./steam');
const { buildPagination } = require('./pagination');
const {
	discoverDeviceId,
	determineKeyCount,
	loadActionTemplates,
	readStarterPackManifest,
	generateProfiles,
} = require('./profiles');
const { steamFocused, detectBackend } = require('./focus');
const { OpenDeckControl } = require('./deck');
const { loadConfig } = require('./config');
const { log, stableHash, runRaw, spawnDetached } = require('./util');

function args() {
	const out = {
		configPath: null,
		once: false,
		dryRun: false,
		scanOnly: false,
	};
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--config') out.configPath = argv[i + 1];
		else if (arg === '--once' || arg === '--generate') out.once = true;
		else if (arg === '--dry-run') out.dryRun = true;
		else if (arg === '--scan') out.scanOnly = true;
	}
	return out;
}

class SteamLauncherDaemon {
	constructor(options) {
		this.config = options.config;
		this.dryRun = Boolean(options.dryRun);
		this.deviceId = null;
		this.keyCount = null;
		this.templates = null;
		this.gamesHash = null;
		this.active = false;
		this.raw = null;
		this.stability = 0;
	}

	async resolveDevice() {
		this.deviceId = discoverDeviceId(this.config);
		if (!this.deviceId) {
			log('warn', 'No OpenDeck device detected yet. Connect a Stream Deck and ensure OpenDeck is running.');
			return false;
		}
		this.keyCount = determineKeyCount(this.config, this.deviceId);
		const manifest = readStarterPackManifest(this.config);
		this.templates = loadActionTemplates(this.config, this.deviceId, manifest);
		if (this.deck) this.deck.deviceId = this.deviceId;
		log('info', `Device ${this.deviceId} active (${this.keyCount} keys)`);
		return true;
	}

	async regenerateProfiles() {
		if (!this.deviceId) await this.resolveDevice();
		if (!this.deviceId) return null;

		const scan = scanGames(this.config);
		if (!scan.steamDir) return null;

		const games = scan.games;
		const hash = stableHash(games.map((g) => `${g.appid}:${g.name}`));
		const changed = this.gamesHash !== null && this.gamesHash !== hash;
		this.gamesHash = hash;

		if (!this.templates) {
			const manifest = readStarterPackManifest(this.config);
			this.templates = loadActionTemplates(this.config, this.deviceId, manifest);
		}

		const pages = buildPagination(games, this.keyCount);
		if (pages.length === 0) {
			log('warn', 'No games found to paginate');
			return null;
		}

		const written = generateProfiles({
			config: this.config,
			deviceId: this.deviceId,
			keyCount: this.keyCount,
			pages,
			templates: this.templates,
			steamDir: scan.steamDir,
		});

		const stale = await this.cleanupStaleProfiles(pages.length);
		log('info', `Generated ${written.length} Steam profiles for ${games.length} games (${hash})`, { changed, stale });
		return { pages, changed, written };
	}

	async cleanupStaleProfiles(pageCount) {
		if (!this.deviceId) return 0;
		const { removeSync } = require('node:fs');
		const { join } = require('node:path');
		const profileDir = join(this.config.openDeckConfigDir, 'profiles', this.deviceId);
		let removed = 0;
		try {
			const entries = require('node:fs').readdirSync(profileDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const match = /^Steam-Page-(\d+)\.json$/i.exec(entry.name);
				if (!match) continue;
				const n = Number(match[1]);
				if (n > pageCount) {
					const file = join(profileDir, entry.name);
					const { unlinkSync } = require('node:fs');
					try {
						unlinkSync(file);
						removed += 1;
						log('info', `Removed stale profile ${entry.name}`);
					} catch (error) {
						log('warn', `Failed to remove ${entry.name}: ${error.message}`);
					}
				}
			}
		} catch (_) {}
		return removed;
	}

	async maybeRestartOpenDeck() {
		if (!this.config.restartOpenDeckOnLibraryChange) return false;
		const command = this.config.openDeckCommand || (process.platform === 'win32' ? 'opendeck.exe' : 'opendeck');
		await runRaw('pkill -TERM -x opendeck 2>/dev/null; pkill -TERM -x opendeck.exe 2>/dev/null; sleep 2; true');
		const child = spawnDetached(command, ['--hide']);
		log('info', 'OpenDeck restarted to load regenerated profiles');
		return Boolean(child);
	}

	async runOnce() {
		await this.resolveDevice();
		await this.regenerateProfiles();
	}

	async start() {
		const backend = detectBackend(this.config.focusBackend);
		log('info', `Focus backend selected: ${backend}`);

		await this.resolveDevice();
		await this.regenerateProfiles();

		this.deck = new OpenDeckControl({
			deviceId: this.deviceId,
			onConnect: () => {
				if (this.active) this.switchProfile('Steam-Page-1');
			},
		});
		this.deck.start();
		this.recoveryTimer = setInterval(() => {
			if (!this.deviceId) this.resolveDevice().catch(() => {});
		}, 3000);

		const poll = async () => {
			const result = await steamFocused(backend, {
				display: this.config.display,
				checkProcess: this.config.checkProcess,
			});
			this.handleFocusResult(result);
		};

		await poll();
		this.focusTimer = setInterval(poll, this.config.pollIntervalMs);

		if (this.config.pollIntervalMs > 0) {
			this.rescanTimer = setInterval(() => {
				this.rescanLibrary();
			}, Math.max(15000, this.config.libraryRescanIntervalMs));
		}

		log('info', 'Steam Launcher daemon started');
	}

	async rescanLibrary() {
		const wasUnresolved = !this.deviceId;
		await this.resolveDevice();
		if (wasUnresolved && this.deviceId) {
			this.templates = loadActionTemplates(this.config, this.deviceId, readStarterPackManifest(this.config));
		}

		const result = await this.regenerateProfiles();
		if (!result) return;

		if (result.changed) {
			if (this.config.restartOpenDeckOnLibraryChange) {
				await this.maybeRestartOpenDeck();
				setTimeout(() => {
					if (this.active) this.switchProfile('Steam-Page-1');
					if (!this.active) this.switchProfile(this.config.defaultProfileToExitTo);
				}, 4000);
			} else {
				log('info', 'Steam library changed. Restart OpenDeck (tray menu: Restart) to load the regenerated profiles.');
			}
		}
	}

	handleFocusResult(result) {
		const value = result ? Boolean(result.focused) : false;
		if (value !== this.raw) {
			this.raw = value;
			this.stability = 0;
		} else {
			this.stability += 1;
		}

		if (this.stability < this.config.focusStabilityPolls) return;
		if (typeof this.raw !== 'boolean') return;
		if (this.raw === this.active) return;

		this.active = this.raw;
		const target = this.active ? 'Steam-Page-1' : this.config.defaultProfileToExitTo;
		log('info', `Steam ${this.active ? 'focused — switching to' : 'unfocused/closed — switching back to'} ${target}`);
		this.switchProfile(target);
	}

	switchProfile(profileId) {
		if (this.dryRun) {
			log('info', `[dry-run] would switch to ${profileId}`);
			return;
		}
		this.deck.switchProfile(profileId);
	}

	async stop() {
		if (this.focusTimer) clearInterval(this.focusTimer);
		if (this.rescanTimer) clearInterval(this.rescanTimer);
		if (this.recoveryTimer) clearInterval(this.recoveryTimer);
		if (this.deck) this.deck.stop();
		log('info', 'Daemon stopped');
	}
}

async function main() {
	const options = args();
	const config = loadConfig(options.configPath);
	const daemon = new SteamLauncherDaemon({ config, dryRun: options.dryRun });

	if (options.scanOnly) {
		const scan = scanGames(config);
		if (scan.games) {
			console.log(`Steam: ${scan.steamDir}`);
			console.log(`Libraries: ${(scan.libraries || []).join(', ')}`);
			console.log(`Games (${scan.games.length}):`);
			for (const game of scan.games) console.log(`  ${game.appid}\t${game.name}`);
		}
		process.exit(0);
	}

	if (options.once) {
		await daemon.runOnce();
		process.exit(0);
	}

	await daemon.start();

	const shutdown = async () => {
		await daemon.stop();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

module.exports = { SteamLauncherDaemon, main, args };

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}