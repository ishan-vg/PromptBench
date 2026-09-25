/*
  popup.js — Settings page logic.

  Opens when the user clicks the PromptBench icon in the toolbar.
  Loads saved settings from chrome.storage.local, lets the user
  edit them, and saves on click.

  Python analogy: this is like a settings GUI (think Tkinter) that
  reads/writes a config file — except the "file" is chrome.storage.

  PB_MODES comes from modes.js, loaded via <script> before this file
  (see popup.html) — same shared list content.js and service-worker.js use.
*/

// ── DOM REFERENCES ──────────────────────────────────────────────────────
// Grabbed once so we don't query the DOM repeatedly (like caching soup.find)
const apiKeyInput   = document.getElementById('pb-api-key');
const toggleBtn     = document.getElementById('pb-toggle-key');
const styleSelect   = document.getElementById('pb-default-style');
const saveBtn       = document.getElementById('pb-save');
const statusEl      = document.getElementById('pb-status');

// v0.5 additions — Feature 2's context toggle and Feature 1's backup
// buttons, grabbed here alongside the v0.4 elements above so every DOM
// reference in this file lives in one place.
const useContextCheckbox = document.getElementById('pb-use-context');
const exportFavoritesBtn = document.getElementById('pb-export-favorites');
const importFavoritesBtn = document.getElementById('pb-import-favorites');
const importFileInput    = document.getElementById('pb-import-file-input');


// ── POPULATE THE MODE DROPDOWN ──────────────────────────────────────────
// Built from PB_MODES so this list can never drift out of sync with the
// modes offered in the on-page menu (content.js) or sent to Gemini
// (service-worker.js).
for (const mode of PB_MODES) {
  const opt = document.createElement('option');
  opt.value = mode.value;
  opt.textContent = `${mode.icon}  ${mode.label}`;
  styleSelect.appendChild(opt);
}


// ── LOAD SAVED SETTINGS ─────────────────────────────────────────────────
// DOMContentLoaded fires once the popup HTML is fully parsed.
// We read from chrome.storage and populate the form fields.
//
// (This popup's <script> tags sit at the very bottom of <body> — see
// popup.html — so by the time THIS file even starts running, the HTML
// above it, including every element we look up with getElementById, is
// already guaranteed to exist. Waiting for DOMContentLoaded here is a bit
// belt-and-braces, but it's a good habit: if someone later moves these
// <script> tags into <head>, this code keeps working without changes,
// where the DOM lookups above it would suddenly start failing.)
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // v0.5: reads one extra key ('pbUseThreadContext') alongside the two
    // v0.4 keys — chrome.storage.local.get(array) happily returns
    // whichever of the requested keys actually exist, so a v0.4 install
    // that's never written this key simply gets it back as `undefined`,
    // which the `typeof ... === 'boolean'` check below treats as "not
    // set yet" rather than as `false`. That distinction matters here
    // because this feature's real default is ON (see SPEC-v0.5.md
    // FR-2.3) — if we didn't check the type first, `undefined` would be
    // falsy and the checkbox would render OFF on first run.
    const { apiKey, promptStyle, pbUseThreadContext } = await chrome.storage.local.get([
      'apiKey',
      'promptStyle',
      'pbUseThreadContext',
    ]);
    if (apiKey) apiKeyInput.value = apiKey;
    if (promptStyle) styleSelect.value = promptStyle;
    useContextCheckbox.checked = typeof pbUseThreadContext === 'boolean' ? pbUseThreadContext : true;
  } catch (err) {
    showStatus('Could not load settings.', 'error');
  }
});


// ── TOGGLE API KEY VISIBILITY ───────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  // `condition ? valueIfTrue : valueIfFalse` is the "ternary operator" —
  // a compact if/else that produces a VALUE instead of running a block of
  // statements. All three lines below read the CURRENT state once
  // (`isHidden`, captured before anything changes) and use it to decide
  // the new type/icon/title together, rather than three separate
  // if/else blocks that could each independently make a mistake.
  const isHidden = apiKeyInput.type === 'password';
  apiKeyInput.type = isHidden ? 'text' : 'password';
  toggleBtn.textContent = isHidden ? '🙈' : '👁';
  toggleBtn.title = isHidden ? 'Hide key' : 'Show key';
});


// ── SAVE SETTINGS ───────────────────────────────────────────────────────
// Marking this handler `async` (note: this one CAN safely be async, unlike
// the message listener in service-worker.js — DOM event handlers aren't
// checked for a special synchronous return value the way Chrome's
// messaging callbacks are) lets us `await` the storage write below and
// only flip the button back to normal once it's actually finished.
saveBtn.addEventListener('click', async () => {
  const apiKey     = apiKeyInput.value.trim();
  const promptStyle = styleSelect.value;

  if (!apiKey) {
    showStatus('Please enter an API key.', 'error');
    apiKeyInput.focus();
    return;
  }

  // Disable button while saving to prevent double-clicks
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    await chrome.storage.local.set({ apiKey, promptStyle });
    showStatus('✓ Settings saved!', 'success');
  } catch (err) {
    showStatus('Failed to save. Please try again.', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  }
});


// ── v0.5 — FEATURE 2: THREAD-CONTEXT TOGGLE ─────────────────────────────
// This writes immediately on change, unlike the API key / default mode
// fields above (which wait for the explicit "Save Settings" click) —
// it's a plain on/off switch, so there's no intermediate "unsaved" state
// worth asking the user to confirm, and it matches how the identical
// on-page toggle in content.js's mode menu already behaves (flip it,
// it's saved).
useContextCheckbox.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ pbUseThreadContext: useContextCheckbox.checked });
  } catch {
    showStatus('Could not save that setting.', 'error');
  }
});


// ── v0.5 — FEATURE 1: FAVORITES BACKUP ──────────────────────────────────
// Both handlers call straight into favorites.js's shared API (loaded via
// the <script src="../favorites.js"> tag in popup.html) — the exact same
// functions the on-page favorites panel uses, so there is only ever ONE
// implementation of "what does export/import actually do."
exportFavoritesBtn.addEventListener('click', async () => {
  try {
    const json = await pbFavoritesExport();
    // Building a real file download from a popup page uses the same
    // Blob + temporary <a download> trick any web page would use — there
    // is nothing extension-specific about it.
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `promptbench-favorites-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('✓ Favorites exported!', 'success');
  } catch (err) {
    showStatus('Could not export favorites.', 'error');
  }
});

// Clicking the visible "Import Favorites" button just forwards to the
// hidden native file picker — this is the standard way to get a styled
// button in place of the browser's own (unstylable) <input type=file>.
importFavoritesBtn.addEventListener('click', () => importFileInput.click());

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const count = await pbFavoritesImport(text); // throws with a specific message on malformed input — see favorites.js
    showStatus(`✓ Imported ${count} favorite${count === 1 ? '' : 's'}!`, 'success');
  } catch (err) {
    showStatus(err.message || 'Could not import that file.', 'error');
  } finally {
    importFileInput.value = ''; // allow re-selecting the same file later
  }
});


// ── STATUS MESSAGE HELPER ───────────────────────────────────────────────
function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `pb-status pb-status-${type}`;

  // Auto-clear after 3 seconds
  setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = 'pb-status';
  }, 3000);
}
