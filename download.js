function onStartDownloadClick() {
	if (UIParams.selectedItemIndices.size === 0) {
		alert("Please select at least one file to download.");
		return;
	}

	console.log('Selected count:', UIParams.selectedItemIndices.size);

	let data = [];
	UIParams.selectedItemIndices.forEach(idx => {
		let info = UIParams.selectedItemMap.get(idx);
		const result = UIParams.results[idx];

		if (!info && result) {
			if (UIParams.selectedCategory) {
				info = getBestMatchForCategory(result, UIParams.selectedCategory);
			} else if (UIParams.selectedExtIndex !== -1) {
				const targetExt = UIParams.extensions[UIParams.selectedExtIndex];
				const ending = targetExt ? targetExt.ending : '';
				const u = result.downloadUrls.find(u => u.extIdx === UIParams.selectedExtIndex);
				if (u) {
					info = {
						url: u.url,
						extIdx: UIParams.selectedExtIndex,
						extensionEnding: ending,
						size: u.size,
						format: u.format,
						name: u.name
					};
				}
			}
			if (!info) {
				info = getDefaultDownloadInfo(result);
			}
		}

		if (info && info.url) {
			data.push({
				resultIndex: idx,
				extIndex: info.extIdx,
				extensionEnding: info.extensionEnding,
				url: info.url
			});
		} else if (info) {
			data.push({
				resultIndex: idx,
				extIndex: info.extIdx,
				extensionEnding: info.extensionEnding
			});
		} else if (result && result.downloadUrls && result.downloadUrls.length > 0) {
			const def = getDefaultDownloadInfo(result);
			if (def) {
				data.push({
					resultIndex: idx,
					extIndex: def.extIdx,
					extensionEnding: def.extensionEnding,
					url: def.url
				});
			}
		}
	});

	if (data.length === 0) return;

	chrome.runtime.sendMessage({
		action: 'startDownload',
		tabId: tabId,
		data: data
	});

	showDownloadView();
}

let isDownloadsPaused = false;

// Global listeners for download actions
document.addEventListener('DOMContentLoaded', () => {
	const retryBtn = document.getElementById('retryFailedBtn');
	if (retryBtn) {
		retryBtn.addEventListener('click', () => {
			chrome.runtime.sendMessage({
				action: 'retryFailedDownloads',
				tabId: tabId
			}, (response) => {
				if (response && response.count > 0) {
					document.getElementById('downloadCompleted').hidden = true;
					paintDownloadView();
				}
			});
		});
	}

	const exportErrorsBtn = document.getElementById('exportErrorsBtn');
	if (exportErrorsBtn) {
		exportErrorsBtn.addEventListener('click', () => {
			chrome.runtime.sendMessage({
				action: 'getDownloadProgress',
				tabId: tabId
			}, (response) => {
				if (response && response.progress) {
					const failedItems = response.progress.filter(item =>
						item.state === 'interrupted' || item.state === 'canceled'
					);

					if (failedItems.length > 0) {
						const urls = failedItems.map(item => item.url).join('\r\n');
						const a = document.createElement('a');
						const blob = new Blob([urls], { type: 'text/plain' });
						a.href = window.URL.createObjectURL(blob);
						a.download = 'archive_failed_downloads.txt';
						document.body.appendChild(a);
						a.click();
						document.body.removeChild(a);
					} else {
						alert("No failed items found to export.");
					}
				}
			});
		});
	}

	const pauseResumeAllBtn = document.getElementById('pauseResumeAllBtn');
	if (pauseResumeAllBtn) {
		pauseResumeAllBtn.addEventListener('click', () => {
			if (!isDownloadsPaused) {
				isDownloadsPaused = true;
				pauseResumeAllBtn.innerText = '▶ Resume All';
				chrome.runtime.sendMessage({ action: 'pauseDownloads', tabId: tabId }, () => {
					paintDownloadView();
				});
			} else {
				isDownloadsPaused = false;
				pauseResumeAllBtn.innerText = '⏸ Pause All';
				chrome.runtime.sendMessage({ action: 'resumeDownloads', tabId: tabId }, () => {
					paintDownloadView();
				});
			}
		});
	}

	const cancelAllBtn = document.getElementById('cancelAllBtn');
	if (cancelAllBtn) {
		cancelAllBtn.addEventListener('click', () => {
			if (confirm('Cancel all pending and active downloads?')) {
				isDownloadsPaused = false;
				if (pauseResumeAllBtn) pauseResumeAllBtn.innerText = '⏸ Pause All';
				chrome.runtime.sendMessage({ action: 'cancelDownloads', tabId: tabId }, () => {
					paintDownloadView();
				});
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

function createDownloadItem(item) {
	const div = document.createElement('div');
	div.className = 'list-item';

	let statusText = item.state;
	let progressPercent = 0;
	if (item.totalBytes > 0) {
		progressPercent = Math.round((item.bytesReceived / item.totalBytes) * 100);
	}

	let statusColor = 'var(--text-muted)';
	if (item.state === 'in_progress') statusColor = 'var(--primary)';
	if (item.state === 'completed') statusColor = 'var(--accent)';
	if (item.state === 'interrupted' || item.state === 'canceled') statusColor = '#ef4444';
	if (item.state === 'paused') statusColor = '#f59e0b';

	if (item.state === 'in_progress') {
		const mb = (item.bytesReceived / (1024 * 1024)).toFixed(1);
		const totalMb = item.totalBytes > 0 ? ` / ${(item.totalBytes / (1024 * 1024)).toFixed(1)} MB` : '';
		statusText = `${progressPercent}% (${mb}${totalMb})`;
	} else if (item.state === 'starting') {
		statusText = 'Starting...';
	} else if (item.state === 'paused') {
		statusText = 'Paused';
	} else if (item.state === 'interrupted') {
		statusText = `Failed: ${item.errorMsg || 'Error'}`;
	} else if (item.state === 'canceled') {
		statusText = 'Canceled';
	}

	div.textContent = '';
	const innerDiv = document.createElement('div');
	innerDiv.style.flex = '1';
	
	const titleDiv = document.createElement('div');
	titleDiv.className = 'item-title';
	titleDiv.style.fontSize = '12px';
	titleDiv.textContent = item.filename || 'File';
	
	const statusRow = document.createElement('div');
	statusRow.style.display = 'flex';
	statusRow.style.justifyContent = 'space-between';
	statusRow.style.fontSize = '10px';
	statusRow.style.color = statusColor;
	statusRow.style.marginTop = '2px';
	
	const statusSpan = document.createElement('span');
	statusSpan.textContent = statusText;
	statusRow.appendChild(statusSpan);
	
	innerDiv.appendChild(titleDiv);
	innerDiv.appendChild(statusRow);
	
	if (item.state === 'in_progress' || item.state === 'paused') {
		const progressWrapper = document.createElement('div');
		progressWrapper.style.height = '4px';
		progressWrapper.style.background = 'var(--border)';
		progressWrapper.style.borderRadius = '2px';
		progressWrapper.style.marginTop = '4px';
		progressWrapper.style.overflow = 'hidden';

		const progressFill = document.createElement('div');
		progressFill.style.height = '100%';
		progressFill.style.width = progressPercent + '%';
		progressFill.style.background = statusColor;
		progressFill.style.transition = 'width 0.2s';
		progressWrapper.appendChild(progressFill);

		innerDiv.appendChild(progressWrapper);
	}
	div.appendChild(innerDiv);

	return div;
}

function showDownloadView() {
	document.getElementById('searchView').hidden = true;
	document.getElementById('downloadsView').hidden = false;
	paintDownloadView();
}

function paintDownloadView() {
	if (document.getElementById('downloadsView').hidden) return;

	chrome.runtime.sendMessage({
		action: 'getDownloadProgress',
		tabId: tabId
	}, function (response) {
		const list = document.getElementById('downloadProgressList');
		let hasErrors = false;

		if (response && response.progress) {
			list.innerHTML = '';

			response.progress.forEach(item => {
				const el = createDownloadItem(item);
				list.appendChild(el);

				if (item.state === 'interrupted' || item.state === 'canceled') {
					hasErrors = true;
				}
			});
		}

		const errorActions = document.getElementById('errorActions');
		if (errorActions) {
			errorActions.style.display = hasErrors ? 'flex' : 'none';
		}

		chrome.runtime.sendMessage({
			action: 'getDownloadStatus',
			tabId: tabId
		}, function (statusResponse) {
			if (statusResponse && statusResponse.status == 2) {
				document.getElementById('downloadCompleted').hidden = false;
			} else {
				setTimeout(paintDownloadView, 1000);
			}
		});
	});
}
