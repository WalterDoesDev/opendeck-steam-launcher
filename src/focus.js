const { run, runRaw } = require('./util');
const fs = require('node:fs');
const path = require('node:path');

function commandExists(name) {
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
	const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
	for (const ext of exts) {
		for (const dir of dirs) {
			try {
				if (fs.existsSync(path.join(dir, name + ext))) return true;
			} catch (_) {}
		}
	}
	return false;
}

function detectBackend(preferred) {
	if (preferred && preferred !== 'auto') return preferred;
	if (process.platform === 'win32') return 'powershell';
	const order = ['xdotool', 'hyprctl', 'sway', 'ewmh'];
	for (const backend of order) {
		if (isAvailable(backend)) return backend;
	}
	return 'ewmh';
}

function isAvailable(backend) {
	switch (backend) {
		case 'xdotool':
			return commandExists('xdotool');
		case 'hyprctl':
			return Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE) && commandExists('hyprctl');
		case 'sway':
			return Boolean(process.env.SWAYSOCK) && commandExists('swaymsg');
		case 'ewmh':
			return commandExists('xprop');
		case 'powershell':
			return process.platform === 'win32';
		default:
			return true;
	}
}

function xpropValue(text) {
	const trimmed = (text || '').trim();
	const hex = /0x[0-9a-fA-F]+/.exec(trimmed);
	if (hex) return hex[0];
	const equals = /=\s*("?)([^"\n]+)\1/.exec(trimmed);
	return equals ? equals[2].trim() : null;
}

async function ewmhProbe(display) {
	const displayArg = display ? display : process.env.DISPLAY;
	const env = { ...process.env };
	if (displayArg) env.DISPLAY = displayArg;

	const active = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { env }).catch(() => ({ error: new Error('xprop missing') }));
	if (active.error) return null;

	const value = xpropValue(active.stdout);
	if (!value || value === '0' || value === '0x0') return { windowId: null };

	const windowId = /^0x[0-9a-fA-F]+$/.test(value) ? value : value;
	if (/^0x[0-9a-fA-F]+$/.test(windowId) === false) return { windowId: null };

	const info = await run('xprop', ['-id', windowId, 'WM_CLASS', 'WM_NAME'], { env }).catch(() => null);
	if (!info || info.error) return { windowId, classNames: [], title: '' };

	const classNames = [];
	let title = '';
	for (const rawLine of info.stdout.split('\n')) {
		const line = rawLine.trim();
		const match = /^([A-Z][A-Z0-9_]+)\([^)]*\)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		if (match[1] === 'WM_CLASS') {
			const parts = match[2].match(/"([^"]*)"/g) || [];
			for (const part of parts) classNames.push(part.replace(/"/g, ''));
		} else if (match[1] === 'WM_NAME') {
			title = match[2].replace(/"/g, '');
		}
	}
	return { windowId, classNames, title };
}

async function xdotoolProbe() {
	const cls = await run('xdotool', ['getactivewindow', 'getwindowclassname']);
	const name = await run('xdotool', ['getactivewindow', 'getwindowname']);
	const idResult = await run('xdotool', ['getactivewindow']);
	if (idResult.error || idResult.stdout.trim() === '' || /0x0/i.test(idResult.stdout)) return { windowId: null };
	return {
		windowId: idResult.stdout.trim(),
		classNames: cls.error ? [] : cls.stdout.trim().split(/\s+/),
		title: name.error ? '' : name.stdout.trim(),
	};
}

async function hyprctlProbe() {
	const res = await run('hyprctl', ['activewindow', '-j']);
	if (res.error) return null;
	try {
		const value = JSON.parse(res.stdout);
		if (!value || !value.class) return { windowId: null };
		return {
			windowId: String(value.address),
			classNames: [value.class, value.initialClass].filter(Boolean),
			title: value.title || '',
		};
	} catch (_) {
		return null;
	}
}

async function swayProbe() {
	const res = await run('swaymsg', ['-t', 'get_tree']);
	if (res.error) return null;
	try {
		const tree = JSON.parse(res.stdout);
		let found = null;
		const walk = (node) => {
			if (found) return;
			if (node.focused) {
				const cls = [];
				if (node.app_id) cls.push(node.app_id);
				if (typeof node.window_class === 'string') cls.push(node.window_class);
				const wmClass = node.window_properties && node.window_properties.class;
				if (wmClass) cls.push(wmClass);
				found = { windowId: String(node.id), classNames: cls, title: node.name || '' };
				return;
			}
			for (const child of node.nodes || []) walk(child);
			for (const child of node.floating_nodes || []) walk(child);
		};
		walk(tree);
		return found || { windowId: null };
	} catch (_) {
		return null;
	}
}

async function powershellProbe() {
	const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class FocusWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@;
Add-Type -TypeDefinition $sig -Language CSharp;
$h = [FocusWin]::GetForegroundWindow();
if ($h -eq [IntPtr]::Zero) { return; }
$pid2 = 0;
[void][FocusWin]::GetWindowThreadProcessId($h, [ref]$pid2);
$p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue;
if ($p) { $p.ProcessName } else { "" }
`;
	const res = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]).catch(() => null);
	if (!res || res.error) return null;
	const processName = (res.stdout || '').trim().split(/\r?\n/)[0] || '';
	return { processName, classNames: [processName], title: '' };
}

async function probeForeground(backend, options = {}) {
	try {
		switch (backend) {
			case 'xdotool':
				return await xdotoolProbe();
			case 'hyprctl':
				return await hyprctlProbe();
			case 'sway':
				return await swayProbe();
			case 'powershell':
				return await powershellProbe();
			case 'ewmh':
			default:
				return await ewmhProbe(options.display);
		}
	} catch (error) {
		return null;
	}
}

async function isSteamProcessRunning() {
	if (process.platform === 'win32') {
		const res = await run('tasklist', ['/FI', 'IMAGENAME eq steam.exe']).catch(() => null);
		if (!res) return false;
		return /steam\.exe/i.test(res.stdout);
	}
	const res = await runRaw("pgrep -x steam >/dev/null 2>&1; echo $?").catch(() => null);
	return res ? res.stdout.trim() === '0' : false;
}

function matchesSteam(foreground) {
	if (!foreground) return false;
	const candidates = [];
	if (Array.isArray(foreground.classNames)) candidates.push(...foreground.classNames);
	if (foreground.processName) candidates.push(foreground.processName);
	if (foreground.title) candidates.push(foreground.title);
	for (const candidate of candidates) {
		if (/steam/i.test(candidate)) return true;
	}
	return false;
}

async function steamFocused(backend, options = {}) {
	const running = options.checkProcess === false ? null : await isSteamProcessRunning();
	if (running === false) return { focused: false, running, foreground: null };
	const foreground = await probeForeground(backend, options);
	if (!foreground || !foreground.windowId) return { focused: false, running, foreground };
	return { focused: matchesSteam(foreground), running, foreground, backend };
}

module.exports = { detectBackend, probeForeground, steamFocused, isSteamProcessRunning, matchesSteam, ewmhProbe };