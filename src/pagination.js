function layoutPages(games, keyCount) {
	const pages = [];
	let index = 0;
	const total = games.length;

	while (index < total) {
		const isFirst = pages.length === 0;
		const remaining = total - index;

		let take;
		if (isFirst) take = Math.min(remaining, keyCount - 1);
		else if (remaining <= keyCount - 1) take = remaining;
		else take = keyCount - 2;

		take = Math.max(1, take);
		const pageGames = games.slice(index, index + take);
		const pageNumber = pages.length + 1;
		index += take;

		pages.push({
			number: pageNumber,
			games: pageGames,
			prevProfile: pageNumber === 1 ? null : `Steam-Page-${pageNumber - 1}`,
			nextProfile: index < total ? `Steam-Page-${pageNumber + 1}` : null,
		});
	}

	return pages;
}

function slotFor(page) {
	const slots = [];
	const n = page.keyCount;
	if (page.isFirst) {
		for (let i = 0; i < page.games.length; i += 1) {
			slots[i] = { kind: 'game', game: page.games[i] };
		}
		slots[n - 1] = { kind: 'next' };
	} else if (page.isLast) {
		slots[0] = { kind: 'prev' };
		for (let i = 0; i < page.games.length; i += 1) {
			slots[i + 1] = { kind: 'game', game: page.games[i] };
		}
	} else {
		slots[0] = { kind: 'prev' };
		for (let i = 0; i < page.games.length; i += 1) {
			slots[i + 1] = { kind: 'game', game: page.games[i] };
		}
		slots[n - 1] = { kind: 'next' };
	}
	return slots;
}

function buildPagination(games, keyCount) {
	const pages = layoutPages(games, keyCount);
	return pages.map((page, pageIndex) => ({
		...page,
		isFirst: pageIndex === 0,
		isLast: pageIndex === pages.length - 1,
		keyCount,
	}));
}

module.exports = { buildPagination, layoutPages, slotFor };