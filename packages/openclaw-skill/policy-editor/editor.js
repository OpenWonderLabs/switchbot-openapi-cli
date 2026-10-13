const $ = (id) => document.getElementById(id);

async function loadPolicy() {
  const response = await fetch('/policy');
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}

async function requestPolicyState(source) {
  const response = await fetch('/policy/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function editPolicy(source, edit) {
  const response = await fetch('/policy/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, edit }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}

async function savePolicy(source) {
  const response = await fetch('/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: source,
  });
  if (!response.ok) throw new Error(await response.text());
}

function setStatus(message, isError = false) {
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function renderAliases(aliases) {
  const list = $('aliases-list');
  list.replaceChildren();
  for (const [alias, deviceId] of Object.entries(aliases)) {
    const row = document.createElement('div');
    row.className = 'alias-row';
    const name = document.createElement('span');
    name.className = 'alias-name';
    name.textContent = alias;
    const id = document.createElement('span');
    id.className = 'alias-id';
    id.textContent = deviceId;
    const remove = document.createElement('button');
    remove.className = 'alias-delete';
    remove.textContent = '✕';
    remove.addEventListener('click', () => applyEdit({ kind: 'delete-alias', alias }));
    row.append(name, id, remove);
    list.append(row);
  }
}

async function synchroniseControls() {
  const state = await requestPolicyState($('raw-yaml').value);
  $('confirm-lock').checked = state.confirmLock;
  $('quiet-start').value = state.quietStart;
  $('quiet-end').value = state.quietEnd;
  renderAliases(state.aliases);
}

let edits = Promise.resolve();
function applyEdit(edit) {
  const raw = $('raw-yaml');
  const source = raw.value;
  edits = edits.then(async () => {
    const transformed = await editPolicy(source, edit);
    if (raw.value !== source) {
      setStatus('Raw YAML changed while this edit was pending; retry the edit.', true);
      return;
    }
    raw.value = transformed;
    await synchroniseControls();
    setStatus('Edited');
  }).catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
  return edits;
}

const rawYaml = await loadPolicy();
$('raw-yaml').value = rawYaml;
try {
  await synchroniseControls();
} catch (error) {
  setStatus(error instanceof Error ? error.message : String(error), true);
}

$('add-alias').addEventListener('click', async () => {
  const alias = prompt('Friendly name (e.g. "bedroom light"):');
  if (!alias?.trim()) return;
  const deviceId = prompt(`Device ID for "${alias.trim()}":`);
  if (!deviceId?.trim()) return;
  await applyEdit({ kind: 'alias', alias, deviceId });
});

$('confirm-lock').addEventListener('change', () => {
  void applyEdit({ kind: 'confirm-lock', enabled: $('confirm-lock').checked });
});

['quiet-start', 'quiet-end'].forEach((id) => {
  $(id).addEventListener('change', () => {
    void applyEdit({ kind: 'quiet-hours', start: $('quiet-start').value, end: $('quiet-end').value });
  });
});

$('raw-yaml').addEventListener('input', () => {
  void synchroniseControls().catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
});

$('save-btn').addEventListener('click', async () => {
  try {
    await edits;
    await savePolicy($('raw-yaml').value);
    setStatus('Saved');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});
