/*
  platforms/claude.js — Claude adapter for PromptBench.

  Registers into the shared PB_PLATFORMS registry (declared in
  inject-utils.js, loaded before this file).

  IMPORTANT — verification note: live DOM inspection of claude.ai (via the
  browser) hit a sign-in wall, and signing in on the user's behalf is out
  of scope (credential entry is off-limits regardless of who asks). So
  unlike chatgpt.js and gemini.js, this adapter's selectors are NOT
  confirmed against Claude's live DOM this round — they follow Claude's
  well-documented composer structure (a <fieldset> wrapping a ProseMirror
  contenteditable editor plus its own toolbar).

  To compensate for that lower confidence, findContainer leans harder on
  pbFindSafeAnchor(): even if `fieldset` doesn't match Claude's current
  markup, the generic climb finds the nearest non-clipping, reasonably
  sized ancestor automatically — so this adapter degrades gracefully
  instead of silently overlapping the editor the way the old
  absolute-overlay approach did. If you can sign in and confirm the real
  selectors, tighten inputSelectors/findContainer here accordingly.

  (The `(function registerClaude() { ... })()` wrapper is an IIFE — see
  the longer comment in platforms/chatgpt.js for what that means.)
*/
(function registerClaude() {
  PB_PLATFORMS['claude.ai'] = {
    name: 'Claude',
    accent: '#c15f3c',
    inputSelectors: [
      'div[contenteditable="true"].ProseMirror',
      'fieldset div[contenteditable="true"]',
    ],
    findContainer(inputEl) {
      return inputEl.closest('fieldset') || pbFindSafeAnchor(inputEl);
    },

    // Feature 2 (v0.5), see SPEC-v0.5.md §3.2 and §8 ("Open Questions").
    // SAME caveat as the rest of this file: not confirmed against Claude's
    // live, signed-in DOM. `[data-testid="user-message"]` is Claude's
    // commonly-observed hook for a user turn; assistant turns don't have
    // an equally reliable public hook, so rather than guess a class name
    // that might not exist, this asks each user-message node's own PARENT
    // for its next element sibling — Claude lays out turns as alternating
    // siblings in the scroll container, so "the thing right after a user
    // turn" is a structurally safe way to find the matching assistant
    // turn without depending on that turn's own (unverified) class name.
    // If none of this matches Claude's real markup, it returns [] — a
    // silently-empty history is the correct degrade per §3.6 edge case 6,
    // never a thrown error and never a guess presented as certain.
    extractThreadHistory(maxMessages) {
      try {
        const userNodes = document.querySelectorAll('[data-testid="user-message"]');
        const turns = [];
        for (const userNode of userNodes) {
          const turnRoot = userNode.closest('[data-testid="user-message"]').parentElement;
          turns.push({ role: 'user', text: userNode.innerText.trim() });
          const assistantNode = turnRoot?.nextElementSibling;
          if (assistantNode && assistantNode.innerText.trim()) {
            turns.push({ role: 'assistant', text: assistantNode.innerText.trim() });
          }
        }
        return turns.filter((t) => t.text).slice(-maxMessages);
      } catch {
        return [];
      }
    },
  };
})();
