const MAX_ACTIVE_THREADS = 5;
const MAX_PARALLEL_DOWNLOADS = 5;

// Download status constants
const DOWNLOAD_STATUS = {
	unknown: 0,
	started: 1,
	completed: 2,
	refresh: 3
};

// State constants
const STATE = {
	ready: 'ready',
	in_progress: 'in-progress',
	completed: 'completed',
	paused: 'paused',
	canceled: 'canceled',
	interrupted: 'error'
};

const tabs = {};
const dataTemplate = {
	articles: [],
	results: [],
	extensions: [],
	max: 0,
	loop: 0,
	scanDone: false,
	baseUri: '',
	downloadProgressData: [],
	interval: null,
	downloadStatus: 0,
	activeProcesCnt: 0,
	pageHref: '',
	collectionIdentifier: '',
	isSingleItem: false,
	isSearch: false,
	isUserProfile: false,
	allParams: {}
};

function _copyObject(obj) {
	return JSON.parse(JSON.stringify(obj));
}

function clearData(tabId) {
	tabs[tabId] = _copyObject(dataTemplate);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Storage persistence helpers
const saveScanState = async (tabId) => {
	const data = tabs[tabId];
	if (!data) return;
	try {
		const snapshot = {
			tabId: data.tabId,
			pageHref: data.pageHref,
			collectionIdentifier: data.collectionIdentifier,
			isSingleItem: data.isSingleItem,
			isSearch: data.isSearch,
			isUserProfile: data.isUserProfile,
			allParams: data.allParams,
			results: data.results || [],
			extensions: data.extensions || [],
			articles: data.articles || [],
			loop: data.loop || 0,
			max: data.max || 0,
			scanDone: data.scanDone || false,
			isFetchingIdentifiers: data.isFetchingIdentifiers || false,
			isProcessingArticles: data.isProcessingArticles || false,
			downloadStatus: data.downloadStatus || 0,
			downloadProgressData: data.downloadProgressData || []
		};
		await chrome.storage.local.set({ [`archive_scan_${tabId}`]: snapshot });
	} catch (e) {
		console.warn('saveScanState error:', e);
	}
};

let saveTimeouts = {};
const saveScanStateDebounced = (tabId) => {
	if (saveTimeouts[tabId]) clearTimeout(saveTimeouts[tabId]);
	saveTimeouts[tabId] = setTimeout(() => {
		saveScanState(tabId);
	}, 200);
};

const loadScanState = async (tabId) => {
	try {
		const key = `archive_scan_${tabId}`;
		const res = await chrome.storage.local.get(key);
		if (res && res[key]) {
			tabs[tabId] = {
				..._copyObject(dataTemplate),
				...res[key],
				isProcessingArticles: false
			};
			return tabs[tabId];
		}
	} catch (e) {
		console.warn('loadScanState error:', e);
	}
	return null;
};

const clearScanState = async (tabId) => {
	delete tabs[tabId];
	try {
		await chrome.storage.local.remove(`archive_scan_${tabId}`);
	} catch (e) {
		// Ignore
	}
};

let keepAliveInterval = null;
function ensureKeepAlive() {
	if (keepAliveInterval) return;
	keepAliveInterval = setInterval(() => {
		const isAnyActive = Object.values(tabs).some(t =>
			(t.isProcessingArticles && !t.scanDone) ||
			t.isFetchingIdentifiers ||
			(t.downloadStatus === 1)
		);
		if (!isAnyActive) {
			clearInterval(keepAliveInterval);
			keepAliveInterval = null;
			return;
		}
		try {
			chrome.runtime.getPlatformInfo(() => {});
		} catch (e) {}
	}, 10000);
}

// Manifest V3 için declarativeContent yerine action.onClicked kullanıyoruz
chrome.action.onClicked.addListener(function (tab) {
	if (tab.url && tab.url.includes('archive.org')) {
		// Popup açılacak, ek işlem gerekmez
	}
});

const scanAbortControllers = {};

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
	let data;
	switch (message.action) {
		case 'startFetching':
			if (scanAbortControllers[message.tabId]) {
				try { scanAbortControllers[message.tabId].abort(); } catch (e) {}
			}
			scanAbortControllers[message.tabId] = new AbortController();

			tabs[message.tabId] = _copyObject(dataTemplate);
			data = tabs[message.tabId];
			data.tabId = message.tabId;
			data.pageHref = message.url;
			data.collectionIdentifier = message.collectionIdentifier;
			data.isSingleItem = message.isSingleItem || false;
			data.isSearch = message.isSearch || false;
			data.isUserProfile = message.isUserProfile || false;
			data.visibleIdentifiers = message.visibleIdentifiers || [];
			data.allParams = message.allParams || {};
			data.scanDone = false;
			data.results = [];
			data.extensions = [];
			data.loop = 0;
			data.max = 0;

			saveScanState(message.tabId);
			ensureKeepAlive();

			if (!data.isFetchingIdentifiers) {
				fetchAllItemIdentifiers(message.tabId);
			}
			break;

		case 'stopFetching':
			if (scanAbortControllers[message.tabId]) {
				try { scanAbortControllers[message.tabId].abort(); } catch (e) {}
			}
			if (tabs[message.tabId]) {
				tabs[message.tabId].scanDone = true;
				tabs[message.tabId].articles = [];
				saveScanState(message.tabId);
				sendMessageSafe({
					action: 'updateProgress',
					message: `Scan stopped by user. ${tabs[message.tabId].loop} items processed.`,
					tabId: message.tabId
				});
			}
			break;

		case 'startDownload':
			if (tabs[message.tabId]) {
				startDownload(message.tabId, message.data);
				ensureKeepAlive();
			}
			break;

		case 'clearScanState':
			if (scanAbortControllers[message.tabId]) {
				try { scanAbortControllers[message.tabId].abort(); } catch (e) {}
			}
			clearScanState(message.tabId);
			break;

		case 'getDownloadProgress':
			(async () => {
				let data = tabs[message.tabId];
				if (!data) data = await loadScanState(message.tabId);
				if (data) {
					sendResponse({ progress: getDownloadProgress(message.tabId) });
				} else {
					sendResponse({ progress: [] });
				}
			})();
			return true;
			break;

		case 'getDownloadStatus':
			(async () => {
				let data = tabs[message.tabId];
				if (!data) data = await loadScanState(message.tabId);
				if (data) {
					sendResponse({ status: getDownloadStatus(message.tabId) });
				} else {
					sendResponse({ status: DOWNLOAD_STATUS.unknown });
				}
			})();
			return true;
			break;

		case 'resetStatus':
			if (tabs[message.tabId]) {
				resetStatus(message.tabId);
			}
			clearScanState(message.tabId);
			break;

		case 'getExtensions':
			(async () => {
				let data = tabs[message.tabId];
				if (!data) data = await loadScanState(message.tabId);
				if (data) {
					sendResponse({ extensions: getExtensions(message.tabId) });
				} else {
					sendResponse({ extensions: [] });
				}
			})();
			return true;
			break;

		case 'getResults':
			(async () => {
				let data = tabs[message.tabId];
				if (!data) {
					data = await loadScanState(message.tabId);
				}
				if (data) {
					// Resume background scanning if it was suspended mid-scan
					if (!data.scanDone && data.articles && data.articles.length > 0 && (data.loop < data.max)) {
						startProcessingArticles(message.tabId);
					}
					sendResponse({
						exists: true,
						pageHref: data.pageHref || '',
						results: data.results || [],
						extensions: data.extensions || [],
						scanDone: data.scanDone || false,
						isFetchingIdentifiers: data.isFetchingIdentifiers || false,
						isProcessingArticles: data.isProcessingArticles || false,
						current: data.loop || 0,
						max: data.max || 0,
						downloadStatus: data.downloadStatus || 0
					});
				} else {
					sendResponse({ exists: false, results: [], extensions: [], scanDone: true });
				}
			})();
			return true;
			break;

		case 'retryFailedDownloads':
			if (tabs[message.tabId]) {
				const data = tabs[message.tabId];
				let retriedCount = 0;
				if (data.downloadProgressData) {
					data.downloadProgressData.forEach(item => {
						if (item.state === STATE.interrupted || item.state === STATE.canceled) {
							item.state = STATE.ready;
							item.id = 0; // Reset download ID
							item.errorMsg = null;
							retriedCount++;
							console.log('Retrying download:', item.url);
						}
					});
				}

				if (retriedCount > 0) {
					data.downloadStatus = DOWNLOAD_STATUS.started;
					if (data.interval) clearInterval(data.interval);
					data.interval = setInterval(function () {
						_checkDownloads(message.tabId);
					}, 1000);
					ensureKeepAlive();
					sendResponse({ count: retriedCount });
				} else {
					sendResponse({ count: 0 });
				}
			}
			return true;
			break;

		case 'pauseDownloads':
			if (tabs[message.tabId]) {
				const data = tabs[message.tabId];
				data.isPaused = true;
				if (data.downloadProgressData) {
					data.downloadProgressData.forEach(item => {
						if ((item.state === STATE.in_progress || item.state === 'starting') && item.id) {
							try {
								chrome.downloads.pause(item.id, () => {});
								item.state = 'paused';
							} catch (e) {}
						}
					});
				}
				sendResponse({ success: true });
			}
			return true;
			break;

		case 'resumeDownloads':
			if (tabs[message.tabId]) {
				const data = tabs[message.tabId];
				data.isPaused = false;
				if (data.downloadProgressData) {
					data.downloadProgressData.forEach(item => {
						if (item.state === 'paused' && item.id) {
							try {
								chrome.downloads.resume(item.id, () => {});
								item.state = STATE.in_progress;
							} catch (e) {}
						}
					});
				}
				_checkDownloads(message.tabId);
				sendResponse({ success: true });
			}
			return true;
			break;

		case 'cancelDownloads':
			if (tabs[message.tabId]) {
				const data = tabs[message.tabId];
				data.isPaused = false;
				if (data.interval) clearInterval(data.interval);
				if (data.downloadProgressData) {
					data.downloadProgressData.forEach(item => {
						if ((item.state === STATE.in_progress || item.state === 'paused' || item.state === 'starting') && item.id) {
							try {
								chrome.downloads.cancel(item.id, () => {});
							} catch (e) {}
						}
						item.state = STATE.canceled;
					});
				}
				data.downloadStatus = DOWNLOAD_STATUS.unknown;
				sendResponse({ success: true });
			}
			return true;
			break;

		case 'getProgress':
			(async () => {
				let data = tabs[message.tabId];
				if (!data) data = await loadScanState(message.tabId);
				if (data) {
					sendResponse({
						current: data.loop || 0,
						max: data.max || 0,
						scanDone: data.scanDone || false,
						isFetchingIdentifiers: data.isFetchingIdentifiers || false
					});
				} else {
					sendResponse({ current: 0, max: 0, scanDone: true });
				}
			})();
			return true;
			break;
	}
});

chrome.tabs.onUpdated.addListener(async function (tabId, change, tab) {
	const currentUrl = (change.url || (tab && tab.url) || '').replace(/\/+$/, '').split('#')[0];
	if (!currentUrl) return;

	let data = tabs[tabId];
	if (!data) {
		data = await loadScanState(tabId);
	}
	if (data && data.pageHref) {
		const oldUrl = data.pageHref.replace(/\/+$/, '').split('#')[0];
		if (!currentUrl.includes('archive.org') || oldUrl !== currentUrl) {
			console.log('Clearing data for tabId:', tabId, 'due to URL change from', oldUrl, 'to', currentUrl);
			if (scanAbortControllers[tabId]) {
				try { scanAbortControllers[tabId].abort(); } catch (e) {}
			}
			clearScanState(tabId);
		}
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	clearScanState(tabId);
});

// Manifest V3'te getViews yerine farklı bir yaklaşım kullanıyoruz
function getPopup() {
	// Manifest V3'te popup view'larına doğrudan erişim yok
	// Bunun yerine message passing kullanıyoruz
	return null;
}

const LANGUAGE_CODES = {
	'japanese': 'jpn',
	'middle dutch': 'dum',
	'dutch': 'dut',
	'turkish': 'tur',
	'english': 'eng',
	'german': 'ger',
	'french': 'fre',
	'spanish': 'spa',
	'italian': 'ita',
	'russian': 'rus',
	'arabic': 'ara',
	'chinese': 'chi',
	'portuguese': 'por',
	'latin': 'lat',
	'greek': 'gre',
	'hebrew': 'heb',
	'persian': 'per',
	'swedish': 'swe',
	'polish': 'pol',
	'korean': 'kor',
	'hindi': 'hin'
};

function buildFacetQuery(rawFilters, collectionIdentifier) {
	if (!rawFilters) return '';
	const filterList = Array.isArray(rawFilters) ? rawFilters : [rawFilters];
	const fieldGroups = {};
	const freeTexts = [];

	filterList.forEach(f => {
		if (!f) return;
		let clean = f.replace(/~/g, ' ').replace(/\+/g, ' ').trim();
		if (clean.startsWith('-')) clean = clean.substring(1).trim();

		const m = clean.match(/^([^:]+):"(.+)"$/) || clean.match(/^([^:]+):'(.+)'$/) || clean.match(/^([^:]+):(.+)$/);
		if (m) {
			const field = m[1].trim();
			let val = m[2].replace(/^['"]+|['"]+$/g, '').trim();

			if (field === 'mediatype' && val.toLowerCase() === (collectionIdentifier || '').toLowerCase() && !filterList.some(x => x.includes('mediatype') && !x.includes(val))) {
				return;
			}

			if (!fieldGroups[field]) fieldGroups[field] = [];
			if (!fieldGroups[field].includes(val)) fieldGroups[field].push(val);
		} else {
			if (!freeTexts.includes(clean)) freeTexts.push(clean);
		}
	});

	const clauseParts = [];

	for (const [field, values] of Object.entries(fieldGroups)) {
		if (values.length === 1) {
			const val = values[0];
			if (field === 'language') {
				const iso = LANGUAGE_CODES[val.toLowerCase()];
				if (iso) clauseParts.push(`(language:"${val}" OR language:${iso} OR "${val}")`);
				else clauseParts.push(`(language:"${val}" OR "${val}")`);
			} else {
				clauseParts.push(`${field}:"${val}"`);
			}
		} else {
			const orItems = values.map(val => {
				if (field === 'language') {
					const iso = LANGUAGE_CODES[val.toLowerCase()];
					if (iso) return `(language:"${val}" OR language:${iso})`;
					return `language:"${val}"`;
				}
				return `${field}:"${val}"`;
			});
			clauseParts.push(`(${orItems.join(' OR ')})`);
		}
	}

	if (freeTexts.length > 0) {
		clauseParts.push(`(${freeTexts.map(t => `"${t}"`).join(' OR ')})`);
	}

	return clauseParts.join(' AND ');
}

// New API-based functions
const fetchAllItemIdentifiers = async (tabId) => {
	const data = tabs[tabId];
	if (!data) {
		console.error('Data not found for tabId:', tabId);
		return;
	}

	const TOP_LEVEL_MEDIATYPES = new Set(['texts', 'movies', 'audio', 'software', 'image', 'etree', 'web']);
	const isTopLevel = TOP_LEVEL_MEDIATYPES.has(data.collectionIdentifier);
	const hasFilterParams = data.allParams && (data.allParams['and[]'] || data.allParams['and'] || data.allParams.query || data.allParams.q);

	// Check if this is a Search Page, User Profile, Top-Level category, or Filtered collection scan
	if (data.isSearch || data.isUserProfile || isTopLevel || hasFilterParams) {
		let query = '';
		
		if (data.isUserProfile) {
			const cleanHandle = data.collectionIdentifier.replace(/^@/, '');
			
			// Priority 1: Check if visibleIdentifiers from the active page gives the exact uploader account
			if (data.visibleIdentifiers && data.visibleIdentifiers.length > 0) {
				for (const id of data.visibleIdentifiers) {
					try {
						const metaResp = await fetch(`https://archive.org/metadata/${id}`);
						const metaData = await metaResp.json();
						if (metaData && metaData.metadata && metaData.metadata.uploader && metaData.metadata.uploader !== 'user-admin@archive.org') {
							query = `uploader:("${metaData.metadata.uploader}")`;
							console.log(`Profile uploader resolved from page item: ${metaData.metadata.uploader}`);
							break;
						}
					} catch (e) {}
				}
			}

			// Priority 2: Direct check for uploader or creator with handle
			if (!query) {
				let uploaderQuery = `(uploader:"${data.collectionIdentifier}" OR uploader:"${cleanHandle}" OR creator:"${data.collectionIdentifier}" OR creator:"${cleanHandle}")`;
				try {
					const testResp = await fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(uploaderQuery)}&rows=1&output=json`);
					const testData = await testResp.json();
					if (testData.response && testData.response.numFound > 0) {
						query = uploaderQuery;
					}
				} catch (e) {}
			}

			// Priority 3: Check favorites collection for real account username
			if (!query) {
				try {
					const favResp = await fetch(`https://archive.org/metadata/fav-${cleanHandle}`);
					const favData = await favResp.json();
					if (favData.metadata && favData.metadata.title) {
						const username = favData.metadata.title.replace(/\s+Favorites$/i, '').trim();
						if (username && username !== 'archive.org Member') {
							query = `(uploader:"*${username}*" OR creator:"*${username}*" OR "${username}")`;
						}
					}
				} catch (e) {}
			}

			if (!query) {
				query = `"${data.collectionIdentifier}" OR "${cleanHandle}"`;
			}
		} else if (isTopLevel) {
			query = `mediatype:(${data.collectionIdentifier})`;
		} else {
			if (data.allParams.query) {
				const qVal = data.allParams.query;
				query = `("${qVal}" OR ${qVal})`;
			} else if (data.allParams.q) {
				const qVal = data.allParams.q;
				query = `("${qVal}" OR ${qVal})`;
			} else if (data.collectionIdentifier) {
				query = `collection:(${data.collectionIdentifier})`;
			}
		}

		if (!query) {
			sendMessageSafe({ action: 'error', message: 'No search query found.' });
			data.scanDone = true;
			return;
		}

		// Proceed to search loop
		let startPage = 1;
		if (data.allParams.page) startPage = parseInt(data.allParams.page, 10) || 1;

		// APPEND FILTERS: universal buildFacetQuery groups facets by field and handles multi-select OR logic
		const filters = data.allParams['and[]'] || data.allParams['and'];
		const facetQuery = buildFacetQuery(filters, data.collectionIdentifier);

		// Final query assembly
		let finalQuery = query;
		if (facetQuery) {
			finalQuery = finalQuery ? `(${finalQuery}) AND (${facetQuery})` : facetQuery;
		}

		if (!finalQuery) {
			sendMessageSafe({ action: 'error', message: 'No search parameters found.' });
			data.scanDone = true;
			return;
		}

		// Pass sort if provided
		let sortStr = data.allParams['sort[]'] || data.allParams['sort'];

		performAdvancedSearch(tabId, finalQuery, startPage, sortStr);
		return;
	}

	// Normal Collection/Item flow
	const metaUrl = `https://archive.org/metadata/${data.collectionIdentifier}`;
	let meta;
	try {
		const resp = await fetch(metaUrl);
		if (!resp.ok) throw new Error('Could not fetch metadata');
		meta = await resp.json();
	} catch (e) {
		sendMessageSafe({ action: 'error', message: 'Could not fetch collection/item information.' });
		data.scanDone = true;
		return;
	}

	const mediatype = meta.metadata && meta.metadata.mediatype ? meta.metadata.mediatype : null;

	if (mediatype === 'collection') {
		// If collection, fetch all items using advancedsearch
		let query = `collection:(${data.collectionIdentifier})`;
		let sortStr = data.allParams['sort[]'] || data.allParams['sort'];
		performAdvancedSearch(tabId, query, 1, sortStr);

	} else {
		// If single item, extract all logical file groups from metadata
		const results = extractResultsFromMetadata(meta, tabId, `https://archive.org/details/${data.collectionIdentifier}`, data.collectionIdentifier);

		if (results.length === 0) {
			sendMessageSafe({ action: 'scanComplete', message: 'No downloadable files found.', tabId: tabId, totalResults: 0 });
			data.scanDone = true;
			return;
		}

		data.results = results;
		data.max = results.length;
		data.loop = results.length;
		data.scanDone = true;

		updateExtensionPercentages(tabId);

		// Send progress updates to popup
		results.forEach((res, idx) => {
			sendMessageSafe({
				action: 'updateProgress',
				message: `Scanning archive: ${idx + 1} / ${results.length}...`,
				tabId: tabId,
				newResult: res,
				resultIndex: idx,
				current: idx + 1,
				max: results.length,
				totalDiscovered: results.length
			});
		});

		sendMessageSafe({
			action: 'scanComplete',
			message: `Scan completed! ${results.length} items found.`,
			tabId: tabId,
			totalResults: results.length
		});
	}
};

const performAdvancedSearch = async (tabId, query, startPage = 1, sortStr = null) => {
	const data = tabs[tabId];
	if (!data || data.isFetchingIdentifiers) return;

	const signal = scanAbortControllers[tabId] ? scanAbortControllers[tabId].signal : null;
	data.isFetchingIdentifiers = true;
	let page = startPage, totalFetched = 0, totalFound = 0;
	let currentDelay = 100;
	const pageSize = 1000;

	do {
		if (data.scanDone || (signal && signal.aborted)) break;

		let apiUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&rows=${pageSize}&page=${page}&output=json`;

		if (sortStr) {
			if (Array.isArray(sortStr)) {
				sortStr.forEach(s => apiUrl += `&sort[]=${encodeURIComponent(s)}`);
			} else {
				apiUrl += `&sort[]=${encodeURIComponent(sortStr)}`;
			}
		}

		console.log('Background: API URL is', apiUrl);

		try {
			const response = await fetch(apiUrl, { signal: signal || undefined });
			if (!response.ok) {
				if (response.status === 429 || response.status === 503) {
					console.warn(`Archive API Rate Limit (${response.status}). Backing off...`);
					currentDelay *= 2;
					if (currentDelay > 10000) currentDelay = 10000;
					sendMessageSafe({
						action: 'updateProgress',
						message: `Rate limited. Waiting ${currentDelay / 1000}s before retry...`,
						tabId: tabId
					});
					await sleep(currentDelay);
					continue;
				}
				throw new Error(`Could not fetch info: ${response.status}`);
			}
			
			if (currentDelay > 100) {
				currentDelay = Math.max(100, currentDelay - 200);
			}

			const apiData = await response.json();

			if (page === startPage) {
				totalFound = apiData.response.numFound;
				data.max = totalFound;
				if (totalFound === 0) {
					sendMessageSafe({ action: 'scanComplete', message: 'No items found.', tabId: tabId, totalResults: 0 });
					data.scanDone = true;
					data.isFetchingIdentifiers = false;
					return;
				}
			}

			const identifiers = apiData.response.docs.map(doc => doc.identifier);
			if (identifiers.length === 0) break;

			data.articles = data.articles.concat(identifiers.map(id => ({
				url: `https://archive.org/details/${id}`,
				title: id
			})));

			totalFetched += identifiers.length;
			data.max = totalFound;
			saveScanState(tabId);
			sendMessageSafe({
				action: 'updateProgress',
				message: `Discovered ${totalFetched} / ${totalFound} items...`,
				tabId: tabId
			});

			page++;
			await sleep(currentDelay);

		} catch (e) {
			if (signal && signal.aborted) return;
			console.error("Search error:", e);
			sendMessageSafe({ action: 'error', message: 'Search failed.' });
			data.scanDone = true;
			data.isFetchingIdentifiers = false;
			saveScanState(tabId);
			break;
		}
	} while (totalFetched < totalFound && !data.scanDone && !(signal && signal.aborted));

	data.isFetchingIdentifiers = false;
	data.max = data.articles.length;
	saveScanState(tabId);

	if (data.articles.length > 0 && !data.scanDone && !(signal && signal.aborted)) {
		startProcessingArticles(tabId);
	}
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = 7000, externalSignal = null) => {
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeoutMs);

	if (externalSignal) {
		externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
	}

	try {
		const res = await fetch(url, { ...options, signal: controller.signal });
		clearTimeout(id);
		return res;
	} catch (err) {
		clearTimeout(id);
		throw err;
	}
};

const fetchMetadataWithRetry = async (identifier, retries = 4, signal = null) => {
	const url = `https://archive.org/metadata/${identifier}`;
	for (let i = 0; i <= retries; i++) {
		if (signal && signal.aborted) return null;
		try {
			const res = await fetchWithTimeout(url, {}, 15000, signal);
			if (!res.ok) {
				if ((res.status === 429 || res.status >= 500) && i < retries) {
					await sleep(1000 * Math.pow(2, i));
					continue;
				}
				throw new Error(`HTTP ${res.status}`);
			}
			return await res.json();
		} catch (err) {
			if (signal && signal.aborted) return null;
			if (i === retries) {
				console.warn(`Metadata fetch failed after ${retries} retries for ${identifier}:`, err.message);
				return null;
			}
			await sleep(1000 * Math.pow(2, i));
		}
	}
	return null;
};

const startProcessingArticles = async function (tabId) {
	const data = tabs[tabId];
	if (!data || data.isProcessingArticles) return;

	const signal = scanAbortControllers[tabId] ? scanAbortControllers[tabId].signal : null;
	data.isProcessingArticles = true;
	ensureKeepAlive();
	saveScanState(tabId);

	const CONCURRENCY = 4;
	let articleIndex = data.loop || 0;

	const worker = async () => {
		while (articleIndex < data.articles.length && !data.scanDone && !(signal && signal.aborted)) {
			const currentIndex = articleIndex++;
			const article = data.articles[currentIndex];
			if (!article || (signal && signal.aborted)) break;

			const identifier = article.url.split('/details/')[1];

			try {
				const metadata = await fetchMetadataWithRetry(identifier, 4, signal);
				if (metadata && metadata.files && metadata.files.length > 0 && !data.scanDone && !(signal && signal.aborted)) {
					const results = extractResultsFromMetadata(metadata, tabId, article.url, article.title);
					results.forEach(result => {
						const resultIndex = data.results.length;
						data.results.push(result);
						sendMessageSafe({
							action: 'updateProgress',
							tabId: tabId,
							newResult: result,
							resultIndex: resultIndex,
							current: data.loop + 1,
							max: data.max,
							totalDiscovered: data.results.length
						});
					});
					updateExtensionPercentages(tabId);
				} else if (!data.scanDone && !(signal && signal.aborted)) {
					// Fallback: create direct download entry so item is NEVER lost
					console.warn(`Using fallback direct entry for ${identifier}`);
					const fallbackResult = {
						title: article.title || identifier,
						href: article.url,
						downloadUrls: [{
							url: `https://archive.org/download/${identifier}/${identifier}.mp4`,
							name: `${identifier}.mp4`,
							format: 'Video',
							size: 'Unknown'
						}, {
							url: `https://archive.org/download/${identifier}/${identifier}_archive.torrent`,
							name: `${identifier}_archive.torrent`,
							format: 'Archive BitTorrent',
							size: 'Unknown'
						}],
						extIndexes: []
					};
					const resultIndex = data.results.length;
					data.results.push(fallbackResult);
					sendMessageSafe({
						action: 'updateProgress',
						tabId: tabId,
						newResult: fallbackResult,
						resultIndex: resultIndex,
						current: data.loop + 1,
						max: data.max,
						totalDiscovered: data.results.length
					});
					updateExtensionPercentages(tabId);
				}
			} catch (err) {
				if (!(signal && signal.aborted)) {
					console.warn(`Could not process metadata for ${identifier}:`, err.message);
				}
			} finally {
				if (!(signal && signal.aborted)) {
					data.loop++;
					saveScanStateDebounced(tabId);
					const fileText = data.results.length > data.loop ? ` (${data.results.length} files discovered)` : '';
					sendMessageSafe({
						action: 'updateProgress',
						message: `Scanning: ${data.loop} / ${data.max} items...${fileText}`,
						tabId: tabId,
						current: data.loop,
						max: data.max,
						totalDiscovered: data.results.length
					});
				}
			}

			// Gentle stagger
			await sleep(50);
		}
	};

	const workers = Array(CONCURRENCY).fill(null).map(() => worker());
	await Promise.all(workers);

	if (signal && signal.aborted) {
		return;
	}

	data.scanDone = true;
	data.isProcessingArticles = false;

	updateExtensionPercentages(tabId);
	saveScanState(tabId);

	sendMessageSafe({
		action: 'scanComplete',
		message: `Scan completed! ${data.max || data.loop} items scanned • ${data.results.length} files found.`,
		tabId: tabId,
		totalResults: data.results.length,
		totalScanned: data.max || data.loop
	});
};

const IGNORED_FORMATS = new Set([
	'Metadata',
	'JSON',
	'Item Tile',
	'JPEG Thumb',
	'Archive Format',
	'Thumbnail',
	'Spectrogram',
	'Log'
]);

function isSystemFile(filename) {
	if (!filename) return false;
	const lower = filename.toLowerCase();
	return lower.endsWith('_meta.xml') ||
		lower.endsWith('_files.xml') ||
		lower.endsWith('_meta.sqlite') ||
		lower.endsWith('_reviews.xml') ||
		lower.endsWith('_scandata.xml') ||
		lower.endsWith('__ia_thumb.jpg') ||
		lower.endsWith('_thumb.jpg') ||
		lower.endsWith('_itemimage.jpg') ||
		lower.endsWith('_itemimage.png') ||
		lower.endsWith('_spectrogram.png') ||
		lower.endsWith('.description') ||
		lower.endsWith('.info.json') ||
		lower.endsWith('_chocr.html.gz') ||
		lower.endsWith('_hocr.html') ||
		lower.endsWith('_hocr_pageindex.json.gz') ||
		lower.endsWith('_hocr_searchtext.txt.gz') ||
		lower.endsWith('_page_numbers.json') ||
		lower.endsWith('.rules') ||
		lower.endsWith('.md5') ||
		lower.endsWith('.sum') ||
		lower.includes('.thumbs/');
}

const extractResultsFromMetadata = function (metadata, tabId, defaultUrl, defaultTitle) {
	const results = [];
	if (!metadata || !metadata.files || metadata.files.length === 0) {
		return results;
	}

	const identifier = (metadata.metadata && metadata.metadata.identifier) || '';
	const itemTitle = (metadata.metadata && metadata.metadata.title) || defaultTitle || identifier;
	const files = metadata.files;
	const fileMap = new Map();
	files.forEach(f => fileMap.set(f.name, f));

	function getRootOriginal(file) {
		let curr = file;
		let visited = new Set([curr.name]);
		while (curr && curr.original && fileMap.has(curr.original)) {
			if (visited.has(curr.original)) break;
			visited.add(curr.original);
			curr = fileMap.get(curr.original);
		}
		return curr ? curr.name : file.name;
	}

	// Filter and categorize files
	const primaryMediaRoots = new Map();
	const artworkFiles = [];
	const torrentFiles = [];
	const otherFiles = [];

	const MEDIA_REGEX = /\.(mp4|mkv|webm|avi|mov|mpg|mpeg|m4v|ogv|vob|wmv|flv|3gp|ts|m2ts|flac|mp3|wav|ogg|m4a|aac|wma|opus|aiff|alac|mid|midi|ape|ac3|dts|shn|pdf|epub|mobi|djvu|cbr|cbz|azw3|fb2|txt|chm|docx|doc|rtf|odt|iso|bin|cue|img|dmg|rom|nes|sfc|smc|gba|gbc|gb|nds|n64|z64|exe|apk|zip|rar|7z|tar|gz|bz2|xz)$/i;

	files.forEach(file => {
		const format = file.format || 'Unknown';
		if (IGNORED_FORMATS.has(format)) return;
		if (isSystemFile(file.name)) return;

		if (format === 'Archive BitTorrent' || file.name.toLowerCase().endsWith('_archive.torrent')) {
			torrentFiles.push(file);
			return;
		}

		if (format === 'Item Tile' || file.name.toLowerCase().endsWith('__ia_thumb.jpg')) {
			return;
		}

		if (file.name.match(/\.(jpg|jpeg|png|webp|gif|bmp|tiff|tif|svg)$/i) && !file.original) {
			artworkFiles.push(file);
			return;
		}

		const rootName = getRootOriginal(file);
		const base = rootName.replace(/\.[^/.]+$/, '');

		if (MEDIA_REGEX.test(rootName) || MEDIA_REGEX.test(file.name)) {
			if (!primaryMediaRoots.has(base)) {
				primaryMediaRoots.set(base, []);
			}
			primaryMediaRoots.get(base).push(file);
		} else {
			otherFiles.push(file);
		}
	});

	// If no primary media roots found (e.g. pure image collection or raw data), fallback artwork into roots
	if (primaryMediaRoots.size === 0) {
		artworkFiles.forEach(file => {
			const rootName = getRootOriginal(file);
			const base = rootName.replace(/\.[^/.]+$/, '');
			if (!primaryMediaRoots.has(base)) primaryMediaRoots.set(base, []);
			primaryMediaRoots.get(base).push(file);
		});
		artworkFiles.length = 0;
	}

	const groups = [];

	if (primaryMediaRoots.size <= 1) {
		// Single media item (1 song, 1 book, 1 video, 1 disk image, etc.):
		// ALL files (audio derivatives, artwork covers, documents, torrents) belong to this 1 item
		const allItemFiles = [];
		for (const fileList of primaryMediaRoots.values()) {
			allItemFiles.push(...fileList);
		}
		allItemFiles.push(...artworkFiles);
		allItemFiles.push(...otherFiles);
		allItemFiles.push(...torrentFiles);

		if (allItemFiles.length > 0) {
			groups.push({
				title: itemTitle,
				files: allItemFiles
			});
		}
	} else {
		// Multi-track / Multi-video / Multi-disc item:
		// Create individual track rows
		for (const [base, trackFiles] of primaryMediaRoots.entries()) {
			const trackRoot = trackFiles[0];
			let trackTitle = trackRoot.title || base.split('/').pop().replace(/_/g, ' ');
			groups.push({
				title: `${itemTitle} - ${trackTitle}`,
				files: [...trackFiles, ...artworkFiles, ...otherFiles, ...torrentFiles]
			});
		}
	}

	for (const group of groups) {
		const downloadUrls = [];
		const extIndexes = [];
		const addedUrls = new Set();

		group.files.forEach(file => {
			const encodedPath = file.name.split('/').map(encodeURIComponent).join('/');
			const downloadUrl = `https://archive.org/download/${identifier}/${encodedPath}`;
			if (addedUrls.has(downloadUrl)) return;
			addedUrls.add(downloadUrl);

			const extension = updateExtensionsFromFile(file, tabId);
			const extIdx = tabs[tabId].extensions.indexOf(extension);

			downloadUrls.push({
				url: downloadUrl,
				extIdx: extIdx,
				size: file.size ? `${(file.size / (1024 * 1024)).toFixed(2)} MB` : 'Unknown',
				name: file.name,
				format: file.format
			});

			if (extIdx !== -1 && !extIndexes.includes(extIdx)) {
				extIndexes.push(extIdx);
			}
		});

		if (downloadUrls.length > 0) {
			results.push({
				url: defaultUrl || `https://archive.org/details/${identifier}`,
				title: group.title,
				downloadUrls: downloadUrls,
				extIndexes: extIndexes,
				rendered: false
			});
		}
	}

	return results;
};

const extEndings = [
	"_daisy.zip",
	"_text.pdf",
	"_abbyy.gz",
	"_archive.torrent",
	"_jp2.zip"
]

const updateExtensionsFromFile = function (file, tabId) {
	const extensionType = '.' + file.name.split('.').slice(-1);
	let ending = "" + extensionType;

	extEndings.find((e, i) => {
		if (file.name.endsWith(e)) {
			ending = e;
		}
	});

	let data = tabs[tabId];
	if (!data || !data.extensions) {
		data = tabs[tabId] = _copyObject(dataTemplate);
	}

	let extension = data.extensions.find(f => f.ending === ending);
	if (extension) {
		extension.count++;
	} else {
		extension = {
			ext: extensionType,
			ending: ending,
			name: file.format || 'Unknown',
			count: 1
		};

		data.extensions.push(extension);
	}

	// Update extension percentages
	updateExtensionPercentages(tabId);

	return extension;
}

// Calculate extension percentages - each extension should be 100% within its own scope
function updateExtensionPercentages(tabId) {
	var data = tabs[tabId];
	if (!data || !data.extensions || !data.results) return;

	// Calculate separately for each extension
	data.extensions.forEach(ext => {
		// Count how many items have this extension
		let itemsWithThisExt = 0;
		data.results.forEach(result => {
			if (result.downloadUrls && result.downloadUrls.some(url => url.extIdx === data.extensions.indexOf(ext))) {
				itemsWithThisExt++;
			}
		});

		// Calculate percentage based on total item count
		if (data.results.length > 0) {
			ext.percentage = Math.round((itemsWithThisExt / data.results.length) * 100);
		} else {
			ext.percentage = 0;
		}
	});
}

function sendMessageSafe(message) {
	chrome.runtime.sendMessage(message, (response) => {
		if (chrome.runtime.lastError) {
			console.debug('Popup not open, message not sent:', message.action);
		}
	});
}


function getExtensions(tabId) {
	return tabs[tabId] ? tabs[tabId].extensions : [];
}

function getResults(tabId) {
	return tabs[tabId] ? tabs[tabId].results : [];
}

function getDownloadProgress(tabId) {
	return tabs[tabId] ? tabs[tabId].downloadProgressData : [];
}

function getDownloadStatus(tabId) {
	return tabs[tabId] ? tabs[tabId].downloadStatus : DOWNLOAD_STATUS.unknown;
}

function refreshStatus(tabId) {
	if (tabs[tabId]) {
		tabs[tabId].downloadStatus = DOWNLOAD_STATUS.refresh;
	}
}

function resetStatus(tabId) {
	if (tabs[tabId]) {
		tabs[tabId].downloadStatus = DOWNLOAD_STATUS.unknown;
	}
}

function startDownload(tabId, initialData) {
	if (!tabs[tabId]) {
		console.error('Tab data not found for download:', tabId);
		return;
	}

	console.log('Starting download for tabId:', tabId, 'with data:', initialData);

	// Transform initialData (indices) to full download objects if needed
	// The UI should send: { resultIndex: 0, extIndex: 0 }
	// We map this to: { url: ..., state: 'ready', ... }

	const tab = tabs[tabId];
	const downloadList = [];

	initialData.forEach(item => {
		if (item.url) {
			downloadList.push({
				id: 0,
				resultIndex: item.resultIndex,
				extIndex: item.extIndex,
				url: item.url,
				state: STATE.ready,
				totalBytes: 0,
				bytesReceived: 0,
				filename: decodeURIComponent(item.url.split('/').pop())
			});
		} else if (tab.results[item.resultIndex] &&
			tab.results[item.resultIndex].downloadUrls) {

			let downloadInfo = null;
			if (item.extensionEnding) {
				downloadInfo = tab.results[item.resultIndex].downloadUrls.find(u =>
					u.url.toLowerCase().endsWith(item.extensionEnding.toLowerCase())
				);
			}
			if (!downloadInfo) {
				downloadInfo = tab.results[item.resultIndex].downloadUrls.find(u => u.extIdx === item.extIndex);
			}

			if (downloadInfo) {
				downloadList.push({
					id: 0,
					resultIndex: item.resultIndex,
					extIndex: item.extIndex,
					url: downloadInfo.url,
					state: STATE.ready,
					totalBytes: 0,
					bytesReceived: 0,
					filename: decodeURIComponent(downloadInfo.url.split('/').pop())
				});
			} else {
				console.error('Download URL not found for ending:', item.extensionEnding, 'or index:', item.extIndex);
			}
		} else {
			console.error('Invalid indices for download:', item);
		}
	});

	tab.downloadProgressData = downloadList;
	tab.downloadStatus = DOWNLOAD_STATUS.started;

	// Start download process
	_checkDownloads(tabId);

	// Set interval for checking downloads
	// Clear existing interval if any
	if (tab.interval) clearInterval(tab.interval);

	tab.interval = setInterval(function () {
		_checkDownloads(tabId);
	}, 1000);
}

function _checkDownloads(tabId) {
	let data = tabs[tabId];
	if (!data || !data.downloadProgressData || data.isPaused) {
		return;
	}

	// console.log('Checking downloads for tabId:', tabId);

	const len = data.downloadProgressData.length;
	let workingCnt = 0;

	// First pass: Count active downloads
	for (let i = 0; i < len; i++) {
		let item = data.downloadProgressData[i];
		// Count 'starting' as active too to prevent over-scheduling
		if (item.state == STATE.in_progress || item.state == 'starting') {
			workingCnt++;
		}
	}

	// Second pass: Start new downloads or check progress
	for (let i = 0; i < len; i++) {
		let item = data.downloadProgressData[i];

		if (item.state == STATE.ready) {
			if (workingCnt < MAX_PARALLEL_DOWNLOADS) {
				// Start this download
				// Mark as 'starting' IMMEDIATELY to prevent double-scheduling in next tick
				item.state = 'starting';
				workingCnt++;

				const sanitizeSegment = (str) => {
					if (!str) return 'archive_item';
					return str.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim().slice(0, 80);
				};

				const folderName = sanitizeSegment(data.collectionIdentifier || 'downloads');
				const rawName = item.filename || item.url.split('/').pop() || 'file';
				const safeFileName = sanitizeSegment(decodeURIComponent(rawName));
				const downloadPath = `ArchiveDownloader/${folderName}/${safeFileName}`;

				console.log('Starting download for:', item.url, 'to:', downloadPath);
				chrome.downloads.download({
					url: item.url,
					filename: downloadPath
				}, function callback(downloadId) {
					if (chrome.runtime.lastError) {
						console.error('Download error:', chrome.runtime.lastError);
						item.state = STATE.interrupted;
						item.errorMsg = chrome.runtime.lastError.message;
					} else {
						console.log('Download started with ID:', downloadId);
						item.id = downloadId;
						item.state = STATE.in_progress;
					}
				});
			}
		} else if (item.state == STATE.in_progress && item.id) {
			// Check progress for in-progress items
			chrome.downloads.search({ id: item.id }, function callback(items) {
				if (chrome.runtime.lastError) {
					// Handle search error (rare)
					return;
				}

				if (items && items.length > 0) {
					item.totalBytes = items[0].totalBytes;
					item.bytesReceived = items[0].bytesReceived;

					if (items[0].state === 'complete') {
						item.state = STATE.completed;
						refreshStatus(data.tabId); // Notify UI
					} else if (items[0].state === 'interrupted') {
						item.state = STATE.interrupted;
						item.errorMsg = items[0].error; // "USER_CANCELED", etc.
						refreshStatus(data.tabId);
					}
				} else {
					// Download ID not found? Maybe removed by user.
					// item.state = STATE.interrupted;
					// item.errorMsg = "Download not found";
				}
			});
		}
	}

	// Check if all done
	const isAllDone = data.downloadProgressData.every(item =>
		item.state === STATE.completed ||
		item.state === STATE.canceled ||
		item.state === STATE.interrupted
	);

	if (isAllDone && len > 0) {
		clearInterval(data.interval);
		data.downloadStatus = DOWNLOAD_STATUS.completed;
		refreshStatus(tabId);
		console.log('All downloads completed for tabId:', tabId);
	}
}
