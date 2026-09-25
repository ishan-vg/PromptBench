/*
  favorites.js — Feature 1: Favorite Prompts Management (v0.5).
  See SPEC-v0.5.md §2 for the full design.

  This file is PromptBench's entire data layer for favorites: everything
  above chrome.storage.local for the `pbFavorites` key lives here, and
  NOWHERE else touches that key directly. content.js's favorites-panel UI
  only ever calls the functions this file exposes (pbFavoritesGetAll,
  pbFavoritesSave, ...) — the same "keep storage access behind one small
  API" discipline content.js already applies to `promptStyle` today.

  Loaded as a classic script, same as every other file in this project —
  see modes.js's header comment for why that matters and how it works.

  Storage shape (chrome.storage.local key 'pbFavorites'):
    {
      version: 1,
      categories: string[],   // explicit list, so an EMPTY category can
                               // still exist (created, but nothing saved
                               // into it yet) and can still be renamed
      favorites: Favorite[]
    }

  Favorite shape — see SPEC-v0.5.md §2.2 for the full field-by-field
  rationale:
    {
      id, title, body, category, tags: string[],
      sourceMode, sourcePlatform,
      createdAt, updatedAt, lastUsedAt, useCount,
    }
*/

const PB_FAVORITES_KEY = 'pbFavorites';
const PB_FAVORITES_VERSION = 1;

function pbEmptyFavoritesStore() {
  return { version: PB_FAVORITES_VERSION, categories: [], favorites: [] };
}

// crypto.randomUUID() is available in every context Manifest V3 extensions
// run in (content scripts and service workers alike) on modern Chrome —
// no library needed. The fallback below only matters on the rare browser
// build where it's missing, so favorites can still be created either way.
function pbMakeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `pb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Every read goes through this one function, so a missing key (first run
// after upgrading from v0.4, which never wrote 'pbFavorites' at all) and a
// key that already exists both come back as the SAME well-formed shape —
// callers never have to special-case "storage was empty."
async function pbFavoritesLoadStore() {
  const { [PB_FAVORITES_KEY]: store } = await chrome.storage.local.get(PB_FAVORITES_KEY);
  if (!store || typeof store !== 'object' || !Array.isArray(store.favorites)) {
    return pbEmptyFavoritesStore();
  }
  // Defensive normalization: an imported or hand-edited store might be
  // missing `categories` even though `favorites` is fine.
  return {
    version: store.version || PB_FAVORITES_VERSION,
    categories: Array.isArray(store.categories) ? store.categories : [],
    favorites: store.favorites,
  };
}

async function pbFavoritesSaveStore(store) {
  await chrome.storage.local.set({ [PB_FAVORITES_KEY]: store });
}

// ── PUBLIC API ────────────────────────────────────────────────────────────

async function pbFavoritesGetAll() {
  const store = await pbFavoritesLoadStore();
  return store.favorites;
}

async function pbFavoritesGetCategories() {
  const store = await pbFavoritesLoadStore();
  // Union of explicitly-created categories AND any category name still
  // referenced by a favorite (covers a store that was hand-imported
  // without its category list kept in sync) — de-duplicated, empty
  // string excluded (that's "Uncategorized", handled separately by the
  // UI, not a real category a user created).
  const fromFavorites = store.favorites.map((f) => f.category).filter(Boolean);
  return [...new Set([...store.categories, ...fromFavorites])];
}

async function pbFavoritesAddCategory(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const store = await pbFavoritesLoadStore();
  if (!store.categories.includes(trimmed)) {
    store.categories.push(trimmed);
    await pbFavoritesSaveStore(store);
  }
}

// Deleting a category NEVER deletes the favorites in it (SPEC-v0.5.md §2.7,
// edge case 4) — they fall back to Uncategorized ('').
async function pbFavoritesDeleteCategory(name) {
  const store = await pbFavoritesLoadStore();
  store.categories = store.categories.filter((c) => c !== name);
  for (const fav of store.favorites) {
    if (fav.category === name) fav.category = '';
  }
  await pbFavoritesSaveStore(store);
}

// `input` is the raw data from the save form: { title, body, category, tags }.
// Returns the fully-populated Favorite that was saved, so the caller (the
// save-panel UI in content.js) can show a confirmation without a second
// read.
async function pbFavoritesSave(input) {
  const store = await pbFavoritesLoadStore();
  const now = Date.now();

  const favorite = {
    id: pbMakeId(),
    title: (input.title || '').trim().slice(0, 80) || 'Untitled prompt',
    body: input.body || '',
    category: (input.category || '').trim(),
    tags: Array.isArray(input.tags)
      ? [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
      : [],
    sourceMode: input.sourceMode || '',
    sourcePlatform: input.sourcePlatform || '',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    useCount: 0,
  };

  // A category typed into the save form that doesn't exist yet becomes a
  // real category going forward, exactly like typing a new tag in most
  // note-taking apps — no separate "create category first" step required.
  if (favorite.category && !store.categories.includes(favorite.category)) {
    store.categories.push(favorite.category);
  }

  store.favorites.push(favorite);
  await pbFavoritesSaveStore(store);
  return favorite;
}

async function pbFavoritesUpdate(id, patch) {
  const store = await pbFavoritesLoadStore();
  const favorite = store.favorites.find((f) => f.id === id);
  if (!favorite) return null;
  Object.assign(favorite, patch, { updatedAt: Date.now() });
  await pbFavoritesSaveStore(store);
  return favorite;
}

async function pbFavoritesDelete(id) {
  const store = await pbFavoritesLoadStore();
  store.favorites = store.favorites.filter((f) => f.id !== id);
  await pbFavoritesSaveStore(store);
}

// Bumps useCount/lastUsedAt when a favorite is actually inserted into a
// page (not when it's merely viewed in the panel) — powers the "Most
// used" sort from SPEC-v0.5.md FR-1.9.
async function pbFavoritesRecordUse(id) {
  // "Increment by one" can't be expressed as a plain Object.assign patch,
  // so this does its own read-modify-write instead of going through the
  // generic pbFavoritesUpdate() helper used for everything else here.
  const store = await pbFavoritesLoadStore();
  const favorite = store.favorites.find((f) => f.id === id);
  if (!favorite) return;
  favorite.useCount = (favorite.useCount || 0) + 1;
  favorite.lastUsedAt = Date.now();
  await pbFavoritesSaveStore(store);
}

// `query` is free text (matched against title/body/tags, case-insensitive);
// `category` narrows to one category ('' means Uncategorized, undefined/
// null means "all categories"). `sortBy` is 'recent' | 'used' | 'alpha'.
async function pbFavoritesSearch({ query = '', category = undefined, sortBy = 'recent' } = {}) {
  const store = await pbFavoritesLoadStore();
  const q = query.trim().toLowerCase();

  let results = store.favorites.filter((f) => {
    if (category !== undefined && f.category !== category) return false;
    if (!q) return true;
    return (
      f.title.toLowerCase().includes(q) ||
      f.body.toLowerCase().includes(q) ||
      f.tags.some((t) => t.includes(q))
    );
  });

  if (sortBy === 'used') {
    results = results.sort((a, b) => b.useCount - a.useCount);
  } else if (sortBy === 'alpha') {
    results = results.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    results = results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return results;
}

// FR-1.8: export the whole store as a JSON string suitable for
// `Blob`-then-download in the popup.
async function pbFavoritesExport() {
  const store = await pbFavoritesLoadStore();
  return JSON.stringify(store, null, 2);
}

// FR-1.8 / SPEC-v0.5.md §2.7 edge cases 5 & 6: import is ADDITIVE and
// SAFE TO RE-RUN — it never overwrites an existing favorite, and never
// touches storage at all if the file doesn't look like a favorites
// export. Returns the number of favorites actually added.
async function pbFavoritesImport(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  if (!parsed || !Array.isArray(parsed.favorites)) {
    throw new Error('That file doesn\'t look like a PromptBench favorites export.');
  }

  const store = await pbFavoritesLoadStore();
  const existingIds = new Set(store.favorites.map((f) => f.id));

  for (const incoming of parsed.favorites) {
    if (!incoming || typeof incoming.body !== 'string') continue; // skip malformed entries rather than aborting the whole import
    const id = existingIds.has(incoming.id) ? pbMakeId() : (incoming.id || pbMakeId());
    store.favorites.push({
      id,
      title: incoming.title || 'Untitled prompt',
      body: incoming.body,
      category: incoming.category || '',
      tags: Array.isArray(incoming.tags) ? incoming.tags : [],
      sourceMode: incoming.sourceMode || '',
      sourcePlatform: incoming.sourcePlatform || '',
      createdAt: incoming.createdAt || Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: incoming.lastUsedAt || null,
      useCount: incoming.useCount || 0,
    });
    existingIds.add(id);
  }

  if (Array.isArray(parsed.categories)) {
    for (const c of parsed.categories) {
      if (c && !store.categories.includes(c)) store.categories.push(c);
    }
  }

  await pbFavoritesSaveStore(store);
  return parsed.favorites.length;
}
