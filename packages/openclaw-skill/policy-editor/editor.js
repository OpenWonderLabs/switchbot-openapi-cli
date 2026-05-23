// policy-editor/editor.js
const $ = id => document.getElementById(id);

async function loadPolicy() {
  const res = await fetch('/policy');
  return await res.text();
}

async function savePolicy(yaml) {
  const res = await fetch('/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: yaml,
  });
  return res.ok;
}

function parseField(yaml, key) {
  const m = yaml.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function setField(yaml, key, value) {
  const re = new RegExp(`(^\\s*${key}:).*$`, 'm');
  return re.test(yaml) ? yaml.replace(re, `$1 "${value}"`) : yaml;
}

// ── Aliases ──────────────────────────────────────────────────────────────────

function parseAliases(yaml) {
  const section = yaml.match(/^aliases:\s*\n((?:[ \t]+.+\n)*)/m);
  if (!section) return {};
  const aliases = {};
  for (const line of section[1].split('\n')) {
    const m = line.match(/^\s+"?([^":]+)"?\s*:\s*"?([^"]+)"?\s*$/);
    if (m) aliases[m[1].trim()] = m[2].trim();
  }
  return aliases;
}

function renderAliases(aliases) {
  const list = $('aliases-list');
  list.innerHTML = '';
  for (const [alias, deviceId] of Object.entries(aliases)) {
    const row = document.createElement('div');
    row.className = 'alias-row';
    row.innerHTML = `<span class="alias-name">${alias}</span>
      <span class="alias-id">${deviceId}</span>
      <button class="alias-delete" data-alias="${alias}">✕</button>`;
    list.appendChild(row);
  }
  list.querySelectorAll('.alias-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const currentAliases = parseAliases($('raw-yaml').value);
      delete currentAliases[btn.dataset.alias];
      $('raw-yaml').value = writeAliases($('raw-yaml').value, currentAliases);
      renderAliases(currentAliases);
    });
  });
}

function writeAliases(yaml, aliases) {
  const entries = Object.entries(aliases)
    .map(([a, id]) => `  "${a}": "${id}"`)
    .join('\n');
  const block = entries ? `aliases:\n${entries}\n` : `aliases:\n`;
  return yaml.replace(/^aliases:\s*\n((?:[ \t]+.+\n)*)*/m, block);
}

$('add-alias').addEventListener('click', () => {
  const alias    = prompt('Friendly name (e.g. "bedroom light"):');
  if (!alias?.trim()) return;
  const deviceId = prompt(`Device ID for "${alias.trim()}":`);
  if (!deviceId?.trim()) return;
  const currentAliases = parseAliases($('raw-yaml').value);
  currentAliases[alias.trim()] = deviceId.trim();
  $('raw-yaml').value = writeAliases($('raw-yaml').value, currentAliases);
  renderAliases(currentAliases);
});

// ── Confirm-lock ─────────────────────────────────────────────────────────────

function setConfirmLock(yaml, enabled) {
  if (enabled) {
    // Ensure lock and unlock appear in always_confirm
    if (!/always_confirm/.test(yaml)) {
      yaml = yaml.replace(/(confirmations:\s*\n)/, '$1  always_confirm: ["lock", "unlock"]\n');
    } else {
      yaml = yaml.replace(/^(\s*always_confirm:\s*\[)\]/m, '$1"lock", "unlock"]');
    }
  } else {
    yaml = yaml.replace(/"lock",?\s*/g, '').replace(/"unlock",?\s*/g, '');
    yaml = yaml.replace(/,\s*\]/g, ']');
  }
  return yaml;
}

// ── Initialise ────────────────────────────────────────────────────────────────

const rawYaml = await loadPolicy();
$('raw-yaml').value = rawYaml;

const quietStart = parseField(rawYaml, 'start');
const quietEnd   = parseField(rawYaml, 'end');
if (quietStart) $('quiet-start').value = quietStart;
if (quietEnd)   $('quiet-end').value   = quietEnd;

$('confirm-lock').checked = /always_confirm[^]]*lock/.test(rawYaml);

renderAliases(parseAliases(rawYaml));

// ── Save ──────────────────────────────────────────────────────────────────────

$('save-btn').addEventListener('click', async () => {
  let yaml = $('raw-yaml').value;
  yaml = setField(yaml, 'start', $('quiet-start').value);
  yaml = setField(yaml, 'end',   $('quiet-end').value);
  yaml = setConfirmLock(yaml, $('confirm-lock').checked);
  $('raw-yaml').value = yaml;
  const ok = await savePolicy(yaml);
  $('status').textContent = ok ? 'Saved' : 'Error';
  setTimeout(() => { $('status').textContent = ''; }, 2000);
});

['quiet-start', 'quiet-end'].forEach(id => {
  $(id).addEventListener('change', () => {
    let yaml = $('raw-yaml').value;
    yaml = setField(yaml, 'start', $('quiet-start').value);
    yaml = setField(yaml, 'end',   $('quiet-end').value);
    $('raw-yaml').value = yaml;
  });
});

$('confirm-lock').addEventListener('change', () => {
  $('raw-yaml').value = setConfirmLock($('raw-yaml').value, $('confirm-lock').checked);
});
