function addLink(result, resultsIndex) {
	const list = document.getElementById('downloadsListWrapper');
	if (!list) return;

	// Create list item
	const div = document.createElement('div');
	div.className = 'list-item opacity-50'; // Default disabled until format selected
	div.id = `item_${resultsIndex}`;
	div.setAttribute('data-idx', resultsIndex);

	// Determine title
	let label = result.title;
	if (!label) {
		label = result.url.split('/').pop().replace(/_/g, ' ');
	}

	div.innerHTML = `
		<input type="checkbox" class="item-checkbox" id="cb_${resultsIndex}" disabled>
		<div class="item-details">
			<label for="cb_${resultsIndex}" class="item-title" title="${label}">${label}</label>
			<!-- <span class="item-meta">Waiting...</span> -->
		</div>
		<div class="item-status">
			<span class="size-badge" style="font-size:11px; color:var(--text-muted); font-weight:600;" hidden></span>
		</div>
	`;

	list.appendChild(div);
}

function addExtensionChip(ext, index) {
	const container = document.getElementById('extList');
	if (!container) return;

	const chip = document.createElement('div');
	chip.className = 'chip';
	chip.id = `ext_chip_${index}`;

	// Simple percentage color calculation
	// >80 green, >50 blue, >20 orange, else gray
	let colorStyle = '';
	if (ext.percentage > 80) colorStyle = 'color: var(--accent);';
	else if (ext.percentage > 50) colorStyle = 'color: var(--primary);';
	else if (ext.percentage > 20) colorStyle = 'color: #f59e0b;';

	chip.innerHTML = `
		<span>${ext.ending}</span>
		<span style="font-size:10px; opacity:0.8; ${colorStyle}">${ext.percentage}%</span>
	`;

	chip.addEventListener('click', () => {
		onExtensionSelect(index);
	});

	container.appendChild(chip);
}
