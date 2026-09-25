/*
  platforms/chatgpt.js — ChatGPT adapter for PromptBench.

  Registers into the shared PB_PLATFORMS registry (declared in
  inject-utils.js, loaded before this file). content.js knows nothing
  about ChatGPT specifically — everything site-specific lives here.

  Verified against ChatGPT's live DOM (logged out, chatgpt.com):
    #prompt-textarea (.ProseMirror)
      -> .../overflow:auto wrapper
      -> .../[grid-area:primary] (overflow-x:hidden)
      -> .../flex-1 row wrapper
      -> .composer-surface... (overflow: CLIP — do not anchor inside this)
      -> .relative (position:relative, overflow:visible)
      -> <form class="group/composer ..."> (position:static, overflow:visible)
  The <form> wraps the entire composer — input box AND its toolbar row
  (attach, tools, voice, send) — and is not clipped, so anchoring there
  keeps our pill clear of everything ChatGPT renders inside it.

  Why this whole file is wrapped in `(function registerChatGPT() { ... })()`:
  this shape — defining a function and immediately calling it with the
  trailing `()` — is called an IMMEDIATELY-INVOKED FUNCTION EXPRESSION, or
  IIFE. It's a classic pattern from before JS had proper modules: normal
  variables/functions declared with `function`/`const`/`let` INSIDE this
  wrapper stay private to it (nothing to worry about here, since we don't
  declare any), while the ONE thing we deliberately want to be global —
  `PB_PLATFORMS['chatgpt.com'] = {...}` — reaches out and modifies the
  shared registry object that inject-utils.js already created. All three
  platforms/*.js files use this same shape purely as a matter of style
  and habit, to make it visually obvious "this file's job is to run once
  and register itself" the moment you open it.
*/
(function registerChatGPT() {
  PB_PLATFORMS['chatgpt.com'] = {
    name: 'ChatGPT',
    accent: '#10a37f', // the split-button's color on this site (see --pb-accent in content.css)
    // Tried in order — the first one that matches an element on the page wins.
    inputSelectors: ['#prompt-textarea', 'form [contenteditable="true"]', 'form textarea'],
    // `inputEl.closest(selector)` walks UP from inputEl through its
    // ancestors (parent, grandparent, ...) and returns the nearest one
    // matching `selector` — here, the nearest surrounding <form>. If
    // ChatGPT ever removes the <form> wrapper entirely, `|| pbFindSafeAnchor(inputEl)`
    // (from inject-utils.js) kicks in as a generic backup.
    findContainer(inputEl) {
      return inputEl.closest('form') || pbFindSafeAnchor(inputEl);
    },

    // Feature 2 (v0.5), see SPEC-v0.5.md §3.2 — ChatGPT tags every message
    // bubble with a real `data-message-author-role="user"|"assistant"`
    // attribute, so this adapter needs no structural guessing at all: the
    // role is just read straight off the DOM. pbExtractHistoryFromNodes
    // (inject-utils.js) handles turning the matched elements into the
    // plain [{role, text}, ...] shape content.js/service-worker.js expect.
    extractThreadHistory(maxMessages) {
      const nodes = document.querySelectorAll('[data-message-author-role]');
      return pbExtractHistoryFromNodes(
        nodes,
        (node) => node.getAttribute('data-message-author-role'),
        maxMessages,
      );
    },
  };
})();
