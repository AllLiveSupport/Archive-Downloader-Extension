function onStartDownloadClick() {
	if (UIParams.selectedItemIndices.size === 0) return;
	if (UIParams.selectedExtIndex === -1) {
		alert("Please select a format.");
		return;
	}

	console.log('Selected count:', UIParams.selectedItemIndices.size);

	// Prepare simple data structure: just the indices
	// Background will look up the URLs to ensure accuracy
	let data = [];
	UIParams.selectedItemIndices.forEach(idx => {
		data.push({
			resultIndex: idx,
			extIndex: UIParams.selectedExtIndex
		});
	});

	chrome.runtime.sendMessage({
		action: 'startDownload',
		tabId: tabId,
		data: data
	});

	showDownloadView();

	// Open defaults downloads page if valid
	/*
	if (!downloadsTabId) {
		chrome.tabs.create({url:'chrome://downloads', active: false}, function (tab){
			downloadsTabId = tab.id;
		});
	}*/
}

// Global listeners for new buttons
document.addEventListener('DOMContentLoaded', () => {
	const retryBtn = document.getElementById('retryFailedBtn');
	if (retryBtn) {
		retryBtn.addEventListener('click', () => {
			chrome.runtime.sendMessage({
				action: 'retryFailedDownloads',
				tabId: tabId
			}, (response) => {
				if (response && response.count > 0) {
					// Hide completed banner if shown
					document.getElementById('downloadCompleted').hidden = true;
					// Re-paint immediately to update UI state
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

	if (item.state === 'in_progress') {
		const mb = (item.bytesReceived / (1024 * 1024)).toFixed(1);
		statusText = `${progressPercent}% (${mb} MB)`;
	} else if (item.state === 'starting') {
		statusText = 'Starting...';
	} else if (item.state === 'interrupted') {
		statusText = `Failed: ${item.errorMsg || 'Unknown error'}`;
	}

	// Simple progress bar
	const progressBar = `
		<div style="height:4px; background:#e2e8f0; border-radius:2px; margin-top:4px; overflow:hidden;">
			<div style="height:100%; width:${progressPercent}%; background:${statusColor}; transition:width 0.2s;"></div>
		</div>
	`;

	div.innerHTML = `
		<div style="flex:1;">
			<div class="item-title" style="font-size:12px;">${item.filename || 'File'}</div>
			<div style="display:flex; justify-content:space-between; font-size:10px; color:${statusColor}; margin-top:2px;">
				<span>${statusText}</span>
			</div>
			${item.state === 'in_progress' ? progressBar : ''}
		</div>
	`;

	return div;
}

function showDownloadView() {
	document.getElementById('searchView').hidden = true;
	document.getElementById('downloadsView').hidden = false;

	// Start polling
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

		// Show/Hide error actions
		const errorActions = document.getElementById('errorActions');
		if (errorActions) {
			errorActions.style.display = hasErrors ? 'flex' : 'none';
		}

		// Check status
		chrome.runtime.sendMessage({
			action: 'getDownloadStatus',
			tabId: tabId
		}, function (statusResponse) {
			if (statusResponse && statusResponse.status == 2) { // Completed
				document.getElementById('downloadCompleted').hidden = false;
			} else {
				setTimeout(paintDownloadView, 1000);
			}
		});
	});
}
