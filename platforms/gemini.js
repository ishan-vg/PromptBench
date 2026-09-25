/*
  platforms/gemini.js — Gemini adapter for PromptBench.

  Registers into the shared PB_PLATFORMS registry (declared in
  inject-utils.js, loaded before this file).

  Verified against Gemini's live DOM (gemini.google.com):
    rich-textarea div[contenteditable="true"] (.ql-editor)
      -> <rich-textarea> (overflow:visible)
      -> .textarea-wrapper (overflow:visible)
      -> .text-input-field_textarea-inner (overflow:HIDDEN)
      -> .text-input-field-main-area (overflow:visible)
      -> .single-line-format (overflow:visible)
      -> .text-input-field   <-- CSS GRID, overflow:HIDDEN. This is the row
                                  that lays out the editor next to the
                                  leading (upload/tools) and trailing
                                  (mic/send) button groups. Injecting a 4th
                                  child directly into this grid risks being
                                  squeezed into an implicit track and
                                  clipped by its own overflow:hidden — this
                                  is almost certainly what caused the
                                  "covers the input" bug.
      -> .input-area          <-- position:relative, overflow:VISIBLE, and
                                  its box exactly wraps .text-input-field
                                  (confirmed via getBoundingClientRect).
                                  Anchoring an absolutely-positioned pill
                                  here sits it above the whole input row —
                                  editor, upload/tools, mic/send — without
                                  touching Gemini's grid layout at all.
                                  Confirmed by injecting a test probe and
                                  screenshotting: it rendered cleanly above
                                  the input box with no clipping or overlap.

  Note: this was inspected on Gemini's logged-out landing composer (no
  Google sign-in performed on the user's behalf, per policy). The
  input-area-container/text-input-field component structure is Gemini's
  shared Angular input widget, used for both the zero-state and an active
  conversation, so this should carry over — but pbFindSafeAnchor() is kept
  as a fallback in case the signed-in layout differs enough to matter.

  (The `(function registerGemini() { ... })()` wrapper is an IIFE —
  see the longer comment in platforms/chatgpt.js for what that means and
  why every platforms/*.js file uses the same shape.)
*/
(function registerGemini() {
  PB_PLATFORMS['gemini.google.com'] = {
    name: 'Gemini',
    accent: '#4285f4',
    inputSelectors: [
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
    ],
    findContainer(inputEl) {
      return inputEl.closest('.input-area') || pbFindSafeAnchor(inputEl);
    },

    // Feature 2 (v0.5), see SPEC-v0.5.md §3.2. Gemini's conversation turns
    // render as custom elements — `<user-query>` for what the person sent,
    // `<model-response>` for Gemini's reply — which this targets directly
    // rather than any of their internal class names (custom element TAG
    // NAMES are far more stable across a redesign than the CSS classes
    // inside them). This was NOT re-verified signed-in this round (same
    // logged-out-only constraint noted at the top of this file), so it's
    // wrapped defensively like the other two adapters.
    //
    // IMPORTANT CAVEAT (SPEC-v0.5.md §3.2 and §8): Gemini's message list
    // can be virtualized — only turns currently scrolled into view may
    // exist in the DOM at all. This function can only ever return what's
    // actually rendered right now; on a long thread scrolled far down,
    // that may be fewer than `maxMessages` turns even though more exist
    // earlier in the conversation. That's expected, not a bug.
    extractThreadHistory(maxMessages) {
      try {
        const nodes = document.querySelectorAll('user-query, model-response');
        return pbExtractHistoryFromNodes(
          nodes,
          (node) => (node.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant'),
          maxMessages,
        );
      } catch {
        return [];
      }
    },
  };
})();
