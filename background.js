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
}

function _copyObject(obj) {
	return JSON.parse(JSON.stringify(obj));
}

function clearData(tabId) {
	tabs[tabId] = _copyObject(dataTemplate);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Manifest V3 için declarativeContent yerine action.onClicked kullanıyoruz
chrome.action.onClicked.addListener(function (tab) {
	if (tab.url && tab.url.includes('archive.org')) {
		// Popup açılacak, ek işlem gerekmez
	}
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
	let data;
	switch (message.action) {
		case 'startFetching':
			// Modern projenin mantığıyla çalış
			tabs[message.tabId] = _copyObject(dataTemplate);
			data = tabs[message.tabId];
			data.tabId = message.tabId;
			data.pageHref = message.url; // Critical: Set this to prevent onUpdated from deleting data
			data.collectionIdentifier = message.collectionIdentifier;
			data.isSingleItem = message.isSingleItem || false;
			data.isSearch = message.isSearch || false;
			data.isUserProfile = message.isUserProfile || false;
			data.allParams = message.allParams || {};
			data.scanDone = false;

			// Clear old results
			data.results = [];
			data.extensions = [];
			data.loop = 0;
			data.max = 0;

			// Start API data fetching
			if (!data.isFetchingIdentifiers) {
				fetchAllItemIdentifiers(message.tabId);
			}
			break;
		// cases SCAN_PAGE and NEXT_PAGE removed as legacy code
		case 'stopFetching':
			if (tabs[message.tabId]) {
				tabs[message.tabId].scanDone = true;
				// Clear any pending articles to stop processing
				tabs[message.tabId].articles = [];
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
			}
			break;
		case 'getDownloadProgress':
			if (tabs[message.tabId]) {
				sendResponse({ progress: getDownloadProgress(message.tabId) });
			} else {
				sendResponse({ progress: [] });
			}
			return true;
			break;
		case 'getDownloadStatus':
			if (tabs[message.tabId]) {
				sendResponse({ status: getDownloadStatus(message.tabId) });
			} else {
				sendResponse({ status: DOWNLOAD_STATUS.unknown });
			}
			return true;
			break;
		case 'resetStatus':
			if (tabs[message.tabId]) {
				resetStatus(message.tabId);
				// Also clear the tab data for a fresh start
				clearData(message.tabId);
			}
			break;
		case 'getExtensions':
			if (tabs[message.tabId]) {
				sendResponse({ extensions: getExtensions(message.tabId) });
			} else {
				sendResponse({ extensions: [] });
			}
			return true;
			break;
		case 'getResults':
			if (tabs[message.tabId]) {
				const data = tabs[message.tabId];
				sendResponse({
					results: data.results || [],
					scanDone: data.scanDone || false,
					isFetchingIdentifiers: data.isFetchingIdentifiers || false,
					current: data.loop || 0,
					max: data.max || 0,
					downloadStatus: data.downloadStatus || 0
				});
			} else {
				sendResponse({ results: [], scanDone: true });
			}
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
					// Ensure status is back to started so the loop continues/restarts checks
					data.downloadStatus = DOWNLOAD_STATUS.started;

					// Clear existing interval if any (just to be safe)
					if (data.interval) clearInterval(data.interval);

					// Restart check loop
					data.interval = setInterval(function () {
						_checkDownloads(message.tabId);
					}, 1000);

					sendResponse({ count: retriedCount });
				} else {
					sendResponse({ count: 0 });
				}
			}
			return true;
			break;
		case 'getProgress':
			if (tabs[message.tabId]) {
				const data = tabs[message.tabId];
				sendResponse({
					current: data.loop || 0,
					max: data.max || 0,
					scanDone: data.scanDone || false,
					isFetchingIdentifiers: data.isFetchingIdentifiers || false
				});
			} else {
				sendResponse({ current: 0, max: 0, scanDone: true });
			}
			return true;
			break;
	}
});

chrome.tabs.onUpdated.addListener(function (tabId, change, tab) {
	if (change.status === 'loading') {
		// Yalnızca Archive.org dışına çıkılırsa veya ID değişirse veriyi sil
		if (tabs[tabId] && change.url) {
			try {
				const oldUrl = tabs[tabId].pageHref;
				const newUrl = change.url;

				// ID'leri karşılaştır (details/ID veya download/ID)
				const getID = (u) => {
					const m = u.match(/(details|download)\/([^/?#]+)/);
					return m ? m[2] : null;
				};

				const oldID = getID(oldUrl);
				const newID = getID(newUrl);

				if (!newUrl.includes('archive.org') || (oldID && newID && oldID !== newID)) {
					console.log('Clearing data for tabId:', tabId, 'due to navigation to:', newUrl);
					delete tabs[tabId];
				}
			} catch (e) {
				// URL işlemede hata (dosya yolları vb.)
			}
		}
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	if (tabs[tabId]) {
		console.log('Clearing data for tabId:', tabId, 'due to tab closure');
		delete tabs[tabId];
	}
});

// Manifest V3'te getViews yerine farklı bir yaklaşım kullanıyoruz
function getPopup() {
	// Manifest V3'te popup view'larına doğrudan erişim yok
	// Bunun yerine message passing kullanıyoruz
	return null;
}

// New API-based functions
const fetchAllItemIdentifiers = async (tabId) => {
	const data = tabs[tabId];
	if (!data) {
		console.error('Data not found for tabId:', tabId);
		return;
	}

	// First, check if this is a Search Page or User Profile scan
	if (data.isSearch || data.isUserProfile) {
		// It's a search page or user profile, skip metadata and go straight to search
		let query = '';
		
		if (data.isUserProfile) {
			// Step 1: Probe for an item to find the actual uploader string (handle or email)
			// We search for the literal handle string as a keyword
			const handleKeyword = data.collectionIdentifier; // e.g. "@tarihvemedeniyet_org"
			const probeUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(handleKeyword)}&fl[]=identifier&rows=1&output=json`;
			
			try {
				const probeResp = await fetch(probeUrl);
				const probeData = await probeResp.json();
				if (probeData.response && probeData.response.docs && probeData.response.docs.length > 0) {
					const firstItemId = probeData.response.docs[0].identifier;
					// Fetch metadata for this item to extract the REAL uploader value
					const metaResp = await fetch(`https://archive.org/metadata/${firstItemId}`);
					const metaData = await metaResp.json();
					if (metaData.metadata && metaData.metadata.uploader) {
						// Success! We found the uploader identifier (could be email or handle)
						query = `uploader:("${metaData.metadata.uploader}")`;
						console.log(`Profile probe found uploader: ${metaData.metadata.uploader}`);
					}
				}
			} catch (e) {
				console.warn("Profile probe search failed:", e);
			}

			// Fallback if probe failed or handle wasn't found in uploader field
			if (!query) {
				query = `uploader:("${data.collectionIdentifier}") OR creator:("${data.collectionIdentifier}") OR "${data.collectionIdentifier}"`;
			}
		} else {
			if (data.allParams.query) query = data.allParams.query; // URL param 'query'
			else if (data.allParams.q) query = data.allParams.q;     // URL param 'q' (advanced)
		}

		if (!query) {
			sendMessageSafe({ action: 'error', message: 'No search query found.' });
			data.scanDone = true;
			return;
		}

		// Proceed to search loop
		let startPage = 1;
		if (data.allParams.page) startPage = parseInt(data.allParams.page, 10) || 1;

		// APPEND FILTERS: archive.org uses 'and[]' for facets
		const filters = data.allParams['and[]'] || data.allParams['and'];
		const filterParts = [];

		if (filters) {
			const filterList = Array.isArray(filters) ? filters : [filters];
			const groups = {};

			filterList.forEach(f => {
				if (!f) return;
				const match = f.match(/^([^:]+):"(.+)"$/) || f.match(/^([^:]+):(.+)$/);
				if (match) {
					const field = match[1];
					const value = match[2];
					if (!groups[field]) groups[field] = [];
					groups[field].push(`"${value}"`);
				} else {
					filterParts.push(f);
				}
			});

			for (const field in groups) {
				const values = groups[field];
				if (values.length > 1) {
					filterParts.push(`(${values.map(v => `${field}:${v}`).join(' OR ')})`);
				} else {
					filterParts.push(`${field}:${values[0]}`);
				}
			}
		}

		// Final query assembly
		let finalQuery = query;
		if (filterParts.length > 0) {
			const filterString = filterParts.join(' AND ');
			finalQuery = finalQuery ? `(${finalQuery}) AND (${filterString})` : filterString;
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
		let query = '';
		if (data.allParams && data.allParams.q) {
			query = data.allParams.q;
		} else {
			let queryParts = [`collection:(${data.collectionIdentifier})`];
			for (const key in data.allParams) {
				if (key === 'q' || key === 'page' || key === 'sort') continue;
				let value = data.allParams[key];
				if (!Array.isArray(value)) value = [value];
				value.forEach(val => {
					if (key.endsWith('[]')) {
						queryParts.push(val);
					} else {
						queryParts.push(`${key}:"${val}"`);
					}
				});
			}
			query = queryParts.join(' AND ');
		}

		let sortStr = data.allParams['sort[]'] || data.allParams['sort'];
		performAdvancedSearch(tabId, query, 1, sortStr);

	} else {
		// If single item, just process it
		data.articles = [{
			url: `https://archive.org/details/${data.collectionIdentifier}`,
			title: data.collectionIdentifier
		}];
		data.max = 1;
		sendMessageSafe({
			action: 'updateProgress',
			message: `Processing item: ${data.collectionIdentifier}...`,
			tabId: tabId
		});

		// Start processing
		if (data.articles.length > 0) {
			processOneArticle(tabId);
		}
	}
};

const performAdvancedSearch = async (tabId, query, startPage = 1, sortStr = null) => {
	const data = tabs[tabId];
	if (!data || data.isFetchingIdentifiers) return;

	data.isFetchingIdentifiers = true;
	let page = startPage, totalFetched = 0, totalFound = 0;
	let currentDelay = 200; // Dynamic delay for rate limiting
	do {
		if (data.scanDone) break;

		// Ensure we request JSON output
		let apiUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&rows=500&page=${page}&output=json`;

		// Add sorting if provided
		if (sortStr) {
			if (Array.isArray(sortStr)) {
				sortStr.forEach(s => apiUrl += `&sort[]=${encodeURIComponent(s)}`);
			} else {
				apiUrl += `&sort[]=${encodeURIComponent(sortStr)}`;
			}
		}

		console.log('Background: API URL is', apiUrl);

		try {
			const response = await fetch(apiUrl);
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
					continue; // Retry the same page
				}
				throw new Error(`Could not fetch info: ${response.status}`);
			}
			
			// Success - gradually reduce delay back to normal
			if (currentDelay > 200) {
				currentDelay = Math.max(200, currentDelay - 500);
			}

			const apiData = await response.json();

			if (page === startPage) {
				totalFound = apiData.response.numFound;
				data.max = totalFound;
				if (totalFound === 0) {
					sendMessageSafe({ action: 'scanComplete', message: 'No items found.', tabId: tabId, totalResults: 0 });
					data.scanDone = true;
					return;
				}
			}

			const identifiers = apiData.response.docs.map(doc => doc.identifier);
			data.articles = data.articles.concat(identifiers.map(id => ({
				url: `https://archive.org/details/${id}`,
				title: id
			})));

			totalFetched += identifiers.length;
			sendMessageSafe({
				action: 'updateProgress',
				message: `Found ${totalFound} total items. ${totalFetched} added to list...`,
				tabId: tabId
			});

			page++;
			await sleep(currentDelay);

			// Start processing immediately if not already doing so
			if (data.articles.length > 0 && data.activeProcesCnt === 0) {
				processOneArticle(tabId);
			}

		} catch (e) {
			console.error("Search error:", e);
			sendMessageSafe({ action: 'error', message: 'Search failed.' });
			data.scanDone = true;
			break;
		}
	} while (totalFetched < totalFound && page < startPage + 1 && !data.scanDone);
};

const processOneArticle = function (tabId) {
	let data = tabs[tabId];
	if (!data || !data.articles) {
		console.error('Data or articles not found for tabId:', tabId);
		return;
	}

	// Stop scan check - early exit if scan is stopped
	if (data.scanDone) {
		sendMessageSafe({
			action: 'scanComplete',
			message: `Scan stopped by user. Total ${data.loop} items processed.`,
			tabId: tabId,
			totalResults: data.loop
		});
		return;
	}

	const article = data.articles.shift();
	if (!article) {
		// Sadece kuyruk gerçekten boşsa ve başka aktif işlem yoksa bitir
		if (data.activeProcesCnt === 0) {
			data.scanDone = true;
			sendMessageSafe({
				action: 'scanComplete',
				message: `Scan completed. Total ${data.loop} items processed.`,
				tabId: tabId,
				totalResults: data.loop
			});
		}
		return;
	}

	data.activeProcesCnt++;

	// Fetch metadata via API
	const identifier = article.url.split('/details/')[1];
	const metadataUrl = `https://archive.org/metadata/${identifier}`;

	fetch(metadataUrl)
		.then(res => res.json())
		.then(metadata => {
			if (!data || data.scanDone) {
				console.log('Scan stopped or data not found during metadata processing for tabId:', tabId);
				return;
			}

			data.loop++;
			data.activeProcesCnt--;

			if (!metadata || !metadata.files) {
				console.warn(`Metadata not found: ${identifier}`);
				// Check scan status before continuing
				if (!data.scanDone) {
					processOneArticle(tabId);
				}
				return;
			}

			let downloadData = getDownloadUrlsFromMetadata(metadata, tabId);
			let result = {
				url: article.url,
				title: article.title,
				downloadUrls: downloadData.urls,
				extIndexes: downloadData.indexes,
				rendered: false
			};

			if (!data.results) {
				data.results = [];
			}
			data.results.push(result);

			// Update extension percentages
			updateExtensionPercentages(tabId);

			// Send update to popup - with detailed info
			sendMessageSafe({
				action: 'updateProgress',
				message: `Scanning item: ${data.loop} / ${data.max}...`,
				tabId: tabId,
				newResult: result,
				current: data.loop,
				max: data.max
			});

			// Check if we should continue processing
			if (data.scanDone || !data.articles || data.articles.length === 0 || data.activeProcesCnt >= MAX_ACTIVE_THREADS) {
				if (data.scanDone) {
					console.log('Scan stopped, not processing more articles');
				}
				return;
			}
			processOneArticle(tabId);
		})
		.catch(function (err) {
			console.error(`Metadata error (${identifier}):`, err);
			if (data) {
				data.activeProcesCnt--;
				// Only continue if scan is not stopped
				if (!data.scanDone) {
					processOneArticle(tabId);
				}
			}
		});

	// Only start new thread if scan is not stopped and we haven't reached max threads
	if (data.activeProcesCnt >= MAX_ACTIVE_THREADS || data.scanDone) {
		return;
	}
	processOneArticle(tabId);
}

const getDownloadUrlsFromMetadata = function (metadata, tabId) {
	const downloadUrls = [];
	const extIndexes = [];

	if (!metadata.files) {
		return { urls: downloadUrls, indexes: extIndexes };
	}

	metadata.files.forEach(file => {
		const format = file.format || 'Unknown';
		if (format === 'Metadata' || format === 'JSON') return;

		const extension = updateExtensionsFromFile(file, tabId);
		const extIdx = tabs[tabId].extensions.indexOf(extension);

		downloadUrls.push({
			url: `https://archive.org/download/${metadata.metadata.identifier}/${encodeURIComponent(file.name)}`,
			extIdx: extIdx,
			size: file.size ? `${(file.size / (1024 * 1024)).toFixed(2)} MB` : 'Unknown'
		});
		extIndexes.push(extIdx);
	});

	return { urls: downloadUrls, indexes: extIndexes };
}

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
		// Verify indices
		if (tab.results[item.resultIndex] &&
			tab.results[item.resultIndex].downloadUrls) {

			// FIX: Find the download URL that matches the requested extension ending
			// This is more robust than relying on indices which might be out of sync
			let downloadInfo = null;

			if (item.extensionEnding) {
				// Strict check using the string (e.g. ".pdf")
				downloadInfo = tab.results[item.resultIndex].downloadUrls.find(u =>
					u.url.toLowerCase().endsWith(item.extensionEnding.toLowerCase())
				);
			}

			// Fallback to index if string check fails or wasn't provided (backward compatibility)
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
					filename: downloadInfo.url.split('/').pop() // Info for debugging
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
	if (!data || !data.downloadProgressData) {
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

				console.log('Starting download for:', item.url);
				chrome.downloads.download({ url: item.url }, function callback(downloadId) {
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
