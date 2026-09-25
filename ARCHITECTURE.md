# PromptBench — How It All Works

This is a guided tour of the codebase, written for someone learning Chrome
extension development (and a fair bit of general web dev) through this
project. It assumes no prior knowledge of Chrome extensions. Read it
top to bottom once, then keep it open as a map while you read the actual
code — every file below has its own comments too, and this document tells
you how those files fit together.

---

## 1. What a Chrome extension actually is

A Chrome extension is just a folder of files (HTML, CSS, JS, and a special
`manifest.json`) that Chrome loads and runs in a few different, **isolated**
places at once. "Isolated" is the key word — it's the whole reason
PromptBench is split into so many files instead of being one big script.

PromptBench runs in three separate worlds that cannot directly touch each
other's variables:

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  CONTENT SCRIPT              │     │  BACKGROUND SERVICE WORKER    │
│  (runs INSIDE the chat page, │     │  (runs in its own hidden      │
│   e.g. chatgpt.com)          │     │   process — the page can      │
│                               │◄───►│   never see into it)          │
│  modes.js, dropdown.js,      │ msg │                                │
│  inject-utils.js,             │     │  service-worker.js            │
│  platforms/*.js, content.js  │     │  (holds your Gemini API key,  │
│                               │     │   calls the Gemini API)       │
└─────────────────────────────┘     └──────────────────────────────┘

┌─────────────────────────────┐
│  POPUP                       │
│  (its own tiny HTML page,    │
│   opens when you click the   │
│   toolbar icon)               │
│                               │
│  popup/popup.html/.css/.js   │
└─────────────────────────────┘
```

Why bother splitting it up like this? **Security.** The content script runs
*inside* chatgpt.com/claude.ai/gemini.google.com — technically those sites'
own JavaScript is running right next to ours on the same page. If your
Gemini API key ever touched a variable in the content script, a malicious
or compromised version of that site could theoretically read it. So the
key lives *only* in the service worker (a separate process the page has no
access to), and the content script just sends it a plain-text message like
"please improve this prompt" and waits for an answer. This is the
`SECURITY NOTE` comment you'll see at the top of `content.js`.

---

## 2. `manifest.json` — the table of contents

Chrome reads this file first. It's plain JSON (which, notably, **cannot
contain comments** — that's why this file has none, and why everything
about it is explained here instead). It tells Chrome:

- `permissions: ["storage"]` — we're allowed to use `chrome.storage.local`
  (a simple key-value store, think of it like a tiny built-in database
  just for this extension).
- `host_permissions` — the *only* external URL our code is allowed to make
  network requests to: the Gemini API. Nothing else, not even ChatGPT's
  own servers.
- `background.service_worker` — which file to run as the hidden background
  process (`service-worker.js`).
- `action.default_popup` — which HTML file to show when you click the
  toolbar icon (`popup/popup.html`).
- `content_scripts` — the important one. It says: on any page matching
  `chatgpt.com`, `claude.ai`, or `gemini.google.com`, automatically inject
  this **list** of JS files (in this exact order!) and this CSS file.

That `js` array's order matters enormously and is one of the most
important things to understand in this whole project:

```json
"js": [
  "modes.js",              // 1. defines PB_MODES (just data)
  "dropdown.js",            // 2. defines pbCreateDropdown (just a function)
  "inject-utils.js",         // 3. defines PB_PLATFORMS = {} (the empty registry)
                             //    + a few helper functions
  "platforms/chatgpt.js",   // 4. fills in PB_PLATFORMS['chatgpt.com']
  "platforms/claude.js",    // 5. fills in PB_PLATFORMS['claude.ai']
  "platforms/gemini.js",    // 6. fills in PB_PLATFORMS['gemini.google.com']
  "content.js"              // 7. the orchestrator — uses everything above
]
```

Even though these are 7 separate files, Chrome loads them like 7 `<script>`
tags on the same page, **in this order, sharing one global scope**. That's
why `platforms/chatgpt.js` can just write
`PB_PLATFORMS['chatgpt.com'] = {...}` without any `import` statement — the
`PB_PLATFORMS` object already exists because `inject-utils.js` ran first
and created it. If you ever reorder this array and something stops
working, this is almost always why (a file trying to use something that
hasn't been defined yet).

This is different from how you'd normally write modern JavaScript (with
`import`/`export`). Content scripts CAN'T easily use `import`/`export`
without extra build tooling, so this project uses the older, simpler
"classic script" style instead — plain global variables and functions,
loaded in a careful order. It's less fashionable but much easier to read
when you're starting out, since there's no build step between the code you
write and the code that runs.

---

## 3. The content-script files, in load order

### `modes.js` — just data (and the enhancement methodology)

Defines two things:

- `PB_BASE_INSTRUCTION` — a big string: the actual instructions sent to
  Gemini telling it *how* to improve any prompt (see §6).
- `PB_MODES` — an array of 7 objects, one per mode (Clearer, Detailed,
  Professional, Creative, Coding, Learning, Research). Each has an
  `icon`, `label`, `hint` (menu tooltip), and a `lens` (a couple of
  sentences specific to that mode — see §6).

This file is loaded by **three different contexts** that otherwise share
nothing: the content script, the popup, and the service worker (via
`importScripts`, since a service worker isn't a normal web page — see
§4). Keeping the mode list in one file means the on-page menu, the popup's
dropdown, and the actual Gemini prompts can never drift out of sync with
each other.

### `dropdown.js` — a reusable dropdown, with no idea what's inside it

Defines one function: `pbCreateDropdown(trigger, menu)`. Give it any two
DOM elements — a "trigger" (something clickable) and a "menu" (the popup
content) — and it turns them into a fully working dropdown: click to open,
click outside or press Escape to close, and (this is the interesting part)
it automatically decides whether to open **above or below** the trigger,
and clamps itself so it never runs off the edge of the screen. It has
zero knowledge of prompts, modes, or chat websites — it would work exactly
the same if you handed it a completely unrelated button and menu. That's
intentional: it's a generic *utility*, reused by `content.js` for one
specific menu, but not tied to it.

See §7 for exactly how the positioning math works.

### `inject-utils.js` — the toolbox + the registry

Two unrelated things live here, bundled together because they're both
"stuff every platform adapter needs":

1. `const PB_PLATFORMS = {};` — an empty object, declared here so that
   the platform files (loaded right after this one) have something to add
   themselves to. Think of it like setting an empty shelf in place before
   the delivery trucks (the platform files) arrive to stock it.
2. Generic helper functions used by more than one place:
   - `pbFindSafeAnchor(el)` — "given this input box, climb up its parent
     elements until you find one that's safe to attach our button to."
     See §8 for why this exists.
   - `pbGetElementText(el)` / `pbSetElementText(el, text)` — read/write
     text from either an old-fashioned `<textarea>` or a modern
     `contenteditable` box (all three chat sites use the latter). See §9.
   - `pbDebounceToFrame(fn)` — a small performance helper (see §10).

### `platforms/chatgpt.js`, `platforms/claude.js`, `platforms/gemini.js`

Each of these is short and formulaic — they exist purely so that
`content.js` never has to know anything about any specific website. Each
one adds one entry to `PB_PLATFORMS`, keyed by hostname:

```js
PB_PLATFORMS['gemini.google.com'] = {
  name: 'Gemini',
  accent: '#4285f4',                 // the button's color on this site
  inputSelectors: [...],             // CSS selectors to find the text box
  findContainer(inputEl) { ... },    // where to attach our button
};
```

If a site redesigns its page and our selectors stop matching, you fix it
by editing **one small file**, not by hunting through the shared logic.
This pattern — a shared "core" that asks each "adapter" the same three
questions (what do you look like, where's your text box, where's it safe
to attach a button) — is a common one in real software, often called the
**adapter pattern** or **strategy pattern**.

### `content.js` — the orchestrator

This is the file that actually *does* things. Everything above it is
either data or reusable tools; this is where they get used together. It:

1. Figures out which site you're on (`getPlatform()`, using
   `window.location.hostname` to look itself up in `PB_PLATFORMS`).
2. Builds the on-page button + menu (`createControls()`).
3. Wires up `pbCreateDropdown()` to make the menu behave.
4. Handles clicks — reads your prompt text, sends it to the service
   worker, writes the improved text back (`handleImproveClick()`).
5. Repeatedly checks whether the button needs to be (re-)injected, since
   these are all single-page apps that can rebuild their DOM without
   reloading the page (`tryInjectControls()`, `MutationObserver`, and a
   1.5-second polling fallback — see §10).

---

## 4. `service-worker.js` — the "backend"

This file runs somewhere else entirely — not on the page at all. Chrome
starts it up in the background (it can even go to sleep and wake up again
between messages, which is why you can't rely on ordinary variables in it
staying alive forever — though for this extension's simple request/response
pattern, that doesn't matter).

It does two things:

1. `importScripts('modes.js')` — the service-worker equivalent of the
   `<script>` tag trick from §2. This is NOT a content script, so it can't
   get files injected by `manifest.json`'s `content_scripts` list — instead
   it explicitly pulls in `modes.js` itself, the moment it starts up, so it
   also has access to `PB_MODES` and `PB_BASE_INSTRUCTION`.
2. Listens for messages from the content script
   (`chrome.runtime.onMessage.addListener`), and when one arrives, reads
   your saved API key from `chrome.storage.local`, builds the full prompt
   (base instructions + that mode's `lens`), and calls the Gemini API with
   `fetch()`. It reports back success/failure, and the content script does
   the rest.

This file is the **only** place in the entire codebase that ever touches
your API key or talks to the network.

---

## 5. `popup/` — the settings window

A completely ordinary, tiny web page (`popup.html` + `popup.css` +
`popup.js`) that Chrome shows in a little floating panel when you click
the toolbar icon. It has no special extension powers beyond being allowed
to use `chrome.storage.local` — it's really just a form that reads and
writes two settings (`apiKey`, `promptStyle`) to that storage. It also
loads `modes.js` (via a `<script src="../modes.js">` tag) purely so it can
build its mode dropdown from the same `PB_MODES` list content.js uses,
instead of a second hand-typed copy that could drift out of sync.

---

## 6. The prompt-enhancement "meta-prompt" design

Rather than writing 7 completely separate instructions (one full essay per
mode), this project uses **one shared methodology + seven short lenses**:

```
final instruction sent to Gemini
   = PB_BASE_INSTRUCTION           (modes.js — the actual "how to improve
                                     any prompt well" methodology)
   + "\n\n"
   + mode.lens                     (modes.js — 2-3 sentences: what THIS
                                     mode should pay extra attention to)
```

`PB_BASE_INSTRUCTION` tells Gemini, in order: figure out what the user
actually wants and don't change it; find what's genuinely ambiguous or
missing versus what can be reasonably inferred; add only the structure
that specific request benefits from (not a fixed checklist); don't bloat
a prompt that's already fine; and before finishing, ask itself "does every
sentence I added actually help, or should I cut it?"

Each mode's `lens` is short on purpose — e.g. Coding's lens just says to
pay attention to language/framework, edge cases, and testing expectations.
It doesn't repeat the whole methodology, because the base instruction
already covers that for every mode. This is built in `service-worker.js`:

```js
const STYLE_PROMPTS = Object.fromEntries(
  PB_MODES.map((mode) => [mode.value, `${PB_BASE_INSTRUCTION}\n\n${mode.lens}`]),
);
```

---

## 7. How the dropdown decides where to open

This is worth understanding on its own because it solves a real, common
web-dev problem: **a popup menu that must never run off the screen, no
matter where its button happens to be.**

Two ideas combine to make this work:

**Idea 1 — "portal" the menu onto `<body>`.** Instead of the menu living
next to its button in the page's normal layout (nested inside whatever
container the button happens to be in), `pbCreateDropdown()` physically
moves the menu element to be a direct child of `<body>`, and gives it
`position: fixed`. Two reasons: (a) `position: fixed` is measured from the
*browser window*, not from any parent element, so nothing the chat site
does with its own layout can shift it around unexpectedly; and (b) chat
sites often wrap their input box in a container with `overflow: hidden`
(so a giant pasted image doesn't break their layout) — if our menu were
inside that container, it would get invisibly sliced off the moment it
tried to extend past the container's edge. Moving it to `<body>` sidesteps
that entirely.

**Idea 2 — measure, then decide.** Every time the menu is about to open,
`place()` in `dropdown.js` calls `trigger.getBoundingClientRect()` (a
built-in browser function that returns the button's exact pixel position
on screen right now) and compares the space below the button to the
space above it. If there's enough room below, it opens downward (the
normal case). If not, but there's more room above, it flips upward. If
*neither* direction has enough room (a very small screen), it picks
whichever side has more space and sets a `max-height` + `overflow-y: auto`
so the menu becomes scrollable instead of overflowing.

One subtlety that actually caused a real bug during testing: CSS
`max-height` only limits an element's own content box by default — if the
element also has padding and a border, those get added *on top* of your
`max-height`, so the element can still end up taller than the space you
measured. The fix was adding `box-sizing: border-box` to the menu, which
makes `max-height` mean "the size of the whole box, padding and border
included" — matching what the JavaScript math actually assumed.

---

## 8. Why `pbFindSafeAnchor()` exists

Each platform adapter has a `findContainer(inputEl)` function that returns
the DOM element our button should be attached to. The *first* choice is
always a specific, hand-verified CSS selector (e.g. Gemini's `.input-area`).
But websites change their markup without warning, so every adapter also
falls back to `pbFindSafeAnchor()`, which is a generic algorithm: starting
from the text box, climb up through its parent elements one at a time,
and stop at the first one that (a) isn't clipping its contents
(`overflow: hidden`/`clip`) and (b) is a reasonably-sized element rather
than a 1-pixel wrapper `<div>`. It's not guaranteed to find the *perfect*
spot, but it's a safety net that avoids the original Gemini bug (getting
attached inside a container that silently clipped or squeezed our button)
even if a site's exact class names change tomorrow.

---

## 9. Reading and writing text in a `contenteditable` box

None of these three sites use a plain old `<textarea>` for their message
box anymore — they use a `<div contenteditable="true">`, which behaves
more like a tiny rich-text editor. This matters because you can't just do
`div.value = "new text"` (that only works on real `<textarea>`/`<input>`
elements) — a `<div>` has no `.value` property.

`pbSetElementText()` in `inject-utils.js` handles both cases:

- For a real `<textarea>`/`<input>`, it uses a small trick:
  `Object.getOwnPropertyDescriptor(...).set.call(el, text)` calls the
  browser's *original* value-setting function directly. This matters
  because these sites are built with frameworks like React, which secretly
  wrap the normal `.value =` assignment to detect changes — if you just do
  `el.value = text`, React never notices, and the page's own "Send" button
  might not enable, since React thinks nothing happened.
- For `contenteditable` (all three sites, today), it selects the entire
  contents of the box and calls `document.execCommand('insertText', ...)`
  — which is the same code path the browser uses when you paste
  something. Using the real "paste" mechanism (rather than just setting
  `.textContent`) is what makes React/Angular actually register the
  change.

---

## 10. Why there's a `MutationObserver` *and* a `setInterval`

Chat sites are "single-page apps" — clicking around inside them doesn't
reload the page, it just swaps pieces of the DOM in and out with
JavaScript. That means our button can get silently removed (if the site
rebuilds the input area) without any normal page-load event firing that
we could listen for.

- `MutationObserver` watches the whole page for DOM changes and re-checks
  whether our button needs to be re-injected, every time something
  changes. It's efficient and catches almost everything immediately.
- But it fires on **every single keystroke** you type (since typing
  changes the DOM inside the text box), so `content.js` wraps its callback
  in `pbDebounceToFrame()` — a tiny helper that says "if I'm already
  scheduled to run this frame, don't schedule it again," coalescing a
  potential flood of calls down to at most one check per screen refresh
  (~60 times a second, worst case, instead of once per keystroke *and*
  every other DOM change).
- The `setInterval(tryInjectControls, 1500)` is a deliberately dumb safety
  net: every 1.5 seconds, just check again regardless. This catches the
  rare cases where a site's DOM change somehow doesn't trigger the
  observer in a way we catch in time.

---

## 11. "If you want to change X, look in Y"

| You want to...                                      | Edit this file |
|-------------------------------------------------------|----------------|
| Change what a mode's icon/label/hint says              | `modes.js` |
| Change the actual enhancement instructions sent to Gemini | `modes.js` (`PB_BASE_INSTRUCTION` and/or a mode's `lens`) |
| Add a brand-new mode (an 8th one)                       | `modes.js` — add one object to `PB_MODES`; nothing else needs to change |
| Support a new chat website                              | Add `platforms/newsite.js` (copy an existing one as a template) + list it in `manifest.json`'s `js` array + add its URL to `matches` |
| Fix a broken selector on an existing site               | The relevant `platforms/*.js` file only |
| Change how the button/menu looks                         | `content.css` |
| Change the dropdown's open/close behavior or positioning math | `dropdown.js` |
| Change which Gemini model is called, or API request shape | `service-worker.js` |
| Change the popup/settings window                         | `popup/popup.html`, `.css`, `.js` |
| Change what happens when you click "Improve"              | `content.js` (`handleImproveClick`) |

---

## 12. A glossary, since a lot of this is new vocabulary

- **Manifest V3** — the current version of Chrome's extension system
  (older extensions used "Manifest V2," which is being phased out).
- **Content script** — JS that Chrome injects into a normal web page, as
  if the site itself had included a `<script>` tag for it. Runs in the
  page's DOM, but in a separate JS sandbox from the page's own scripts —
  it can read/write the page's HTML, but the page's own variables and
  functions aren't directly visible to it (and vice versa).
- **Service worker** — a background script with no visible window, used
  here purely as a secure place to hold the API key. (Confusingly, the
  same term "service worker" is also used for a different, more common
  web feature — offline caching for regular websites. Chrome extensions
  reuse the name and some of the underlying tech, but it's a distinct use
  case here.)
- **`contenteditable`** — an HTML attribute that turns any element into an
  editable text box, used instead of `<textarea>` when a site wants rich
  formatting (bold text, pasted images, etc.) inside the box.
- **`getBoundingClientRect()`** — a built-in function every DOM element
  has, returning its current on-screen pixel position and size.
- **Closure** — a function that "remembers" variables from the scope it
  was created in, even after that outer function has finished running.
  `pbCreateDropdown()` uses this heavily: `open`, `close`, and `toggle`
  are all separate functions that share access to the same private
  `isOpen` variable, without that variable being a global.
- **Promise / `async`/`await`** — JavaScript's way of handling operations
  that take time (like a network request) without freezing the page.
  `chrome.storage.local.get(...)` and `fetch(...)` both return Promises;
  `async function` + `await` is just a cleaner way to write code that
  waits for a Promise to finish.
- **Event bubbling vs. capturing** — when you click something, the click
  "bubbles" upward from that exact element through all its ancestors up
  to `document`. Most `addEventListener` calls listen during this bubble
  phase (the default). A `scroll` event is unusual — it does *not*
  bubble — so to detect scrolling anywhere on the page, `dropdown.js` has
  to listen during the earlier "capture" phase instead
  (`addEventListener('scroll', fn, true)` — that `true` is what requests
  capture phase).
- **`e.stopPropagation()`** — called inside an event handler, this stops
  the event from continuing to bubble further up the page. Used
  throughout `content.js` so that clicking our own button/menu never
  accidentally triggers something on the underlying chat site (or our own
  "click outside to close" listener).

---

## Where this could go next

A few ideas for extending this project, roughly ordered from smallest to
most involved, are discussed separately — ask and they can be added here
as a running list once you've decided which ones you want to try.
