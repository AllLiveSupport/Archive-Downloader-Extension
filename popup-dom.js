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

	div.textContent = '';
	
	const checkbox = document.createElement('input');
	checkbox.type = 'checkbox';
	checkbox.className = 'item-checkbox';
	checkbox.id = `cb_${resultsIndex}`;
	checkbox.disabled = true;
	div.appendChild(checkbox);

	const detailsDiv = document.createElement('div');
	detailsDiv.className = 'item-details';
	
	const labelEl = document.createElement('label');
	labelEl.htmlFor = `cb_${resultsIndex}`;
	labelEl.className = 'item-title';
	labelEl.title = label;
	labelEl.textContent = label;
	detailsDiv.appendChild(labelEl);
	div.appendChild(detailsDiv);

	const statusDiv = document.createElement('div');
	statusDiv.className = 'item-status';
	
	const sizeBadge = document.createElement('span');
	sizeBadge.className = 'size-badge';
	sizeBadge.style.fontSize = '11px';
	sizeBadge.style.color = 'var(--text-muted)';
	sizeBadge.style.fontWeight = '600';
	sizeBadge.hidden = true;
	statusDiv.appendChild(sizeBadge);
	div.appendChild(statusDiv);

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

	chip.textContent = '';
	const span1 = document.createElement('span');
	span1.textContent = ext.ending;
	chip.appendChild(span1);

	const span2 = document.createElement('span');
	span2.style.fontSize = '10px';
	span2.style.opacity = '0.8';
	if (colorStyle) span2.style = colorStyle + ' font-size:10px; opacity:0.8;';
	span2.textContent = ext.percentage + '%';
	chip.appendChild(span2);

	chip.addEventListener('click', () => {
		onExtensionSelect(index);
	});

	container.appendChild(chip);
}
