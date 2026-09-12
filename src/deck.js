const { log } = require('./util');

const ALTERNATIVE_UUID = 'opendeck_alternative_elgato_implementation';

class OpenDeckControl {
	constructor(options = {}) {
		this.deviceId = options.deviceId;
		this.ports = options.ports || [57116, 57118, 57120, 57122, 57124];
		this.running = false;
		this.ws = null;
		this.retryTimer = null;
		this.onConnect = options.onConnect || null;
		this.onClose = options.onClose || null;
	}

	start() {
		this.running = true;
		this.retryTimer = setTimeout(() => this.connect(), 300);
	}

	stop() {
		this.running = false;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		if (this.ws) {
			try {
				this.ws.onopen = null;
				this.ws.onclose = null;
				this.ws.onerror = null;
			} catch (_) {}
			try {
				this.ws.close();
			} catch (_) {}
			this.ws = null;
		}
	}

	async connect() {
		if (!this.running) return;
		if (this.ws) return;

		for (const port of this.ports) {
			const ws = new WebSocket(`ws://127.0.0.1:${port}`);
			const timer = setTimeout(() => {
				try {
					ws.close();
				} catch (_) {}
			}, 1500);
			const opened = await new Promise((resolve) => {
				ws.onopen = () => resolve(true);
				ws.onerror = () => resolve(false);
			}).finally(() => clearTimeout(timer));

			if (!opened) {
				try {
					ws.close();
				} catch (_) {}
				continue;
			}

			this.ws = ws;
			this._wire(ws, port);
			this._register(ws);
			return;
		}

		this._scheduleRetry();
	}

	_wire(ws, port) {
		ws.onerror = () => {};
		ws.onclose = () => {
			if (this.ws === ws) this.ws = null;
			if (this.onClose) this.onClose();
			this._scheduleRetry();
		};
		ws.onmessage = (event) => {
			try {
				const message = JSON.parse(String(event.data));
				if (message.event === 'deviceConnected' || message.event === 'deviceList') {
					log('info', 'OpenDeck device event received', message);
				}
			} catch (_) {}
		};
		this._port = port;
	}

	_register(ws) {
		const registerMessage = JSON.stringify({
			event: 'registerPlugin',
			uuid: ALTERNATIVE_UUID,
		});
		ws.send(registerMessage);
		log('info', `Connected to OpenDeck plugin WebSocket on port ${this._port}`);
		if (this.onConnect) this.onConnect();
	}

	_scheduleRetry() {
		if (!this.running || this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.connect().catch(() => this._scheduleRetry());
		}, 3000);
	}

	switchProfile(profileId) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			log('warn', `Cannot switch profile to "${profileId}": OpenDeck not connected`);
			return false;
		}
		const message = JSON.stringify({
			event: 'switchProfile',
			device: this.deviceId,
			profile: profileId,
		});
		try {
			this.ws.send(message);
			log('info', `Profile switch requested: ${profileId}`);
			return true;
		} catch (error) {
			log('warn', `Failed to send profile switch: ${error.message}`);
			return false;
		}
	}
}

module.exports = { OpenDeckControl, ALTERNATIVE_UUID };