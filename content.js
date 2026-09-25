/*
  content.js — Shared core. Runs on every supported chat site.

  This file owns mode state, the on-page UI (split button + dropdown
  menu), event handling, and the injection loop. It has NO knowledge of
  any specific site — that knowledge lives entirely in platforms/*.js,
  each of which registers an adapter into the PB_PLATFORMS registry
  (declared in inject-utils.js, loaded before the adapters, which load
  before this file — see manifest.json).

  Shared building blocks this file uses:
    - PB_MODES / pbGetMode, and the v0.5 additions PB_IMAGE_TASKS /
      PB_IMAGE_TARGETS / pbGetImageTask / pbGetImageTarget /
      PB_IMAGE_MODE_VALUE / PB_CONTEXT_MAX_TURNS   (modes.js)
    - PB_PLATFORMS                      (inject-utils.js, filled in by
                                          platforms/chatgpt.js, claude.js,
                                          gemini.js)
    - pbFindSafeAnchor / pbGetElementText / pbSetElementText / pbDebounceToFrame
                                         (inject-utils.js)
    - pbCreateDropdown                  (dropdown.js)
    - pbFavorites* functions            (favorites.js — Feature 1, v0.5)

  SECURITY NOTE:
    This file runs in the host page's context. It NEVER reads the API key.
    All API calls are routed through the service worker via message passing.
    Python analogy: this is the "frontend" that calls your backend API.

  v0.5 CHANGES AT A GLANCE (see SPEC-v0.5.md for the full design):
    - Feature 1: a star icon opens an inline "save as favorite" panel;
      a second icon opens a searchable favorites list.
    - Feature 2: handleImproveClick now attaches recent conversation
      history to the request, unless the user has turned that off.
    - Feature 3: an "Image" tab in the mode popover, with task and target
      platform controls, switches the request into image-prompt mode
      instead of text-prompt mode.
  Nothing about the v0.4 flow (plain text-mode Improve, no history, no
  favorites) changed shape — every new code path is additive.

  v0.5.1 UI PASS — everything used to live in one flat, ever-growing
  dropdown (mode list + a divider + image chips + another divider + a
  context-toggle row), with two more icon buttons crammed into a second
  row underneath the main button. That's gone: the toolbar is now ONE
  horizontal row (split button, then a small divider, then three compact
  icon buttons), and the popover the chevron opens is organized into TABS
  ("Text" / "Image") instead of one long scrolling list — closer to how a
  component library like shadcn/ui structures a Tabs + Popover + ToggleGroup
  combination, just hand-built in plain DOM/CSS since a content script
  can't safely pull in someone else's React+Tailwind bundle onto an
  arbitrary host page. See buildToolbarIcons/buildModePopover below and
  the "── UI STRUCTURE, v0.5.1 ──" section of content.css.
*/

const MARKER_CLASS = 'pb-injected';
const STORAGE_KEY = 'promptStyle';
const IMAGE_PREFS_KEY = 'pbImagePrefs';
const CONTEXT_TOGGLE_KEY = 'pbUseThreadContext';

function getPlatform() {
  const host = window.location.hostname;
  // Object.keys(PB_PLATFORMS) turns { 'chatgpt.com': {...}, 'claude.ai': {...}, ... }
  // into a plain array of just its keys: ['chatgpt.com', 'claude.ai', 'gemini.google.com'].
  // .find(...) then walks that array and returns the FIRST one where the
  // arrow function returns true — here, "this key equals our hostname, or
  // our hostname ends with '.' + this key" (the second check is what lets
  // this still match a subdomain, e.g. 'www.claude.ai' or 'chat.openai.com'
  // style variants, without hardcoding every possible subdomain).
  // If nothing matches, .find() returns `undefined`.
  const key = Object.keys(PB_PLATFORMS).find((h) => host === h || host.endsWith(`.${h}`));
  if (!key) return null;
  const platform = PB_PLATFORMS[key];
  // v0.5: favorites store `sourcePlatform` as this registry key (e.g.
  // 'chatgpt.com') so a saved favorite can show a human-readable "saved
  // from ChatGPT" hint later — stashing it on the object here means every
  // other call site can just read `platform.key` instead of re-deriving it.
  platform.key = key;
  return platform;
}

function findInputElement(platform) {
  for (const selector of platform.inputSelectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}


// ── MODE / PREFERENCE STATE ─────────────────────────────────────────────
let currentMode = PB_MODES[0]; // default to the first mode ("Clearer") until storage says otherwise
let currentImageTask = PB_IMAGE_TASKS[0];     // v0.5 — Feature 3
let currentImageTarget = PB_IMAGE_TARGETS[3]; // v0.5 — Feature 3 ("generic" is last in the list)
let useThreadContext = true;                  // v0.5 — Feature 2, default ON per SPEC-v0.5.md FR-2.3

// chrome.storage.local.get(key) is ASYNCHRONOUS — it can't answer
// instantly because (at least in principle) it might have to read from
// disk. Instead of freezing the page to wait, it returns a Promise: an
// object representing "a value that will show up later." `.then(callback)`
// registers a function to run once that value is ready; everything below
// this statement keeps running immediately, without waiting.
//
// v0.5 reads three keys at once instead of one — `chrome.storage.local
// .get([...])` accepts an array just as happily as a single string, and
// the destructured callback parameter pulls out whichever of the three
// were actually present (a fresh v0.4→v0.5 upgrade will have the first
// key but not the other two, which is fine — each falls back to the
// sensible default already assigned above).
chrome.storage.local.get([STORAGE_KEY, IMAGE_PREFS_KEY, CONTEXT_TOGGLE_KEY]).then((result) => {
  if (result[STORAGE_KEY] === PB_IMAGE_MODE_VALUE) {
    // pbGetMode('image') would silently fall back to PB_MODES[0] — see
    // modes.js's comment on PB_IMAGE_PSEUDO_MODE — so a stored 'image'
    // value needs this explicit branch instead of the generic lookup
    // below, the same way setImagePrefs() and the mode-menu click handler
    // both do.
    currentMode = PB_IMAGE_PSEUDO_MODE;
  } else if (result[STORAGE_KEY]) {
    currentMode = pbGetMode(result[STORAGE_KEY]);
  }
  if (result[IMAGE_PREFS_KEY]) {
    currentImageTask = pbGetImageTask(result[IMAGE_PREFS_KEY].task);
    currentImageTarget = pbGetImageTarget(result[IMAGE_PREFS_KEY].target);
  }
  if (typeof result[CONTEXT_TOGGLE_KEY] === 'boolean') {
    useThreadContext = result[CONTEXT_TOGGLE_KEY];
  }
  refreshModeUI();
});

function setCurrentMode(mode) {
  currentMode = mode;
  chrome.storage.local.set({ [STORAGE_KEY]: mode.value });
  refreshModeUI();
}

// v0.5 — Feature 3. Persists both halves of the image-mode selection
// together under one key, matching FR-3.6 ("remembered per-device as the
// new default"). Switching the task/target also switches the ACTIVE mode
// to 'image' (mirroring how picking any other mode-menu item both selects
// that mode and is the trigger for the next Improve click).
function setImagePrefs({ task, target }) {
  if (task) currentImageTask = task;
  if (target) currentImageTarget = target;
  currentMode = PB_IMAGE_PSEUDO_MODE; // NOT pbGetMode(PB_IMAGE_MODE_VALUE) — see modes.js's comment on PB_IMAGE_PSEUDO_MODE for why that lookup wouldn't work.
  chrome.storage.local.set({
    [IMAGE_PREFS_KEY]: { task: currentImageTask.value, target: currentImageTarget.value },
  });
  refreshModeUI();
}

// v0.5 — Feature 2. A simple persistent on/off toggle (SPEC-v0.5.md §3.5
// covers a per-click override too; this implementation keeps the on-page
// control to the one global switch — also exposed in the popup settings —
// since that already satisfies FR-2.3's "visible and controllable"
// requirement without a second, harder-to-discover interaction mode).
function setUseThreadContext(value) {
  useThreadContext = value;
  chrome.storage.local.set({ [CONTEXT_TOGGLE_KEY]: value });
  refreshModeUI();
}

// Only touches the CURRENTLY ACTIVE instance (tracked below), never a
// global class/id lookup — so a stale, not-yet-cleaned-up instance from a
// previous render can never get updated by mistake.
function refreshModeUI() {
  if (!activeWrapper) return;

  const isImageMode = currentMode.value === PB_IMAGE_MODE_VALUE;
  const icon = activeWrapper.querySelector('.pb-btn-icon');
  const label = activeWrapper.querySelector('.pb-btn-text');
  // v0.5: the button reflects whichever "mode" is actually active, text
  // or image — reusing the exact same two child elements v0.4 already had,
  // so nothing about the button's own markup or CSS needed to change.
  if (icon) icon.textContent = isImageMode ? '🎨' : currentMode.icon;
  if (label) label.textContent = isImageMode ? 'Image' : currentMode.label;

  // `activeMenu?.querySelectorAll(...)` uses OPTIONAL CHAINING (`?.`): if
  // activeMenu is null or undefined, the whole expression short-circuits
  // to undefined instead of throwing "cannot read property of null" — a
  // one-character-shorter way of writing
  // `activeMenu && activeMenu.querySelectorAll(...)`.
  activeMenu?.querySelectorAll('.pb-mode-item').forEach((item) => {
    item.classList.toggle('pb-mode-active', item.dataset.value === currentMode.value);
  });

  // v0.5 — Feature 3: highlight whichever image task/target chip is
  // currently selected, same toggle() pattern as the mode list above.
  activeMenu?.querySelectorAll('.pb-image-task-item').forEach((item) => {
    item.classList.toggle('pb-mode-active', item.dataset.value === currentImageTask.value);
  });
  activeMenu?.querySelectorAll('.pb-image-target-item').forEach((item) => {
    item.classList.toggle('pb-mode-active', item.dataset.value === currentImageTarget.value);
  });

  // v0.5.1 — Feature 2: the context toggle now lives as its own icon
  // button directly in the toolbar (see buildToolbarIcons), not buried
  // inside the mode popover, so it's queried off `activeWrapper` here,
  // not `activeMenu` like the mode-list items above. `aria-pressed`
  // doubles as both the accessibility state AND the CSS hook for its
  // "on" look (`.pb-icon-btn[aria-pressed="true"]` in content.css) — one
  // attribute, no separate class to keep in sync.
  const contextToggleBtn = activeWrapper.querySelector('.pb-context-toggle-btn');
  if (contextToggleBtn) {
    contextToggleBtn.setAttribute('aria-pressed', String(useThreadContext));
    contextToggleBtn.title = useThreadContext
      ? 'Conversation context: ON — recent messages are sent along with your prompt. Click to turn off.'
      : 'Conversation context: OFF — click to include recent messages when improving prompts.';
  }
}


// ── CONTROLS CREATION ───────────────────────────────────────────────────
// v0.5.1: ONE floating toolbar row, left to right:
//   [ ✨ Improve | mode ▾ ]  │  [ 🧵 ]  [ ☆ ]  [ 📚 ]
//   ^ the split button        ^ a thin visual divider, then three small,
//     (unchanged from v0.4)     equally-weighted icon buttons: context
//                               toggle, save-to-favorites, browse-favorites.
// Every earlier version stacked the favorites icons in a SECOND row below
// the split button, and stuffed the context toggle inside the mode
// dropdown alongside the image controls — both were reported as feeling
// bolted-on rather than integrated. Putting all of it in one row, grouped
// by a divider the way a toolbar groups related actions, fixes both: the
// favorites icons read as part of the same control cluster instead of an
// afterthought underneath it, and the context toggle is now a single
// always-visible click instead of something buried three levels deep in
// a menu.
//
// e.stopPropagation() on every one of our own click handlers keeps event
// handling isolated to our UI: it stops the click from ever reaching the
// host page's own document-level listeners (avoiding interference with
// whatever click-outside/keyboard logic Claude/Gemini/ChatGPT run), and it
// also prevents our own dropdown's outside-click listener from immediately
// closing a menu we just opened.
function createControls(platform) {
  const wrapper = document.createElement('div');
  wrapper.id = 'pb-controls';
  wrapper.style.setProperty('--pb-accent', platform.accent);

  const toolbar = document.createElement('div');
  toolbar.className = 'pb-toolbar';

  // ── Split button: Improve + mode chevron (unchanged from v0.4) ──
  const split = document.createElement('div');
  split.className = 'pb-split';

  const btn = document.createElement('button');
  btn.id = 'pb-improve-btn';
  btn.type = 'button';
  btn.title = `Improve with ${platform.name}`;
  btn.innerHTML =
    `<span class="pb-btn-icon">${currentMode.icon}</span>` +
    `<span class="pb-btn-text">${currentMode.label}</span>`;

  const toggle = document.createElement('button');
  toggle.id = 'pb-mode-toggle';
  toggle.type = 'button';
  toggle.title = 'Choose a different mode';
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.innerHTML = '<span class="pb-chevron">▾</span>';

  const menu = buildModePopover();
  const dropdown = pbCreateDropdown(toggle, menu);

  // Notice this arrow function refers to `platform` and `btn` even though
  // neither is one of ITS OWN parameters (only `e`, the click event, is).
  // This is another closure: `platform` and `btn` are parameters/variables
  // of createControls(), and this inner function — created while
  // createControls() is still running — keeps access to them for as long
  // as the button exists on the page, however long after createControls()
  // itself returns.
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.close();
    handleImproveClick(platform, btn);
  });

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    // Open on whichever tab reflects the CURRENTLY active mode, so the
    // popover always agrees with what the split button is about to do
    // rather than always resetting to "Text" — a small touch, but it's
    // what makes a returning-to-image-mode user land somewhere sensible.
    if (!dropdown.isOpen()) {
      setActivePopoverTab(menu, currentMode.value === PB_IMAGE_MODE_VALUE ? 'image' : 'text');
    }
    dropdown.toggle();
  });

  wireModePopoverEvents(menu, platform, btn, dropdown);

  split.appendChild(btn);
  split.appendChild(toggle);
  toolbar.appendChild(split);

  // ── Divider, then the three toolbar icon buttons ──
  const divider = document.createElement('div');
  divider.className = 'pb-toolbar-divider';
  toolbar.appendChild(divider);

  const icons = buildToolbarIcons();
  toolbar.appendChild(icons.el);
  wrapper.appendChild(toolbar);

  // Context toggle: a plain, immediate on/off click — no popover, no
  // confirmation, just a pressed/unpressed icon button. refreshModeUI()
  // (called after every state change) is what keeps its look in sync.
  icons.contextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setUseThreadContext(!useThreadContext);
  });

  // ── Favorites: save + browse, each its own dedicated small popover ──
  const favSaveMenu = buildFavoriteSaveMenu();
  const favSaveDropdown = pbCreateDropdown(icons.favSaveBtn, favSaveMenu);
  const favBrowseMenu = buildFavoriteBrowseMenu();
  const favBrowseDropdown = pbCreateDropdown(icons.favBrowseBtn, favBrowseMenu);

  icons.favSaveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.close();
    favBrowseDropdown.close();
    openFavoriteSavePanel(platform, favSaveMenu, favSaveDropdown);
  });

  icons.favBrowseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.close();
    favSaveDropdown.close();
    openFavoriteBrowsePanel(platform, favBrowseMenu, favBrowseDropdown);
  });

  return { wrapper, menu, dropdown, favSaveDropdown, favBrowseDropdown };
}

// The three small icon buttons that sit to the right of the toolbar
// divider. Kept as its own function purely so createControls (above)
// reads as "assemble the pieces" rather than a long flat list of
// createElement calls for buttons that don't relate to the split button
// at all.
function buildToolbarIcons() {
  const el = document.createElement('div');
  el.className = 'pb-toolbar-icons';

  const contextBtn = document.createElement('button');
  contextBtn.type = 'button';
  contextBtn.className = 'pb-icon-btn pb-context-toggle-btn';
  contextBtn.setAttribute('aria-pressed', 'false'); // refreshModeUI() sets the real value once the instance is live
  contextBtn.innerHTML = '<span aria-hidden="true">🧵</span>';

  const favSaveBtn = document.createElement('button');
  favSaveBtn.type = 'button';
  favSaveBtn.className = 'pb-icon-btn';
  favSaveBtn.title = 'Save current prompt as a favorite';
  favSaveBtn.innerHTML = '<span aria-hidden="true">☆</span>';

  const favBrowseBtn = document.createElement('button');
  favBrowseBtn.type = 'button';
  favBrowseBtn.className = 'pb-icon-btn';
  favBrowseBtn.title = 'Browse saved favorites';
  favBrowseBtn.innerHTML = '<span aria-hidden="true">📚</span>';

  el.appendChild(contextBtn);
  el.appendChild(favSaveBtn);
  el.appendChild(favBrowseBtn);

  return { el, contextBtn, favSaveBtn, favBrowseBtn };
}

// Builds the #pb-mode-menu popover: a small shadcn-Tabs-style pill switch
// ("Text" / "Image") over two panels. This replaces v0.5's single flat
// list-plus-dividers-plus-chip-rows layout — everything text-mode-related
// lives in one panel, everything image-mode-related lives in the other,
// and only the active panel is ever visible (`[hidden]`), so the popover
// never shows the user two unrelated controls at once. The thread-context
// toggle that USED to live here moved out entirely — see
// buildToolbarIcons — since it applies globally rather than to "the Text
// tab" specifically, and deserved to be a single always-visible click
// rather than something to go find inside a tab.
function buildModePopover() {
  const menu = document.createElement('div');
  menu.id = 'pb-mode-menu';
  menu.className = 'pb-popover';

  // ── Tab bar ──
  const tabs = document.createElement('div');
  tabs.className = 'pb-tabs';
  tabs.setAttribute('role', 'tablist');

  const textTab = document.createElement('button');
  textTab.type = 'button';
  textTab.className = 'pb-tab';
  textTab.dataset.tab = 'text';
  textTab.setAttribute('role', 'tab');
  textTab.textContent = 'Text';

  const imageTab = document.createElement('button');
  imageTab.type = 'button';
  imageTab.className = 'pb-tab';
  imageTab.dataset.tab = 'image';
  imageTab.setAttribute('role', 'tab');
  imageTab.textContent = 'Image';

  tabs.appendChild(textTab);
  tabs.appendChild(imageTab);
  menu.appendChild(tabs);

  // ── "Text" panel: the original per-mode list, unchanged ──
  const textPanel = document.createElement('div');
  textPanel.className = 'pb-tab-panel';
  textPanel.dataset.panel = 'text';
  textPanel.setAttribute('role', 'tabpanel');

  for (const mode of PB_MODES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pb-mode-item';
    item.setAttribute('role', 'menuitem');
    // `.dataset.value = ...` writes an HTML "data-*" attribute — this
    // line actually sets `data-value="coding"` (etc.) on the button. Any
    // property name you use on `.dataset` maps to `data-<that-name>` in
    // the HTML, and back again: reading `item.dataset.value` later (as
    // refreshModeUI and the click handler below both do) gives you that
    // same string back. It's a built-in, framework-free way to stash a
    // small piece of data directly on a DOM element.
    item.dataset.value = mode.value;
    item.title = mode.hint;
    item.innerHTML =
      `<span class="pb-mode-icon">${mode.icon}</span>` +
      `<span class="pb-mode-text"><strong>${mode.label}</strong><small>${mode.hint}</small></span>`;
    textPanel.appendChild(item);
  }
  menu.appendChild(textPanel);

  // ── "Image" panel: task segmented control + target segmented control ──
  const imagePanel = document.createElement('div');
  imagePanel.className = 'pb-tab-panel';
  imagePanel.dataset.panel = 'image';
  imagePanel.setAttribute('role', 'tabpanel');
  imagePanel.hidden = true; // Text is the default tab — see setActivePopoverTab

  const taskLabel = document.createElement('div');
  taskLabel.className = 'pb-field-label';
  taskLabel.textContent = 'Task';
  imagePanel.appendChild(taskLabel);

  // Task chips (New Generation / Targeted Edit) — see SPEC-v0.5.md §4.2.
  // `.pb-segmented` renders these as a connected, equal-width ToggleGroup
  // rather than a vertical list — there are only two mutually exclusive
  // options, which is exactly what a segmented control communicates at a
  // glance that a stacked list of "menu items" doesn't.
  const taskRow = document.createElement('div');
  taskRow.className = 'pb-segmented';
  taskRow.setAttribute('role', 'tablist');
  for (const task of PB_IMAGE_TASKS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pb-segmented-item pb-image-task-item';
    chip.dataset.value = task.value;
    chip.title = task.hint;
    chip.innerHTML = `<span aria-hidden="true">${task.icon}</span> ${task.label}`;
    taskRow.appendChild(chip);
  }
  imagePanel.appendChild(taskRow);

  const targetLabel = document.createElement('div');
  targetLabel.className = 'pb-field-label';
  targetLabel.textContent = 'Target Platform';
  imagePanel.appendChild(targetLabel);

  // Target-platform chips (Midjourney / DALL·E / Stable Diffusion / Generic)
  // — four options, so this wraps onto two rows of two rather than
  // forcing four cramped columns into the same width as the two-item
  // task row above.
  const targetRow = document.createElement('div');
  targetRow.className = 'pb-segmented pb-segmented-wrap';
  targetRow.setAttribute('role', 'tablist');
  for (const target of PB_IMAGE_TARGETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pb-segmented-item pb-image-target-item';
    chip.dataset.value = target.value;
    chip.textContent = target.label;
    targetRow.appendChild(chip);
  }
  imagePanel.appendChild(targetRow);

  menu.appendChild(imagePanel);

  return menu;
}

// Shows the requested tab's panel and hides the other, and updates the
// tab buttons' own selected look/aria-state. Exported as its own function
// (rather than inlined in the click handler below) because createControls
// also calls it — right before OPENING the popover — so it lands on
// whichever tab matches the mode that's actually active.
function setActivePopoverTab(menu, tabName) {
  menu.querySelectorAll('.pb-tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === tabName));
  });
  menu.querySelectorAll('.pb-tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tabName;
  });
}

// Wires up click handling for everything buildModePopover() created.
// Split out from createControls so both stay readable — this function
// ONLY deals with "what happens when something in the popover is
// clicked," not with how the popover was built.
function wireModePopoverEvents(menu, platform, btn, dropdown) {
  for (const tab of menu.querySelectorAll('.pb-tab')) {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      setActivePopoverTab(menu, tab.dataset.tab);
      // Switching tabs changes the popover's rendered height (the Image
      // panel is a different height than the Text panel), so its
      // position/max-height need recomputing on the spot — otherwise it
      // would keep whatever size/placement was measured when it first
      // opened, which can leave empty space or, worse, clip the newly
      // shown panel near a viewport edge.
      dropdown.reposition();
    });
  }

  for (const item of menu.querySelectorAll('.pb-mode-item')) {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      setCurrentMode(pbGetMode(item.dataset.value));
      dropdown.close();
      handleImproveClick(platform, btn);
    });
  }

  for (const chip of menu.querySelectorAll('.pb-image-task-item')) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      setImagePrefs({ task: pbGetImageTask(chip.dataset.value) });
      dropdown.close();
      handleImproveClick(platform, btn);
    });
  }

  for (const chip of menu.querySelectorAll('.pb-image-target-item')) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      setImagePrefs({ target: pbGetImageTarget(chip.dataset.value) });
      dropdown.close();
      handleImproveClick(platform, btn);
    });
  }
}


// ── CLICK HANDLER ───────────────────────────────────────────────────────
// This is the heart of the whole extension — a full trace of what happens
// when a click reaches here (see ARCHITECTURE.md for the file-level map):
//   1. Grab whatever text is currently in the chat site's input box.
//   2. Bail out early (with a warning toast) if it's empty.
//   3. Show a loading state on the button.
//   4. v0.5: gather thread history (Feature 2) unless in image mode or the
//      user turned it off, and gather image task/target (Feature 3) when
//      relevant — see SPEC-v0.5.md §5 for why these two are mutually
//      exclusive on a single request.
//   5. Send a message to service-worker.js and WAIT for its reply — this
//      is the only moment this file ever talks to anything outside the
//      page; service-worker.js is the only file that touches the network
//      or the API key.
//   6. On success, write the improved text back into the input box; on
//      failure, show why. Either way, restore the button afterward.
//
// It's declared `async` so we can use `await` inside it (see step 5) —
// that's what lets this function "pause" at the network call without
// freezing the rest of the page while it waits.
async function handleImproveClick(platform, btn) {
  // Re-query the input at click time rather than closing over a reference
  // captured at injection time — React/Angular can swap the actual editor
  // node out from under us between injection and click.
  const input = findInputElement(platform);
  if (!input) return;

  const originalText = pbGetElementText(input).trim();
  if (!originalText) {
    showToast('Type a prompt first, then click Improve.', 'warning');
    return;
  }

  const btnText = btn.querySelector('.pb-btn-text');
  const isImageMode = currentMode.value === PB_IMAGE_MODE_VALUE;

  // v0.5 — Feature 2: only collect history for TEXT modes (SPEC-v0.5.md
  // §5 keeps thread context and image mode independent), only when the
  // user hasn't turned it off, and only when this platform's adapter
  // actually implements extraction (every adapter does as of v0.5, but
  // checking keeps this call site safe if that ever isn't true).
  const history = (!isImageMode && useThreadContext && typeof platform.extractThreadHistory === 'function')
    ? platform.extractThreadHistory(PB_CONTEXT_MAX_TURNS)
    : [];

  // ── Loading state ──
  btn.disabled = true;
  btn.classList.add('pb-loading');
  btnText.textContent = 'Improving…';

  try {
    // chrome.runtime.sendMessage(...) is how one part of an extension
    // talks to another. Here, this content script (running inside the
    // chat page) sends a plain JS object to whatever is listening in
    // service-worker.js, and `await` pauses this function until that
    // listener calls `sendResponse(...)` over there (see the
    // `chrome.runtime.onMessage.addListener` block in service-worker.js —
    // that's the other end of this exact call). The API key itself never
    // travels in either direction; only the prompt text (plus, as of
    // v0.5, optional history/image-mode fields) go out, and the improved
    // text (or an error message) comes back.
    const response = await chrome.runtime.sendMessage({
      type: 'IMPROVE_PROMPT',
      text: originalText,
      style: currentMode.value,
      history,
      imageTask: currentImageTask.value,
      imageTarget: currentImageTarget.value,
    });

    if (response && response.success) {
      pbSetElementText(input, response.improved);
      const label = isImageMode ? `Image · ${currentImageTask.label}` : currentMode.label;
      showToast(`Prompt improved (${label})!`, 'success');
    } else {
      // `response?.error` again uses optional chaining: if `response`
      // itself is null/undefined for some reason, this reads as
      // undefined instead of throwing, and `|| 'Something went wrong.'`
      // then supplies a fallback message for that case (or for a
      // response that came back without an `error` field).
      showToast(response?.error || 'Something went wrong.', 'error');
    }
  } catch (err) {
    // sendMessage's Promise only REJECTS (lands here, in `catch`) for
    // genuine communication failures — e.g. the service worker isn't
    // running and Chrome couldn't wake it up, or the page was reloaded
    // mid-request. An error reported BY the service worker (bad API key,
    // Gemini rate limit, etc.) is a normal successful reply with
    // `success: false` — that's handled in the `else` branch above, not here.
    showToast('Could not reach PromptBench. Try reloading the page.', 'error');
  } finally {
    // `finally` runs no matter what happened above — success, the `else`
    // branch, or the `catch` block — which makes it the right place to
    // reset the button so it never gets stuck saying "Improving…" forever.
    btn.disabled = false;
    btn.classList.remove('pb-loading');
    btnText.textContent = isImageMode ? 'Image' : currentMode.label;
  }
}


/* ════════════════════════════════════════════════════════════════════════
   v0.5 — FEATURE 1: FAVORITE PROMPTS (save panel + browse panel)
   See SPEC-v0.5.md §2 for the full design. Both panels are built once per
   injected instance (createControls, above) and their CONTENTS are
   re-rendered each time they're opened — same "portal stays in the DOM,
   only its open/closed state and position change" idea dropdown.js
   already uses for the mode menu.
   ════════════════════════════════════════════════════════════════════════ */

function buildFavoriteSaveMenu() {
  const menu = document.createElement('div');
  menu.className = 'pb-fav-panel pb-fav-save-panel';
  menu.innerHTML = `
    <label class="pb-field-label">Title</label>
    <div class="pb-fav-title-row">
      <input type="text" class="pb-fav-title-input" placeholder="Untitled prompt" maxlength="80">
      <button type="button" class="pb-fav-suggest-btn" title="Suggest a title with Gemini">✨</button>
    </div>
    <label class="pb-field-label">Category</label>
    <input type="text" class="pb-fav-category-input" placeholder="e.g. Coding, Emails, Research" list="pb-fav-category-list">
    <datalist id="pb-fav-category-list" class="pb-fav-category-list"></datalist>
    <label class="pb-field-label">Tags (comma separated)</label>
    <input type="text" class="pb-fav-tags-input" placeholder="e.g. followup, urgent">
    <div class="pb-fav-actions">
      <button type="button" class="pb-fav-cancel-btn">Cancel</button>
      <button type="button" class="pb-fav-save-btn">Save Favorite</button>
    </div>
  `;
  return menu;
}

// Re-populates and opens the save panel for the CURRENT input box
// contents. Rebuilding the default title/category list on every open
// (rather than once at injection time) means it always reflects whatever
// is actually in the box right now, and whatever categories exist right
// now — both can change between two clicks of the star button.
async function openFavoriteSavePanel(platform, menu, dropdown) {
  const input = findInputElement(platform);
  const text = input ? pbGetElementText(input).trim() : '';

  if (!text) {
    showToast('Nothing to save — type a prompt first.', 'warning');
    return;
  }

  const titleInput = menu.querySelector('.pb-fav-title-input');
  const categoryInput = menu.querySelector('.pb-fav-category-input');
  const categoryList = menu.querySelector('.pb-fav-category-list');
  const tagsInput = menu.querySelector('.pb-fav-tags-input');
  const suggestBtn = menu.querySelector('.pb-fav-suggest-btn');
  const saveBtn = menu.querySelector('.pb-fav-save-btn');
  const cancelBtn = menu.querySelector('.pb-fav-cancel-btn');

  // Default title: first line of the prompt, trimmed to a sane length —
  // just a starting point, fully editable before saving.
  titleInput.value = text.split('\n')[0].slice(0, 80);
  categoryInput.value = '';
  tagsInput.value = '';

  const categories = await pbFavoritesGetCategories();
  categoryList.innerHTML = categories.map((c) => `<option value="${c.replace(/"/g, '&quot;')}"></option>`).join('');

  dropdown.open();

  // `onclick =` (rather than addEventListener) is used for these three
  // buttons specifically because this function re-runs on every open —
  // assigning `.onclick` simply REPLACES the previous handler, whereas
  // addEventListener would silently stack a new listener on top of the
  // last one every time the panel is opened again, eventually saving the
  // same favorite N times per click.
  suggestBtn.onclick = async (e) => {
    e.stopPropagation();
    suggestBtn.disabled = true;
    suggestBtn.textContent = '…';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SUGGEST_TITLE', text });
      if (response && response.success && response.title) {
        titleInput.value = response.title;
      } else {
        showToast(response?.error || 'Could not suggest a title.', 'error');
      }
    } catch {
      showToast('Could not reach PromptBench. Try reloading the page.', 'error');
    } finally {
      suggestBtn.disabled = false;
      suggestBtn.textContent = '✨';
    }
  };

  cancelBtn.onclick = (e) => {
    e.stopPropagation();
    dropdown.close();
  };

  saveBtn.onclick = async (e) => {
    e.stopPropagation();
    const sourceMode = currentMode.value === PB_IMAGE_MODE_VALUE
      ? `${PB_IMAGE_MODE_VALUE}:${currentImageTask.value}:${currentImageTarget.value}`
      : currentMode.value;

    await pbFavoritesSave({
      title: titleInput.value,
      body: text,
      category: categoryInput.value,
      tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
      sourceMode,
      sourcePlatform: platform.key,
    });

    dropdown.close();
    showToast('Saved to Favorites.', 'success');
  };

  // Clicks inside form fields shouldn't bubble to document and trigger
  // the dropdown's own outside-click handler.
  menu.onclick = (e) => e.stopPropagation();
}

function buildFavoriteBrowseMenu() {
  const menu = document.createElement('div');
  menu.className = 'pb-fav-panel pb-fav-browse-panel';
  menu.innerHTML = `
    <input type="text" class="pb-fav-search-input" placeholder="Search favorites…">
    <div class="pb-fav-category-chips"></div>
    <div class="pb-fav-list"></div>
  `;
  return menu;
}

// Renders the favorites LIST portion only (search box + category chips
// stay put) — called on open and again every time the search text or
// selected category changes, via pbFavoritesSearch (favorites.js).
async function renderFavoriteList(menu, platform, dropdown, activeCategory) {
  const listEl = menu.querySelector('.pb-fav-list');
  const query = menu.querySelector('.pb-fav-search-input').value;
  const results = await pbFavoritesSearch({ query, category: activeCategory, sortBy: 'recent' });

  if (results.length === 0) {
    listEl.innerHTML = '<p class="pb-fav-empty">No favorites yet — save one with the ☆ button.</p>';
    return;
  }

  listEl.innerHTML = '';
  for (const fav of results) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pb-fav-row-item';
    const preview = fav.body.length > 90 ? `${fav.body.slice(0, 90)}…` : fav.body;
    row.innerHTML = `
      <div class="pb-fav-row-main">
        <strong>${fav.title}</strong>
        <small>${preview}</small>
      </div>
      <div class="pb-fav-row-meta">
        ${fav.category ? `<span class="pb-fav-badge">${fav.category}</span>` : ''}
        <span class="pb-fav-delete-btn" title="Delete this favorite">🗑</span>
      </div>
    `;

    row.querySelector('.pb-fav-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await pbFavoritesDelete(fav.id);
      showToast('Favorite deleted.', 'info');
      renderFavoriteList(menu, platform, dropdown, activeCategory);
    });

    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const input = findInputElement(platform);
      if (!input) {
        showToast('Couldn\'t find a place to insert this.', 'error');
        return;
      }
      pbSetElementText(input, fav.body);
      await pbFavoritesRecordUse(fav.id);
      dropdown.close();
      showToast('Favorite inserted.', 'success');
    });

    listEl.appendChild(row);
  }
}

async function openFavoriteBrowsePanel(platform, menu, dropdown) {
  let activeCategory; // undefined = "All"

  const searchInput = menu.querySelector('.pb-fav-search-input');
  const chipsEl = menu.querySelector('.pb-fav-category-chips');

  const categories = await pbFavoritesGetCategories();
  chipsEl.innerHTML = '';
  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'pb-fav-chip pb-fav-chip-active';
  allChip.textContent = 'All';
  chipsEl.appendChild(allChip);

  const uncategorizedChip = document.createElement('button');
  uncategorizedChip.type = 'button';
  uncategorizedChip.className = 'pb-fav-chip';
  uncategorizedChip.textContent = 'Uncategorized';
  chipsEl.appendChild(uncategorizedChip);

  for (const category of categories) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pb-fav-chip';
    chip.textContent = category;
    chipsEl.appendChild(chip);
  }

  function selectChip(clicked, categoryValue) {
    chipsEl.querySelectorAll('.pb-fav-chip').forEach((c) => c.classList.remove('pb-fav-chip-active'));
    clicked.classList.add('pb-fav-chip-active');
    activeCategory = categoryValue;
    renderFavoriteList(menu, platform, dropdown, activeCategory);
  }

  allChip.onclick = (e) => { e.stopPropagation(); selectChip(allChip, undefined); };
  uncategorizedChip.onclick = (e) => { e.stopPropagation(); selectChip(uncategorizedChip, ''); };
  chipsEl.querySelectorAll('.pb-fav-chip').forEach((chip) => {
    if (chip === allChip || chip === uncategorizedChip) return;
    chip.onclick = (e) => { e.stopPropagation(); selectChip(chip, chip.textContent); };
  });

  searchInput.value = '';
  // pbDebounceToFrame coalesces rapid keystrokes into at most one search
  // per animation frame — the same helper (inject-utils.js) the mutation
  // observer below already uses for exactly this kind of "don't redo
  // expensive work on every single keystroke" problem.
  searchInput.oninput = pbDebounceToFrame(() => renderFavoriteList(menu, platform, dropdown, activeCategory));

  menu.onclick = (e) => e.stopPropagation();

  dropdown.open();
  await renderFavoriteList(menu, platform, dropdown, activeCategory);
}


// ── TOAST NOTIFICATIONS ─────────────────────────────────────────────────
// A small popup message at the bottom-right of the screen.
// Python analogy: like a flash() message in Flask.
function showToast(message, type = 'info') {
  const existing = document.getElementById('pb-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'pb-toast';
  toast.className = `pb-toast pb-toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('pb-toast-visible');
  });

  setTimeout(() => {
    toast.classList.remove('pb-toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}


// ── INJECTION LOGIC ─────────────────────────────────────────────────────
// Tracks the single active instance (one composer per page across all
// three sites), so we can tell a genuinely new render apart from a
// re-render of the same container, and clean up a stale portaled menu
// before ever creating a second one.
let activeWrapper = null;
let activeMenu = null;
let activeDropdown = null;
let activeFavSaveDropdown = null;   // v0.5
let activeFavBrowseDropdown = null; // v0.5

function cleanupStaleInstance() {
  // Every DOM element has an `.isConnected` property: true if it's
  // currently part of the visible document (a descendant of <html>),
  // false if it's been removed (e.g. its parent got swapped out by a
  // React re-render) or was never inserted at all. This is how we detect
  // "our old button got thrown away by the site" without needing any
  // special notification from the site itself.
  if (activeWrapper && !activeWrapper.isConnected) {
    activeDropdown?.destroy();
    activeFavSaveDropdown?.destroy();
    activeFavBrowseDropdown?.destroy();
    activeWrapper = null;
    activeMenu = null;
    activeDropdown = null;
    activeFavSaveDropdown = null;
    activeFavBrowseDropdown = null;
  }
}

function tryInjectControls() {
  const platform = getPlatform();
  if (!platform) return;

  const input = findInputElement(platform);
  if (!input) return;

  const container = platform.findContainer(input);
  if (!container) return;

  // If a React/Angular re-render replaced our previous container outright,
  // our old wrapper is now detached from the document — tear down its
  // portaled menu before making a new one so we never leak a duplicate.
  cleanupStaleInstance();

  // Don't inject twice into the same (still-connected) container.
  if (container.classList.contains(MARKER_CLASS)) return;

  const { wrapper, menu, dropdown, favSaveDropdown, favBrowseDropdown } = createControls(platform);

  // Only force `position: relative` if the container isn't already
  // positioned — we need SOME positioning context for our absolutely
  // positioned trigger to anchor against. (The dropdown MENU doesn't need
  // this — it's a fixed-position portal on <body>, independent of the
  // container entirely.)
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  // If the container sits very close to the top of the viewport, opening
  // the trigger pill ABOVE it (the default) would push it off-screen —
  // anchor below instead. This is a one-time layout decision made at
  // injection time; the pill then tracks the container automatically via
  // ordinary CSS (no JS needed) since it's plain position:absolute inside
  // a position:relative parent.
  if (container.getBoundingClientRect().top < 60) {
    wrapper.classList.add('pb-anchor-below');
  }

  container.appendChild(wrapper);
  container.classList.add(MARKER_CLASS);

  activeWrapper = wrapper;
  activeMenu = menu;
  activeDropdown = dropdown;
  activeFavSaveDropdown = favSaveDropdown;
  activeFavBrowseDropdown = favBrowseDropdown;
  refreshModeUI();
}


// ── MUTATION OBSERVER + POLLING FALLBACK ────────────────────────────────
// The observer catches most DOM changes (new chat, page re-render), but
// fires on EVERY keystroke inside a contenteditable box (each keystroke
// mutates that box's own subtree) — so its callback is coalesced to at
// most once per animation frame via pbDebounceToFrame, rather than doing
// DOM queries on every single mutation record.
//
// Some SPA client-side navigations swap content in ways the observer can
// miss or catch too late, so we also poll periodically as a safety net.
// Python analogy: an event-driven watcher, backed by a `while True: ...;
// sleep(1.5)` loop just in case an event gets missed.
const scheduleInject = pbDebounceToFrame(tryInjectControls);

// MutationObserver is a built-in browser API for watching a part of the
// page for changes, without you having to manually re-check it yourself.
// `new MutationObserver(callback)` creates the watcher (it does nothing
// until told what to watch); `.observe(target, options)` starts it.
//
//   childList: true  → notify us when direct children are added/removed
//   subtree: true    → also watch all DESCENDANTS, not just direct
//                       children of document.body — necessary since the
//                       chat input is buried many levels deep inside it
//
// Every time something matching those options changes anywhere in the
// page, our callback (`scheduleInject`, the debounced version of
// tryInjectControls from inject-utils.js) runs.
const observer = new MutationObserver(scheduleInject);
observer.observe(document.body, {
  childList: true,
  subtree: true,
});

// setInterval(fn, ms) is the classic "run this repeatedly, forever, every
// `ms` milliseconds" timer. It's a deliberately dumb backstop: even if
// some DOM change somehow doesn't trigger the (much faster and more
// efficient) MutationObserver above, we'll still notice within 1.5
// seconds and fix it. This line runs once, when the file first loads, and
// the timer then keeps firing for as long as the page stays open.
setInterval(tryInjectControls, 1500);

// Everything above this line just DEFINES functions and sets up watchers
// — none of it actually runs tryInjectControls() yet. This final call is
// what makes something happen immediately when the content script first
// loads, in case the chat input is already sitting there in the page
// (rather than waiting for the very first mutation or the first 1.5s tick).
tryInjectControls();
