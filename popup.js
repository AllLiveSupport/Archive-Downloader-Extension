// Copyright (c) 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

const parser = new DOMParser();
let scan = true;
let tabId;

// Smart Format Categories with priority ranking
const FORMAT_CATEGORIES = [
	{
		id: 'books',
		name: 'Books',
		nameTr: 'Tüm Kitaplar',
		icon: '📚',
		priority: ['.pdf', '_text.pdf', '.epub', '.mobi', '.djvu', '.cbr', '.cbz', '.azw3', '.fb2', '.txt', '.chm', '.docx', '.doc', '.rtf', '.odt', '.prc']
	},
	{
		id: 'videos',
		name: 'Videos',
		nameTr: 'Tüm Videolar',
		icon: '🎬',
		priority: ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mpg', '.mpeg', '.m4v', '.ogv', '.iso', '.vob', '.wmv', '.flv', '.3gp', '.ts', '.m2ts']
	},
	{
		id: 'audios',
		name: 'Audio',
		nameTr: 'Tüm Sesler',
		icon: '🎵',
		priority: ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac', '.wma', '.opus', '.aiff', '.alac', '.mid', '.midi', '.ape', '.ac3', '.dts', '.shn']
	},
	{
		id: 'software',
		name: 'Software',
		nameTr: 'Yazılım & ISO',
		icon: '💾',
		priority: ['.iso', '.bin', '.cue', '.img', '.dmg', '.vdi', '.vmdk', '.rom', '.nes', '.sfc', '.smc', '.gba', '.gbc', '.gb', '.nds', '.n64', '.z64', '.exe', '.msi', '.apk', '.deb', '.rpm', '.appimage']
	},
	{
		id: 'archives',
		name: 'Archives',
		nameTr: 'Tüm Arşivler',
		icon: '🗄️',
		priority: ['.zip', '.rar', '.7z', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tar.xz', '.gz', '.bz2', '.xz', '.cab']
	},
	{
		id: 'images',
		name: 'Images',
		nameTr: 'Tüm Resimler',
		icon: '🖼️',
		priority: ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.jp2', '_jp2.zip', '.gif', '.bmp', '.svg', '.ico']
	},
	{
		id: 'torrents',
		name: 'Torrent',
		nameTr: 'Tüm Torrentler',
		icon: '📦',
		priority: ['_archive.torrent', '.torrent']
	}
];

// State object to track UI state
const UIParams = {
	results: [],              // Store results locally to avoid constant DOM scraping
	extensions: [],
	selectedExtIndex: -1,     // -1 means none
	selectedCategory: null,   // 'books' | 'videos' | 'audios' | 'images' | 'torrents' | null
	selectedItemIndices: new Set(), // Set of result indices
	selectedItemMap: new Map()      // Map<resultIndex, { url, extIdx, extensionEnding, size, format, name }>
};

/**
 * Priority matching function for category selection
 */
function getBestMatchForCategory(result, categoryId) {
	if (!result || !result.downloadUrls) return null;
	const cat = FORMAT_CATEGORIES.find(c => c.id === categoryId);
	if (!cat) return null;

	for (const ending of cat.priority) {
		const match = result.downloadUrls.find(u => {
			const urlLower = u.url.toLowerCase();
			const endingLower = ending.toLowerCase();
			return urlLower.endsWith(endingLower);
		});
		if (match) {
			return {
				url: match.url,
				extIdx: match.extIdx,
				extensionEnding: ending,
				size: match.size,
				format: match.format,
				name: match.name
			};
		}
	}
	return null;
}

/**
 * Get default format / download info for any item
 */
function getDefaultDownloadInfo(result) {
	if (!result || !result.downloadUrls || result.downloadUrls.length === 0) return null;
	const firstNonTorrent = result.downloadUrls.find(u => !u.name.toLowerCase().endsWith('_archive.torrent'));
	const target = firstNonTorrent || result.downloadUrls[0];
	const extEnding = '.' + target.name.split('.').slice(-1)[0];
	return {
		url: target.url,
		extIdx: target.extIdx,
		extensionEnding: extEnding,
		size: target.size,
		format: target.format,
		name: target.name
	};
}

/**
 * Get the current URL.
 */
function getCurrentTab(callback) {
	var queryInfo = {
		active: true,
		currentWindow: true
	};

	chrome.tabs.query(queryInfo, function (tabs) {
		var tab = tabs[0];
		if (!tab) return;
		var url = tab.url;

		callback({
			url: url,
			id: tab.id
		});
	});
}

function makeTextFile(text) {
	var data = new Blob([text], { type: 'text/plain' });
	return window.URL.createObjectURL(data);
};

function createDownloadLink(txt) {
	const a = document.createElement('a');
	a.href = makeTextFile(txt);
	a.download = 'archive_links.txt';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
}

/** UI Updates */

function renderProgressBar(current, max, totalDiscovered = 0) {
	const progressBar = document.getElementById('progressBar');
	const progressCount = document.getElementById('progressCount');
	const progressTotal = document.getElementById('progressTotal');

	if (!progressBar) return;

	const percentage = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
	progressBar.style.width = `${percentage}%`;

	const validCount = totalDiscovered || UIParams.results.filter(r => r != null).length;
	if (validCount > current) {
		progressCount.innerText = `${current} / ${max} items scanned (${validCount} files)`;
	} else if (max > 0) {
		progressCount.innerText = `${current} / ${max} items scanned`;
	} else {
		progressCount.innerText = `${validCount} found`;
	}

	progressTotal.innerText = `${percentage}%`;
	updateListTitle();
}

function updateListTitle() {
	const listTitle = document.getElementById('listTitle');
	if (listTitle) {
		const validCount = UIParams.results.filter(r => r != null).length;
		listTitle.innerText = validCount > 0 ? `Discovered Files (${validCount})` : `Files`;
	}
}

function renderStatus(text, type = 'normal') {
	const statusText = document.getElementById('statusText');
	if (statusText) {
		statusText.innerText = text;
		statusText.style.color = type === 'error' ? 'var(--bad)' : 'var(--text-main)';
	}
}

/**
 * Adds a result to the local state and UI
 */
function addResult(result, index) {
	UIParams.results[index] = result;
	addLink(result, index);
	updateListTitle();
}

// Called when extensions list is updated from background
function renderExtensions(extensions) {
	UIParams.extensions = extensions;
	const extList = document.getElementById('extList');
	const categoryList = document.getElementById('categoryList');
	const categoryGroup = document.getElementById('categoryGroup');
	if (!extList) return;

	extList.innerHTML = '';
	if (categoryList) categoryList.innerHTML = '';

	// Render Categories
	const validResults = UIParams.results.filter(r => r != null);
	const totalResults = validResults.length;
	let visibleCategoriesCount = 0;

	if (totalResults > 0 && categoryList && categoryGroup) {
		FORMAT_CATEGORIES.forEach(cat => {
			let matchingItems = 0;
			validResults.forEach(result => {
				if (getBestMatchForCategory(result, cat.id)) {
					matchingItems++;
				}
			});

			if (matchingItems > 0) {
				visibleCategoriesCount++;
				const percentage = Math.round((matchingItems / totalResults) * 100);
				addCategoryChip(cat, matchingItems, totalResults, percentage);
			}
		});

		categoryGroup.hidden = visibleCategoriesCount === 0;
	}

	// Render Specific Formats
	extensions.forEach((ext, index) => {
		addExtensionChip(ext, index);
	});

	// Re-apply active class if selected
	if (UIParams.selectedCategory) {
		const chip = document.getElementById(`cat_chip_${UIParams.selectedCategory}`);
		if (chip) chip.classList.add('active');
	} else if (UIParams.selectedExtIndex !== -1) {
		const chip = document.getElementById(`ext_chip_${UIParams.selectedExtIndex}`);
		if (chip) chip.classList.add('active');
	}
}

function onCategorySelect(categoryId) {
	// Deselect previous category
	if (UIParams.selectedCategory) {
		const prev = document.getElementById(`cat_chip_${UIParams.selectedCategory}`);
		if (prev) prev.classList.remove('active');
	}
	// Deselect previous extension chip
	if (UIParams.selectedExtIndex !== -1) {
		const prev = document.getElementById(`ext_chip_${UIParams.selectedExtIndex}`);
		if (prev) prev.classList.remove('active');
		UIParams.selectedExtIndex = -1;
	}

	UIParams.selectedCategory = categoryId;
	const next = document.getElementById(`cat_chip_${categoryId}`);
	if (next) next.classList.add('active');

	refreshListForCategory(categoryId);
	updateFooter();
}

function refreshListForCategory(categoryId) {
	UIParams.selectedItemIndices.clear();
	UIParams.selectedItemMap.clear();

	const allItems = document.querySelectorAll('.list-item');
	allItems.forEach(item => {
		const idx = parseInt(item.getAttribute('data-idx'));
		const result = UIParams.results[idx];
		if (!result) return;

		const bestMatch = getBestMatchForCategory(result, categoryId);
		const checkbox = item.querySelector('input[type="checkbox"]');
		const sizeBadge = item.querySelector('.size-badge');
		const formatBadge = item.querySelector('.format-badge');

		if (checkbox) checkbox.disabled = false;

		if (bestMatch) {
			item.classList.remove('opacity-50');
			item.classList.add('selected');
			if (checkbox) checkbox.checked = true;

			let badgeText = bestMatch.extensionEnding.replace(/^\./, '').replace(/^_/, '').toUpperCase();
			if (formatBadge) {
				formatBadge.innerText = badgeText;
				formatBadge.hidden = false;
			}
			if (sizeBadge) {
				sizeBadge.innerText = bestMatch.size;
				sizeBadge.hidden = false;
			}

			UIParams.selectedItemIndices.add(idx);
			UIParams.selectedItemMap.set(idx, bestMatch);
		} else {
			item.classList.add('opacity-50');
			item.classList.remove('selected');
			if (checkbox) checkbox.checked = false;
			if (formatBadge) formatBadge.hidden = true;
			if (sizeBadge) sizeBadge.hidden = true;
		}
	});
}

function onExtensionSelect(index) {
	// Deselect category if any
	if (UIParams.selectedCategory) {
		const prev = document.getElementById(`cat_chip_${UIParams.selectedCategory}`);
		if (prev) prev.classList.remove('active');
		UIParams.selectedCategory = null;
	}
	// Deselect previous extension chip
	if (UIParams.selectedExtIndex !== -1) {
		const prev = document.getElementById(`ext_chip_${UIParams.selectedExtIndex}`);
		if (prev) prev.classList.remove('active');
	}

	UIParams.selectedExtIndex = index;
	const next = document.getElementById(`ext_chip_${index}`);
	if (next) next.classList.add('active');

	refreshListForExtension(index);
	updateFooter();
}

function refreshListForExtension(extIndex) {
	UIParams.selectedItemIndices.clear();
	UIParams.selectedItemMap.clear();

	const targetExt = UIParams.extensions[extIndex];
	const ending = targetExt ? targetExt.ending : '';

	const allItems = document.querySelectorAll('.list-item');
	allItems.forEach(item => {
		const idx = parseInt(item.getAttribute('data-idx'));
		const result = UIParams.results[idx];
		if (!result) return;

		const hasExt = result.extIndexes.includes(extIndex);
		const checkbox = item.querySelector('input[type="checkbox"]');
		const sizeBadge = item.querySelector('.size-badge');
		const formatBadge = item.querySelector('.format-badge');

		if (checkbox) checkbox.disabled = false;

		if (hasExt) {
			const downloadInfo = result.downloadUrls.find(u => u.extIdx === extIndex);
			item.classList.remove('opacity-50');
			item.classList.add('selected');
			if (checkbox) checkbox.checked = true;

			let badgeText = ending.replace(/^\./, '').replace(/^_/, '').toUpperCase();
			if (formatBadge) {
				formatBadge.innerText = badgeText;
				formatBadge.hidden = false;
			}
			if (sizeBadge && downloadInfo) {
				sizeBadge.innerText = downloadInfo.size;
				sizeBadge.hidden = false;
			}

			if (downloadInfo) {
				UIParams.selectedItemIndices.add(idx);
				UIParams.selectedItemMap.set(idx, {
					url: downloadInfo.url,
					extIdx: extIndex,
					extensionEnding: ending,
					size: downloadInfo.size,
					format: downloadInfo.format,
					name: downloadInfo.name
				});
			}
		} else {
			item.classList.add('opacity-50');
			item.classList.remove('selected');
			if (checkbox) checkbox.checked = false;
			if (formatBadge) formatBadge.hidden = true;
			if (sizeBadge) sizeBadge.hidden = true;
		}
	});
}

function calculateTotalSelectedSize() {
	let totalBytes = 0;

	UIParams.selectedItemIndices.forEach(idx => {
		const info = UIParams.selectedItemMap.get(idx);
		if (info && info.size) {
			const sizeStr = String(info.size).trim();
			if (sizeStr.includes('MB')) {
				const mb = parseFloat(sizeStr);
				if (!isNaN(mb)) totalBytes += mb * 1024 * 1024;
			} else if (sizeStr.includes('GB')) {
				const gb = parseFloat(sizeStr);
				if (!isNaN(gb)) totalBytes += gb * 1024 * 1024 * 1024;
			} else if (sizeStr.includes('KB')) {
				const kb = parseFloat(sizeStr);
				if (!isNaN(kb)) totalBytes += kb * 1024;
			} else if (!isNaN(Number(sizeStr))) {
				totalBytes += Number(sizeStr);
			}
		}
	});

	if (totalBytes === 0) return '';
	if (totalBytes >= 1024 * 1024 * 1024) {
		return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	} else if (totalBytes >= 1024 * 1024) {
		return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
	} else {
		return `${(totalBytes / 1024).toFixed(0)} KB`;
	}
}

function selectAllMatchingItems() {
	const allItems = document.querySelectorAll('.list-item');
	allItems.forEach(item => {
		if (item.style.display === 'none') return;

		const idx = parseInt(item.getAttribute('data-idx'));
		const result = UIParams.results[idx];
		if (!result) return;

		let downloadInfo = null;
		if (UIParams.selectedCategory) {
			downloadInfo = getBestMatchForCategory(result, UIParams.selectedCategory);
		} else if (UIParams.selectedExtIndex !== -1) {
			const targetExt = UIParams.extensions[UIParams.selectedExtIndex];
			const ending = targetExt ? targetExt.ending : '';
			const u = result.downloadUrls.find(u => u.extIdx === UIParams.selectedExtIndex);
			if (u) {
				downloadInfo = {
					url: u.url,
					extIdx: UIParams.selectedExtIndex,
					extensionEnding: ending,
					size: u.size,
					format: u.format,
					name: u.name
				};
			}
		}

		if (!downloadInfo) {
			downloadInfo = getDefaultDownloadInfo(result);
		}

		if (downloadInfo) {
			const checkbox = item.querySelector('input[type="checkbox"]');
			const sizeBadge = item.querySelector('.size-badge');
			const formatBadge = item.querySelector('.format-badge');

			if (checkbox) {
				checkbox.disabled = false;
				checkbox.checked = true;
			}
			item.classList.remove('opacity-50');
			item.classList.add('selected');

			let badgeText = downloadInfo.extensionEnding.replace(/^\./, '').replace(/^_/, '').toUpperCase();
			if (formatBadge) {
				formatBadge.innerText = badgeText;
				formatBadge.hidden = false;
			}
			if (sizeBadge && downloadInfo.size) {
				sizeBadge.innerText = downloadInfo.size;
				sizeBadge.hidden = false;
			}

			UIParams.selectedItemIndices.add(idx);
			UIParams.selectedItemMap.set(idx, downloadInfo);
		}
	});
}

function updateFooter() {
	const count = UIParams.selectedItemIndices.size;
	const selectionInfo = document.getElementById('selectionInfo');
	const startDownload = document.getElementById('startDownload');
	const formattedSize = calculateTotalSelectedSize();
	const sizeText = formattedSize ? ` • ${formattedSize}` : '';

	if (selectionInfo) {
		selectionInfo.innerText = count > 0 ? `${count} selected${sizeText}` : `0 selected`;
	}

	if (startDownload) {
		startDownload.disabled = count === 0;
		startDownload.textContent = '';
		const span = document.createElement('span');
		span.textContent = count > 0 ? `Download (${count}${sizeText})` : `Download`;
		startDownload.appendChild(span);
	}
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.action === 'updateProgress') {
		if (message.message) {
			renderStatus(message.message);
		}

		if (message.newResult) {
			const correctIndex = (typeof message.resultIndex !== 'undefined') ? message.resultIndex : UIParams.results.length;
			addResult(message.newResult, correctIndex);

			// Also update extensions and categories
			updateExtensionsFromBackground();

			// Check if we should auto-select this new item (if it matches current filter)
			if (UIParams.selectedCategory) {
				const bestMatch = getBestMatchForCategory(message.newResult, UIParams.selectedCategory);
				if (bestMatch) {
					const item = document.getElementById(`item_${correctIndex}`);
					if (item) {
						const checkbox = item.querySelector('input[type="checkbox"]');
						const formatBadge = item.querySelector('.format-badge');
						const sizeBadge = item.querySelector('.size-badge');
						if (checkbox) {
							checkbox.disabled = false;
							checkbox.checked = true;
							item.classList.remove('opacity-50');
							item.classList.add('selected');
							let badgeText = bestMatch.extensionEnding.replace(/^\./, '').replace(/^_/, '').toUpperCase();
							if (formatBadge) { formatBadge.innerText = badgeText; formatBadge.hidden = false; }
							if (sizeBadge) { sizeBadge.innerText = bestMatch.size; sizeBadge.hidden = false; }
							UIParams.selectedItemIndices.add(correctIndex);
							UIParams.selectedItemMap.set(correctIndex, bestMatch);
							updateFooter();
						}
					}
				}
			} else if (UIParams.selectedExtIndex !== -1 &&
				message.newResult.extIndexes.includes(UIParams.selectedExtIndex)) {
				const item = document.getElementById(`item_${correctIndex}`);
				if (item) {
					const checkbox = item.querySelector('input[type="checkbox"]');
					const formatBadge = item.querySelector('.format-badge');
					const sizeBadge = item.querySelector('.size-badge');
					if (checkbox) {
						checkbox.disabled = false;
						checkbox.checked = true;
						item.classList.remove('opacity-50');
						item.classList.add('selected');
						const targetExt = UIParams.extensions[UIParams.selectedExtIndex];
						const ending = targetExt ? targetExt.ending : '';
						let badgeText = ending.replace(/^\./, '').replace(/^_/, '').toUpperCase();
						if (formatBadge) { formatBadge.innerText = badgeText; formatBadge.hidden = false; }
						const downloadInfo = message.newResult.downloadUrls.find(u => u.extIdx === UIParams.selectedExtIndex);
						if (downloadInfo && sizeBadge) {
							sizeBadge.innerText = downloadInfo.size;
							sizeBadge.hidden = false;
						}
						if (downloadInfo) {
							UIParams.selectedItemIndices.add(correctIndex);
							UIParams.selectedItemMap.set(correctIndex, {
								url: downloadInfo.url,
								extIdx: UIParams.selectedExtIndex,
								extensionEnding: ending,
								size: downloadInfo.size
							});
						}
						updateFooter();
					}
				}
			}
		}

		if (typeof message.current !== 'undefined' && typeof message.max !== 'undefined') {
			renderProgressBar(message.current, message.max, message.totalDiscovered);
		}

	} else if (message.action === 'error') {
		renderStatus(message.message, 'error');
		updateExtensionsFromBackground();
	} else if (message.action === 'scanComplete') {
		renderStatus(message.message || `Scan completed! ${message.totalResults} items found.`);
		scan = false;
		const stopBtn = document.getElementById('stopScanBtn');
		if (stopBtn) stopBtn.innerText = "Start Scan";

		if (typeof message.totalScanned !== 'undefined') {
			renderProgressBar(message.totalScanned, message.totalScanned, message.totalResults);
		} else {
			renderProgressBar(message.totalResults, message.totalResults, message.totalResults);
		}

		updateExtensionsFromBackground();

		if (!UIParams.selectedCategory && UIParams.selectedExtIndex === -1 && UIParams.extensions.length > 0) {
			renderStatus("Please select a file format or category to download.");
		}
	}
});

function updateExtensionsFromBackground() {
	if (!tabId) return;
	chrome.runtime.sendMessage({
		action: 'getExtensions',
		tabId: tabId
	}, function (response) {
		if (chrome.runtime.lastError) return;
		if (response && response.extensions) {
			renderExtensions(response.extensions);
		} else {
			renderExtensions([]);
		}
	});
}

async function startAutoScan(tab) {
	tabId = tab.id;

	if (tab.url.indexOf('/details') == -1 &&
		tab.url.indexOf('/search.php') == -1 &&
		tab.url.indexOf('/search') == -1 &&
		tab.url.indexOf('/download') == -1) {
		document.getElementById('badUrl').hidden = false;
		return;
	}

	let collectionIdentifier = '';
	const detailsMatch = tab.url.match(/details\/([^/?]+)/);
	const downloadMatch = tab.url.match(/download\/([^/?]+)/);

	if (detailsMatch) {
		collectionIdentifier = detailsMatch[1];
	} else if (downloadMatch) {
		collectionIdentifier = downloadMatch[1];
	}

	const TOP_LEVEL_MEDIATYPES = new Set(['texts', 'movies', 'audio', 'software', 'image', 'etree', 'web']);
	const isTopLevel = TOP_LEVEL_MEDIATYPES.has(collectionIdentifier);
	const isSearch = tab.url.includes('/search') || tab.url.includes('/search.php') || isTopLevel;
	const isUserProfile = collectionIdentifier.startsWith('@');
	let isSingleItem = !isSearch && !isUserProfile && !tab.url.includes('?') && !tab.url.includes('pub_');

	let allParams = {};
	try {
		const urlObj = new URL(tab.url);
		urlObj.searchParams.forEach((value, key) => {
			if (!allParams[key]) allParams[key] = value;
			else if (Array.isArray(allParams[key])) allParams[key].push(value);
			else allParams[key] = [allParams[key], value];
		});
	} catch (e) {
		console.warn("Failed to parse URL search params:", e);
	}

	// Try extracting visible identifiers from active tab DOM for 100% accurate uploader/item detection
	let visibleIdentifiers = [];
	try {
		if (chrome.scripting && chrome.scripting.executeScript) {
			const res = await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => {
					const anchors = Array.from(document.querySelectorAll('a[href*="/details/"]'));
					const ids = [];
					anchors.forEach(a => {
						const m = a.href.match(/\/details\/([^/?#]+)/);
						if (m && !m[1].startsWith('@') && !['texts', 'movies', 'audio', 'software', 'image', 'etree', 'web'].includes(m[1])) {
							if (!ids.includes(m[1])) ids.push(m[1]);
						}
					});
					return ids.slice(0, 10);
				}
			});
			if (res && res[0] && res[0].result) {
				visibleIdentifiers = res[0].result;
			}
		}
	} catch (e) {}

	scan = true;
	const stopBtn = document.getElementById('stopScanBtn');
	if (stopBtn) stopBtn.innerText = "Stop Scan";

	chrome.runtime.sendMessage({
		action: 'startFetching',
		url: tab.url,
		collectionIdentifier: collectionIdentifier,
		isSingleItem: isSingleItem,
		isSearch: isSearch,
		isUserProfile: isUserProfile,
		visibleIdentifiers: visibleIdentifiers,
		allParams: allParams,
		tabId: tabId
	});
}

function isSameArchiveUrl(url1, url2) {
	if (!url1 || !url2) return false;
	if (url1 === url2) return true;
	try {
		const u1 = new URL(url1);
		const u2 = new URL(url2);
		return u1.origin === u2.origin && u1.pathname === u2.pathname && u1.search === u2.search;
	} catch (e) {
		return url1.split('#')[0] === url2.split('#')[0];
	}
}

function initPopup(tab) {
	tabId = tab.id;

	chrome.runtime.sendMessage({
		action: 'getResults',
		tabId: tab.id
	}, function (response) {
		if (chrome.runtime.lastError) {
			startAutoScan(tab);
			return;
		}

		if (response && response.exists && response.results && response.results.length > 0 && isSameArchiveUrl(response.pageHref, tab.url)) {
			console.log('Restoring existing scan results for tab:', tab.id, 'Total items:', response.results.length);

			const list = document.getElementById('downloadsListWrapper');
			if (list) list.innerHTML = '';

			response.results.forEach((result, index) => {
				addResult(result, index);
			});

			if (response.extensions && response.extensions.length > 0) {
				renderExtensions(response.extensions);
			}

			if (typeof response.current !== 'undefined' && typeof response.max !== 'undefined') {
				renderProgressBar(response.current, response.max, response.results.length);
			}

			const isStillScanning = !response.scanDone && (response.isFetchingIdentifiers || response.isProcessingArticles);

			if (isStillScanning) {
				scan = true;
				const fileText = response.results.length > response.current ? ` (${response.results.length} files discovered)` : '';
				renderStatus(response.isFetchingIdentifiers ? 'Searching Archive.org...' : `Scanning: ${response.current} / ${response.max} items...${fileText}`);
				const stopBtn = document.getElementById('stopScanBtn');
				if (stopBtn) stopBtn.innerText = "Stop Scan";
			} else {
				scan = false;
				renderStatus(`Scan completed! ${response.max || response.results.length} items scanned • ${response.results.length} files found.`);
				const stopBtn = document.getElementById('stopScanBtn');
				if (stopBtn) stopBtn.innerText = "Restart Scan";

				if (!UIParams.selectedCategory && UIParams.selectedExtIndex === -1 && response.extensions && response.extensions.length > 0) {
					renderStatus("Please select a file format or category to download.");
				}
			}

			if (response.downloadStatus === 1 || response.downloadStatus === 2 || response.downloadStatus === 3) {
				if (typeof showDownloadView === 'function') {
					showDownloadView();
				}
			}

		} else {
			startAutoScan(tab);
		}
	});
}

function setupTheme() {
	const themeToggleBtn = document.getElementById('themeToggle');
	if (!themeToggleBtn) return;

	chrome.storage.local.get(['app_theme'], (res) => {
		const isDark = (res && res.app_theme === 'dark') || (!res || !res.app_theme) && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
		if (isDark) {
			document.body.classList.add('dark-mode');
			themeToggleBtn.innerText = '☀️';
		} else {
			document.body.classList.remove('dark-mode');
			themeToggleBtn.innerText = '🌙';
		}
	});

	themeToggleBtn.addEventListener('click', () => {
		const isCurrentlyDark = document.body.classList.toggle('dark-mode');
		themeToggleBtn.innerText = isCurrentlyDark ? '☀️' : '🌙';
		chrome.storage.local.set({ app_theme: isCurrentlyDark ? 'dark' : 'light' });
	});
}

function setupInstantSearch() {
	const filterInput = document.getElementById('filterInput');
	const clearFilterBtn = document.getElementById('clearFilterBtn');
	if (!filterInput) return;

	filterInput.addEventListener('input', (e) => {
		const term = e.target.value.toLowerCase().trim();
		if (clearFilterBtn) clearFilterBtn.hidden = term === '';

		const items = document.querySelectorAll('.list-item');
		let visibleCount = 0;
		items.forEach(item => {
			const titleEl = item.querySelector('.item-title');
			const title = titleEl ? titleEl.innerText.toLowerCase() : '';
			const matches = term === '' || title.includes(term);
			item.style.display = matches ? 'flex' : 'none';
			if (matches) visibleCount++;
		});

		const listTitle = document.getElementById('listTitle');
		if (listTitle) {
			const total = UIParams.results.filter(r => r != null).length;
			listTitle.innerText = term ? `Files (${visibleCount} / ${total})` : `Discovered Files (${total})`;
		}
	});

	if (clearFilterBtn) {
		clearFilterBtn.addEventListener('click', () => {
			filterInput.value = '';
			filterInput.dispatchEvent(new Event('input'));
			filterInput.focus();
		});
	}
}

// Event Listeners
document.addEventListener('DOMContentLoaded', function () {
	setupTheme();
	setupInstantSearch();

	getCurrentTab(function (tab) {
		initPopup(tab);
	});

	document.getElementById('closeBtn').addEventListener('click', () => window.close());

	const stopBtn = document.getElementById('stopScanBtn');
	if (stopBtn) {
		stopBtn.addEventListener('click', (e) => {
			if (scan) {
				scan = false;
				e.target.innerText = "Stopping...";
				chrome.runtime.sendMessage({ action: 'stopFetching', tabId: tabId });
				setTimeout(() => { e.target.innerText = "Restart Scan"; }, 1000);
			} else {
				scan = true;
				e.target.innerText = "Stop Scan";
				document.getElementById('downloadsListWrapper').innerHTML = '';
				UIParams.results = [];
				UIParams.selectedItemIndices.clear();
				UIParams.selectedItemMap.clear();
				updateFooter();

				chrome.runtime.sendMessage({ action: 'clearScanState', tabId: tabId });
				getCurrentTab((t) => startAutoScan(t));
			}
		});
	}

	const selectAllBtn = document.getElementById('selectAllBtn');
	if (selectAllBtn) {
		selectAllBtn.addEventListener('click', () => {
			selectAllMatchingItems();
			updateFooter();
		});
	}

	const selectNoneBtn = document.getElementById('selectNoneBtn');
	if (selectNoneBtn) {
		selectNoneBtn.addEventListener('click', () => {
			const allItems = document.querySelectorAll('.list-item');
			allItems.forEach(li => {
				if (li.style.display === 'none') return;
				const idx = parseInt(li.getAttribute('data-idx'));
				const cb = li.querySelector('input[type="checkbox"]');
				if (cb) cb.checked = false;
				li.classList.remove('selected');
				if (UIParams.selectedCategory || UIParams.selectedExtIndex !== -1) {
					li.classList.add('opacity-50');
				}
				const formatBadge = li.querySelector('.format-badge');
				const sizeBadge = li.querySelector('.size-badge');
				if (formatBadge) formatBadge.hidden = true;
				if (sizeBadge) sizeBadge.hidden = true;
				UIParams.selectedItemIndices.delete(idx);
				UIParams.selectedItemMap.delete(idx);
			});
			updateFooter();
		});
	}

	const startDownloadBtn = document.getElementById('startDownload');
	if (startDownloadBtn) {
		startDownloadBtn.addEventListener('click', onStartDownloadClick);
	}

	const createTxtBtn = document.getElementById('createTxtBtn');
	if (createTxtBtn) {
		createTxtBtn.addEventListener('click', () => {
			if (UIParams.selectedItemIndices.size === 0) {
				alert("Please select files first.");
				return;
			}

			const urls = [];
			UIParams.selectedItemIndices.forEach(idx => {
				const info = UIParams.selectedItemMap.get(idx);
				if (info && info.url) {
					urls.push(info.url);
				} else {
					const result = UIParams.results[idx];
					if (result && result.downloadUrls && result.downloadUrls.length > 0) {
						urls.push(result.downloadUrls[0].url);
					}
				}
			});

			if (urls.length > 0) {
				createDownloadLink(urls.join('\r\n'));
			}
		});
	}

	const newSearchBtn = document.getElementById('newSearchBtn');
	if (newSearchBtn) {
		newSearchBtn.addEventListener('click', () => {
			document.getElementById('downloadsView').hidden = true;
			document.getElementById('searchView').hidden = false;
		});
	}
});

// Handling Checkbox Clicks (Delegation)
document.addEventListener('change', (e) => {
	if (e.target.matches('.item-checkbox')) {
		const li = e.target.closest('.list-item');
		const idx = parseInt(li.getAttribute('data-idx'));
		const result = UIParams.results[idx];

		if (e.target.checked && result) {
			li.classList.remove('opacity-50');
			li.classList.add('selected');

			let downloadInfo = null;
			if (UIParams.selectedCategory) {
				downloadInfo = getBestMatchForCategory(result, UIParams.selectedCategory);
			} else if (UIParams.selectedExtIndex !== -1) {
				const targetExt = UIParams.extensions[UIParams.selectedExtIndex];
				const ending = targetExt ? targetExt.ending : '';
				const u = result.downloadUrls.find(u => u.extIdx === UIParams.selectedExtIndex);
				if (u) {
					downloadInfo = {
						url: u.url,
						extIdx: UIParams.selectedExtIndex,
						extensionEnding: ending,
						size: u.size,
						format: u.format,
						name: u.name
					};
				}
			}

			// If no active filter matched this item (e.g. user selected .zip while Videos was active), use its own best format
			if (!downloadInfo) {
				downloadInfo = getDefaultDownloadInfo(result);
			}

			if (downloadInfo) {
				const formatBadge = li.querySelector('.format-badge');
				const sizeBadge = li.querySelector('.size-badge');

				let badgeText = downloadInfo.extensionEnding.replace(/^\./, '').replace(/^_/, '').toUpperCase();
				if (formatBadge) {
					formatBadge.innerText = badgeText;
					formatBadge.hidden = false;
				}
				if (sizeBadge && downloadInfo.size) {
					sizeBadge.innerText = downloadInfo.size;
					sizeBadge.hidden = false;
				}

				UIParams.selectedItemIndices.add(idx);
				UIParams.selectedItemMap.set(idx, downloadInfo);
			}
		} else {
			li.classList.remove('selected');
			if (UIParams.selectedCategory || UIParams.selectedExtIndex !== -1) {
				li.classList.add('opacity-50');
			}
			const formatBadge = li.querySelector('.format-badge');
			const sizeBadge = li.querySelector('.size-badge');
			if (formatBadge) formatBadge.hidden = true;
			if (sizeBadge) sizeBadge.hidden = true;

			UIParams.selectedItemIndices.delete(idx);
			UIParams.selectedItemMap.delete(idx);
		}

		updateFooter();
	}
});
