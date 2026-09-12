const { execFile, spawn } = require('node:child_process');
const { mkdirSync, writeFileSync, renameSync, existsSync } = require('node:fs');
const { dirname } = require('node:path');
const crypto = require('node:crypto');

function run(command, args, opts = {}) {
	return new Promise((resolve) => {
		execFile(command, args, { maxBuffer: 4 * 1024 * 1024, timeout: opts.timeoutMs || 4000, ...(opts.env ? { env: opts.env } : {}) }, (error, stdout, stderr) => {
			resolve({ error, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
		});
	});
}

function runRaw(command) {
	return new Promise((resolve) => {
		execFile('/bin/sh', ['-c', command], { timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ error, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
		});
	});
}

function spawnDetached(exe, args = []) {
	const child = process.platform === 'win32'
		? spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
		: spawn(exe, args, { detached: true, stdio: 'ignore' });
	child.unref();
	return child;
}

function expandHome(p) {
	if (!p) return p;
	if (p === '~') return process.env.HOME || process.env.USERPROFILE;
	if (p.startsWith('~/')) return (process.env.HOME || process.env.USERPROFILE || '') + p.slice(1);
	return p;
}

function atomicWriteJson(filePath, value) {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
	renameSync(tmp, filePath);
}

function stableHash(obj) {
	return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

function exists(p) {
	return existsSync(p);
}

function log(level, message, meta) {
	const ts = new Date().toISOString();
	const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
	process.stdout.write(`[${ts}][${level.toUpperCase()}] ${message}${extra}\n`);
}

function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = { run, runRaw, spawnDetached, expandHome, atomicWriteJson, stableHash, exists, log, clamp, isPlainObject };