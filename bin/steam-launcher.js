#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const repoNode = path.join(__dirname, '..', '.node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const node = existsSync(repoNode) ? repoNode : process.execPath;
const main = path.join(__dirname, '..', 'src', 'daemon.js');

const child = spawn(node, [main, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});