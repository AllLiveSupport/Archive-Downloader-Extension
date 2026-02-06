// Copyright (c) 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

const parser = new DOMParser();
let scan = true;
let tabId;

// State object to track UI state
const UIParams = {
	results: [],      // Store results locally to avoid constant DOM scraping
	extensions: [],
	selectedExtIndex: -1, // -1 means none
	selectedItemIndices: new Set() // Set of result indices
};

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

function renderProgressBar(current, max) {
	const progressBar = document.getElementById('progressBar');
	const progressCount = document.getElementById('progressCount');
	const progressTotal = document.getElementById('progressTotal');

	if (!progressBar) return;

	const percentage = max > 0 ? (current / max) * 100 : 0;
	progressBar.style.width = `${percentage}%`;

	progressCount.innerText = `${current} found`;
	progressTotal.innerText = max > 0 ? `/ ${max} total` : '';
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
 * @param {Object} result The result object from background
 * @param {Number} index The index of this result in background 'results' array
 */
function addResult(result, index) {
	// Store in local state
	UIParams.results[index] = result;

	// Add to DOM
	addLink(result, index);
}

// Called when extensions list is updated from background
function renderExtensions(extensions) {
	UIParams.extensions = extensions;
	const extList = document.getElementById('extList');
	if (!extList) return;

	extList.innerHTML = '';

	extensions.forEach((ext, index) => {
		addExtensionChip(ext, index);
	});

	// Re-apply selection if exists
	if (UIParams.selectedExtIndex !== -1) {
		const chip = document.getElementById(`ext_chip_${UIParams.selectedExtIndex}`);
		if (chip) chip.classList.add('active');
	}
}

function onExtensionSelect(index) {
	// Deselect previous
	if (UIParams.selectedExtIndex !== -1) {
		const prev = document.getElementById(`ext_chip_${UIParams.selectedExtIndex}`);
		if (prev) prev.classList.remove('active');
	}

	// Select new
	UIParams.selectedExtIndex = index;
	const next = document.getElementById(`ext_chip_${index}`);
	if (next) next.classList.add('active');

	// Update list visibility based on selection
	refreshListVisibility();

	// FIX: Automatically select all items that match the new format
	// This restores the "Swiss Army Knife" feel - click format -> get files.
	selectAllMatchingItems();

	updateFooter();
}

function refreshListVisibility() {
	// This function updates the UI list items based on whether they have the selected extension
	// In the original, it just "disabled" checkboxes. 
	// Here, we can visualize availability.

	const allItems = document.querySelectorAll('.list-item');
	allItems.forEach(item => {
		const idx = parseInt(item.getAttribute('data-idx'));
		const result = UIParams.results[idx];

		if (!result) return;

		const hasExt = result.extIndexes.includes(UIParams.selectedExtIndex);
		const checkbox = item.querySelector('input[type="checkbox"]');
		const sizeBadge = item.querySelector('.size-badge'); // We need to add this to DOM

		if (hasExt) {
			item.classList.remove('opacity-50');
			checkbox.disabled = false;

			// Update size badge if possible
			const downloadInfo = result.downloadUrls.find(u => u.extIdx === UIParams.selectedExtIndex);
			if (downloadInfo && sizeBadge) {
				sizeBadge.innerText = downloadInfo.size;
				sizeBadge.hidden = false;
			}
		} else {
			item.classList.add('opacity-50');
			checkbox.disabled = true;
			checkbox.checked = false;
			if (sizeBadge) sizeBadge.hidden = true;

			UIParams.selectedItemIndices.delete(idx);
			item.classList.remove('selected');
		}
	});
}

function selectAllMatchingItems() {
	if (UIParams.selectedExtIndex === -1) return;

	// Use data-idx from DOM to map back to state
	const allItems = document.querySelectorAll('.list-item');
	allItems.forEach(item => {
		const idx = parseInt(item.getAttribute('data-idx'));
		const result = UIParams.results[idx];

		if (result && result.extIndexes.includes(UIParams.selectedExtIndex)) {
			// It has the format. Select it.
			const checkbox = item.querySelector('input[type="checkbox"]');
			if (checkbox && !checkbox.disabled) {
				checkbox.checked = true;
				item.classList.add('selected');
				UIParams.selectedItemIndices.add(idx);
			}
		}
	});
}

function updateFooter() {
	const count = UIParams.selectedItemIndices.size;
	const selectionInfo = document.getElementById('selectionInfo');
	const startDownload = document.getElementById('startDownload');
	const createTxtBtn = document.getElementById('createTxtBtn'); // Optional

	if (selectionInfo) selectionInfo.innerText = `${count} selected`;

	if (startDownload) {
		startDownload.disabled = count === 0;
		startDownload.innerHTML = count > 0 ?
			`<span>Download (${count})</span>` :
			`<span>Download</span>`;
	}
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.action === 'updateProgress') {
		if (message.message) {
			renderStatus(message.message);
		}

		if (message.newResult) {
			const correctIndex = message.current ? (message.current - 1) : UIParams.results.length;
			addResult(message.newResult, correctIndex);

			// Also update extensions
			updateExtensionsFromBackground();

			// Check if we should auto-select this new item (if it matches current filter)
			if (UIParams.selectedExtIndex !== -1 &&
				message.newResult.extIndexes.includes(UIParams.selectedExtIndex)) {
				const item = document.getElementById(`item_${correctIndex}`);
				if (item) {
					const checkbox = item.querySelector('input[type="checkbox"]');
					if (checkbox) {
						checkbox.checked = true;
						item.classList.add('selected');
						UIParams.selectedItemIndices.add(correctIndex);
						updateFooter();

						// Update size immediately
						const sizeBadge = item.querySelector('.size-badge');
						const downloadInfo = message.newResult.downloadUrls.find(u => u.extIdx === UIParams.selectedExtIndex);
						if (downloadInfo && sizeBadge) {
							sizeBadge.innerText = downloadInfo.size;
							sizeBadge.hidden = false;
						}
					}
				}
			}
		}

		if (typeof message.current !== 'undefined' && typeof message.max !== 'undefined') {
			renderProgressBar(message.current, message.max);
		}

	} else if (message.action === 'error') {
		renderStatus(message.message, 'error');
		updateExtensionsFromBackground(); // Ensure we clear Skeletons if needed
	} else if (message.action === 'scanComplete') {
		renderStatus(`Scan completed! ${message.totalResults} items found.`);
		scan = false;
		const stopBtn = document.getElementById('stopScanBtn');
		if (stopBtn) stopBtn.innerText = "Start Scan";

		// Ensure extensions are up to date and skeletons cleared
		updateExtensionsFromBackground();

		if (UIParams.selectedExtIndex === -1 && UIParams.extensions.length > 0) {
			renderStatus("Please select a file format to download.");
		}
	}
});

function updateExtensionsFromBackground() {
	if (!tabId) return;
	chrome.runtime.sendMessage({
		action: 'getExtensions',
		tabId: tabId
	}, function (response) {
		if (chrome.runtime.lastError) {
			// Ignore
			return;
		}
		if (response && response.extensions) {
			renderExtensions(response.extensions);
		} else {
			// If we got a response but no extensions, render empty to clear skeletons
			renderExtensions([]);
		}
	});
}

function loadResultsFromBackground() {
	chrome.runtime.sendMessage({
		action: 'getResults',
		tabId: tabId
	}, function (response) {
		if (response && response.results) {
			const list = document.getElementById('downloadsListWrapper');
			if (list) list.innerHTML = ''; // Clear

			response.results.forEach((result, index) => {
				addResult(result, index);
			});

			// Restore valid selection state if possible? 
			// For now, reset selection state as we reload
			UIParams.selectedItemIndices.clear();
			updateFooter();
		}
	});
}

function startAutoScan(tab) {
	tabId = tab.id;

	// Basic URL check - Allow details, search.php, /search/ AND /download/
	if (tab.url.indexOf('/details') == -1 &&
		tab.url.indexOf('/search.php') == -1 &&
		tab.url.indexOf('/search') == -1 &&
		tab.url.indexOf('/download') == -1) {
		document.getElementById('badUrl').hidden = false;
		return;
	}

	// Extract info
	// Handle both /details/ID and /download/ID
	let collectionIdentifier = '';
	const detailsMatch = tab.url.match(/details\/([^/?]+)/);
	const downloadMatch = tab.url.match(/download\/([^/?]+)/); // Extract ID from download URL

	if (detailsMatch) {
		collectionIdentifier = detailsMatch[1];
	} else if (downloadMatch) {
		collectionIdentifier = downloadMatch[1];
	}

	const isSingleItem = !tab.url.includes('?') && !tab.url.includes('pub_'); // Rough check
	const isSearch = tab.url.includes('/search') || tab.url.includes('/search.php');

	let allParams = {};
	try {
		const urlObj = new URL(tab.url);
		urlObj.searchParams.forEach((value, key) => {
			if (!allParams[key]) allParams[key] = value;
			else if (Array.isArray(allParams[key])) allParams[key].push(value);
			else allParams[key] = [allParams[key], value];
		});
	} catch (e) { }

	scan = true;
	const stopBtn = document.getElementById('stopScanBtn');
	if (stopBtn) stopBtn.innerText = "Stop Scan";

	chrome.runtime.sendMessage({
		action: 'startFetching',
		url: tab.url,
		collectionIdentifier: collectionIdentifier,
		isSingleItem: isSingleItem,
		isSearch: isSearch,
		allParams: allParams,
		tabId: tabId
	});

	if (isSearch) {
		renderStatus('Searching Archive.org...');
	} else {
		renderStatus(isSingleItem ? 'Getting item info...' : 'Scanning collection...');
	}
}

function initPopup(tab) {
	tabId = tab.id;

	// Check if already scanning or has results
	chrome.runtime.sendMessage({
		action: 'getResults',
		tabId: tabId
	}, function (response) {
		if (response && response.results && response.results.length > 0) {
			// Already has data
			document.getElementById('searchView').style.display = 'flex';
			loadResultsFromBackground();
			updateExtensionsFromBackground();

			// SYNC SCAN STATE: Check if background is still active
			const isStillScanning = !response.scanDone || response.isFetchingIdentifiers;

			if (isStillScanning) {
				scan = true;
				renderStatus(response.isFetchingIdentifiers ? 'Searching Archive.org...' : `Scanning item: ${response.current} / ${response.max}...`);
				const stopBtn = document.getElementById('stopScanBtn');
				if (stopBtn) stopBtn.innerText = "Stop Scan";
			} else {
				scan = false;
				renderStatus(`Scan completed. ${response.results.length} items found.`);
				const stopBtn = document.getElementById('stopScanBtn');
				if (stopBtn) stopBtn.innerText = "Restart Scan";
			}

			// VIEW RESTORATION: If a download is active or completed, switch to download view
			if (response.downloadStatus === 1 || response.downloadStatus === 2 || response.downloadStatus === 3) {
				if (typeof showDownloadView === 'function') {
					showDownloadView();
				}
			}

		} else {
			// Start new
			startAutoScan(tab);
		}
	});
}

// Event Listeners
document.addEventListener('DOMContentLoaded', function () {
	getCurrentTab(function (tab) {
		initPopup(tab);
	});

	document.getElementById('closeBtn').addEventListener('click', () => window.close());

	const stopBtn = document.getElementById('stopScanBtn');
	if (stopBtn) {
		stopBtn.addEventListener('click', (e) => {
			if (scan) {
				// Stop
				scan = false;
				e.target.innerText = "Stopping...";
				chrome.runtime.sendMessage({ action: 'stopFetching', tabId: tabId });
				setTimeout(() => { e.target.innerText = "Restart Scan"; }, 1000);
			} else {
				// Restart
				scan = true;
				e.target.innerText = "Stop Scan";
				// Clear UI
				document.getElementById('downloadsListWrapper').innerHTML = '';
				UIParams.results = [];
				UIParams.selectedItemIndices.clear();
				updateFooter();

				getCurrentTab((t) => startAutoScan(t));
			}
		});
	}

	const selectAllBtn = document.getElementById('selectAllBtn');
	if (selectAllBtn) {
		selectAllBtn.addEventListener('click', () => {
			if (UIParams.selectedExtIndex === -1) {
				alert("Please select a format first.");
				return;
			}
			selectAllMatchingItems();
			updateFooter();
		});
	}

	const selectNoneBtn = document.getElementById('selectNoneBtn');
	if (selectNoneBtn) {
		selectNoneBtn.addEventListener('click', () => {
			const allCheckboxes = document.querySelectorAll('.list-item input[type="checkbox"]');
			allCheckboxes.forEach(cb => cb.checked = false);
			document.querySelectorAll('.list-item.selected').forEach(li => li.classList.remove('selected'));
			UIParams.selectedItemIndices.clear();
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
			if (UIParams.selectedItemIndices.size === 0) return;

			// Collect URLs
			const urls = [];
			UIParams.selectedItemIndices.forEach(idx => {
				const result = UIParams.results[idx];
				const dlInfo = result.downloadUrls.find(u => u.extIdx === UIParams.selectedExtIndex);
				if (dlInfo) urls.push(dlInfo.url);
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

		if (e.target.checked) {
			li.classList.add('selected');
			UIParams.selectedItemIndices.add(idx);
		} else {
			li.classList.remove('selected');
			UIParams.selectedItemIndices.delete(idx);
		}

		updateFooter();
	}
});
