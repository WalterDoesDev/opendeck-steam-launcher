const { log } = require('./util');

const TOKEN_STRING = 0;
const TOKEN_OPEN = 1;
const TOKEN_CLOSE = 2;
const TOKEN_EOF = 3;

function tokenize(text) {
	const tokens = [];
	let i = 0;
	const n = text.length;

	while (i < n) {
		const c = text[i];

		if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
			i += 1;
			continue;
		}

		if (c === '/') {
			if (text[i + 1] === '/') {
				while (i < n && text[i] !== '\n') i += 1;
				continue;
			}
			if (text[i + 1] === '*') {
				i += 2;
				while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
				i = Math.min(n, i + 2);
				continue;
			}
		}

		if (c === '{') {
			tokens.push({ type: TOKEN_OPEN, value: null });
			i += 1;
			continue;
		}

		if (c === '}') {
			tokens.push({ type: TOKEN_CLOSE, value: null });
			i += 1;
			continue;
		}

		if (c === '"') {
			let value = '';
			i += 1;
			while (i < n) {
				const ch = text[i];
				if (ch === '\\' && i + 1 < n) {
					value += text[i + 1];
					i += 2;
					continue;
				}
				if (ch === '"') {
					i += 1;
					break;
				}
				value += ch;
				i += 1;
			}
			tokens.push({ type: TOKEN_STRING, value });
			continue;
		}

		let value = '';
		while (i < n && !/[\s{}]/.test(text[i])) {
			value += text[i];
			i += 1;
		}
		tokens.push({ type: TOKEN_STRING, value });
	}

	tokens.push({ type: TOKEN_EOF, value: null });
	return tokens;
}

function parse(text) {
	const tokens = tokenize(text);
	let pos = 0;

	function next() {
		return tokens[pos];
	}

	function layer() {
		const out = {};
		while (true) {
			const token = next();
			if (token.type === TOKEN_EOF || token.type === TOKEN_CLOSE) {
				pos += 1;
				return out;
			}
			if (token.type !== TOKEN_STRING) {
				pos += 1;
				continue;
			}
			pos += 1;
			const key = token.value;
			const after = next();
			if (after.type === TOKEN_OPEN) {
				pos += 1;
				out[key] = layer();
			} else if (after.type === TOKEN_STRING) {
				pos += 1;
				out[key] = after.value;
			} else {
				out[key] = '';
			}
		}
	}

	if (next().type === TOKEN_OPEN) {
		pos += 1;
		return layer();
	}
	return layer();
}

function isBlock(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseVdfFile(filePath, fs) {
	try {
		const text = fs.readFileSync(filePath, 'utf8');
		return parse(text);
	} catch (error) {
		log('debug', `Failed to parse VDF ${filePath}: ${error.message}`);
		return null;
	}
}

module.exports = { parse, parseVdfFile, isBlock };