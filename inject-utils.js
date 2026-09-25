/*
  inject-utils.js — Shared DOM utilities used by every platform adapter.

  This file also declares PB_PLATFORMS, the registry each platforms/*.js
  file adds itself to (see manifest.json for load order: this file runs
  BEFORE the platform adapters, so the registry object exists for them to
  populate, and BEFORE content.js, which only reads from it).
*/

const PB_PLATFORMS = {};


// ── SAFE ANCHOR FINDER ──────────────────────────────────────────────────
// Generic fallback for "where do I attach my controls near this input
// without getting clipped or squeezed by the site's own layout." Each
// platform adapter's findContainer() tries a known-good selector FIRST
// (verified against that site's real DOM), then falls back to this if the
// site's markup has changed since. It climbs from the input element
// looking for the nearest ancestor that (a) isn't itself clipping overflow
// — so an absolutely-positioned child of it won't be cut off — and
// (b) is roomy enough to plausibly be a real layout container rather than
// a 1px text-wrapping div.
//
// Python analogy: like walking up a BeautifulSoup tree with
// `.find_parent()` until a predicate matches, instead of hardcoding one
// exact ancestor path that breaks the moment the page's markup shifts.
function pbFindSafeAnchor(inputEl) {
  let node = inputEl.parentElement;
  let hops = 0;
  const maxHops = 8;

  while (node && node !== document.body && hops < maxHops) {
    // getComputedStyle(node) returns the FINAL, resolved CSS for an
    // element — after the browser has applied every stylesheet, inline
    // style, and default browser style and figured out which one wins.
    // This is different from `node.style`, which only shows styles set
    // directly on that element (e.g. via `el.style.color = 'red'`) and
    // would miss anything coming from a stylesheet or class.
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();

    const clips =
      style.overflowX === 'hidden' || style.overflowY === 'hidden' ||
      style.overflowX === 'clip'   || style.overflowY === 'clip';
    const roomyEnough = rect.width > 80 && rect.height > 20;

    if (!clips && roomyEnough) return node;

    node = node.parentElement;
    hops++;
  }

  // Nothing suitable found within maxHops — fall back to the immediate
  // parent rather than failing outright. Not perfect, but never worse
  // than the site's default layout.
  return inputEl.parentElement;
}


// ── READ / WRITE TEXT ACROSS TEXTAREAS AND CONTENTEDITABLE DIVS ─────────
// ChatGPT, Claude, and Gemini all use a contenteditable <div> for the
// prompt box today, but we also support a plain <textarea>/<input> in
// case a site reverts to one.
function pbGetElementText(el) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
  return el.innerText;
}

function pbSetElementText(el, text) {
  el.focus();

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    // React (and friends) tracks the *native* setter, not a plain
    // `el.value = x` assignment, so we call the real prototype setter and
    // then fire an InputEvent — otherwise the page's Send button never
    // notices the text changed.
    //
    // Step by step, since this line packs in a few unfamiliar ideas:
    //   1. Every <textarea> element is built from the SAME blueprint —
    //      HTMLTextAreaElement.prototype — which is where the browser
    //      actually defines what ".value" means for a textarea (getting
    //      AND setting it). `proto` just picks the right blueprint for
    //      whichever tag we're dealing with.
    //   2. Object.getOwnPropertyDescriptor(proto, 'value') asks the
    //      blueprint: "how exactly is the `.value` property implemented?"
    //      The answer is an object with `.get` and `.set` functions — the
    //      actual, original, browser-provided setter function, before any
    //      framework has had a chance to intercept it.
    //   3. React replaces `el.value = ...` on individual elements with its
    //      own version that also updates React's internal bookkeeping —
    //      but it can't (and doesn't try to) remove the ORIGINAL setter
    //      from the shared prototype. By grabbing that original function
    //      and calling it directly (`nativeSetter.call(el, text)`), we set
    //      the value while going around React's tracking entirely.
    //   4. That's exactly why the very next line is necessary: since we
    //      deliberately skipped React's own change-detection, we have to
    //      manually fire the 'input' event ourselves, which is the signal
    //      React (and plain JS listening for input events) actually
    //      listens for to notice "the user typed something."
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  // Contenteditable path (ChatGPT / Claude's ProseMirror / Gemini's rich
  // textarea). Selecting all the content and running execCommand
  // ('insertText', …) simulates a real paste — that's what makes these
  // React/ProseMirror/Angular-based editors actually register the change,
  // unlike a raw `el.innerText = text` assignment.
  // A "Range" is the browser's way of describing a span of content on the
  // page (the same underlying concept behind what happens when a human
  // drags their mouse to highlight text). `selectNodeContents(el)` builds
  // a range covering everything inside our editor box; `window.getSelection()`
  // is the browser's ONE global "what's currently highlighted" object, and
  // replacing its contents with our range is the programmatic equivalent
  // of the user selecting all the old text by hand before typing over it.
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges(); // clear any existing selection first
  selection.addRange(range);   // then select all of the editor's content

  // With everything selected, execCommand('insertText', ...) is the
  // browser's built-in "type/paste this text over the current selection"
  // command — the exact same code path a real paste triggers. `false` is
  // an unused legacy argument execCommand still requires; it returns
  // `true` if the command was understood and ran.
  const inserted = document.execCommand('insertText', false, text);
  if (!inserted) {
    // Fallback for the rare case execCommand is unsupported.
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}


// ── THREAD HISTORY HELPER (Feature 2, v0.5) ─────────────────────────────
// Shared by every platforms/*.js adapter's extractThreadHistory() so the
// "turn a NodeList of message elements into a plain [{role, text}, ...]
// array" logic — reading .innerText, trimming, dropping empties, keeping
// only the last N — is written once instead of three times. Each adapter
// still owns its OWN site-specific SELECTOR and role-detection logic
// (that part genuinely differs per site); this just does the shared,
// boring part after the elements have been found.
//
// `roleFn(node)` must return 'user' or 'assistant' for a given message
// element — how to decide that is exactly the site-specific knowledge an
// adapter is responsible for (an attribute on ChatGPT, structural
// position on Claude/Gemini — see each platforms/*.js file's comments).
//
// Wrapped in try/catch by design: a thread-history extractor is a
// nice-to-have layered on top of the core Improve flow, and per
// SPEC-v0.5.md §3.6 (edge case 6), a broken selector here must degrade to
// "no context found," never break or block the Improve button itself.
function pbExtractHistoryFromNodes(nodeList, roleFn, maxMessages) {
  try {
    const nodes = Array.from(nodeList).slice(-maxMessages);
    return nodes
      .map((node) => ({ role: roleFn(node), text: node.innerText.trim() }))
      .filter((turn) => turn.text && (turn.role === 'user' || turn.role === 'assistant'));
  } catch {
    return [];
  }
}


// ── SMALL DEBOUNCE HELPER ───────────────────────────────────────────────
// Coalesces bursts of calls (e.g. a MutationObserver firing on every
// keystroke inside a contenteditable box) into at most one per animation
// frame, so we're not doing DOM queries on every single mutation record.
function pbDebounceToFrame(fn) {
  // Same closure trick as dropdown.js's `isOpen`: `scheduled` lives here,
  // and the `debounced` function returned below keeps access to it
  // forever, even though pbDebounceToFrame() itself already returned.
  let scheduled = false;

  // `...args` ("rest parameters") scoops up however many arguments the
  // caller passes into a real array called `args` — this function doesn't
  // need to know or care how many arguments `fn` expects. `fn(...args)`
  // ("spread") then does the reverse: unpacks that array back out as
  // individual arguments when finally calling `fn`. Together they let
  // pbDebounceToFrame wrap ANY function, regardless of its signature.
  return function debounced(...args) {
    if (scheduled) return; // a frame is already pending — piggyback on it
    scheduled = true;
    // requestAnimationFrame asks the browser to run this callback right
    // before its next repaint (usually ~60 times a second). Using it here
    // means: no matter how many times `debounced()` gets called in a
    // single burst (e.g. once per keystroke), the real work in `fn` only
    // actually runs once per screen refresh.
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...args);
    });
  };
}
