/*
  service-worker.js — The secure backend of PromptBench.

  This runs in an isolated background context that web pages CANNOT access.
  The API key is read from chrome.storage.local and used here — it never
  touches the ChatGPT/Claude/Gemini page.  Content scripts communicate via
  message passing.

  Python analogy: this is like a Flask server that your frontend calls via
  fetch().  The API key lives on the server, not in the browser.
*/

// `importScripts` is the classic-script equivalent of `from modes import
// PB_MODES` — it runs modes.js in this same worker and leaves PB_MODES /
// PB_BASE_INSTRUCTION available as globals. (Only works because this
// service worker is NOT declared as an ES module in manifest.json.)
//
// A background service worker is a bit unusual compared to a normal
// webpage script: Chrome can shut it down when it's been idle for a
// while (to save memory) and silently restart it the next time a message
// arrives. That means you can't rely on a variable staying set in memory
// forever between messages — but it also means this whole file, top to
// bottom, re-runs from scratch every time the worker wakes up, so
// `importScripts('modes.js')` and the `STYLE_PROMPTS` built from it below
// are always freshly rebuilt before any message could possibly arrive.
importScripts('modes.js');

// ── CONFIG ──────────────────────────────────────────────────────────────
const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Build { clearer: '<base methodology>\n\n<clearer lens>', ... } from the
// shared PB_BASE_INSTRUCTION + PB_MODES in modes.js. Every mode gets the
// SAME enhancement methodology; only the short "lens" differs — see the
// big comment at the top of modes.js for why it's split this way.
// Python analogy: like `{m.value: f"{BASE}\n\n{m.lens}" for m in MODES}`.
//
// Reading this line inside-out:
//   PB_MODES.map((mode) => [mode.value, `...`])
//     turns the array of 7 mode OBJECTS into an array of 7 two-item
//     arrays — [key, value] PAIRS — like:
//       [['clearer', '...instructions...'], ['detailed', '...'], ...]
//   Object.fromEntries(...)
//     is the built-in function that turns exactly that shape — a list of
//     [key, value] pairs — into a normal object:
//       { clearer: '...instructions...', detailed: '...', ... }
// The end result, STYLE_PROMPTS.coding, is one long string: the full text
// that gets sent to Gemini as its "system instruction" whenever someone
// picks the Coding mode.
const STYLE_PROMPTS = Object.fromEntries(
  PB_MODES.map((mode) => [mode.value, `${PB_BASE_INSTRUCTION}\n\n${mode.lens}`]),
);


/* ════════════════════════════════════════════════════════════════════════
   v0.5 ADDITIONS — assembling the system prompt for Feature 2 (thread
   context) and Feature 3 (image mode). See SPEC-v0.5.md §3.4 and §4.6.
   The v0.4 shape above (STYLE_PROMPTS, built once at worker startup) is
   left completely untouched — it's still exactly what gets used whenever
   there's no history AND the mode isn't 'image', so a v0.4-style request
   produces a byte-identical system prompt in v0.5.
   ════════════════════════════════════════════════════════════════════════ */

// Turns [{role, text}, ...] into the plain "User: ...\nAssistant: ..."
// block PB_CONTEXT_BASE_INSTRUCTION's {{THREAD_HISTORY_BLOCK}} placeholder
// expects, applying the two-stage budget from SPEC-v0.5.md §3.3:
//   1. truncate any single turn that's individually too long
//   2. if the turns TOGETHER still exceed the total budget, drop the
//      OLDEST turns first (closest-to-now context matters most for "help
//      me phrase my NEXT message")
function pbBuildHistoryBlock(history) {
  const turns = history.map((turn) => {
    const text = turn.text.length > PB_CONTEXT_MAX_CHARS_PER_TURN
      ? `${turn.text.slice(0, PB_CONTEXT_MAX_CHARS_PER_TURN)}… [truncated]`
      : turn.text;
    return { role: turn.role, text };
  });

  let totalChars = turns.reduce((sum, t) => sum + t.text.length, 0);
  while (totalChars > PB_CONTEXT_MAX_TOTAL_CHARS && turns.length > 1) {
    const dropped = turns.shift(); // oldest turn is at index 0 (see content.js — always assembled oldest-first)
    totalChars -= dropped.text.length;
  }

  return turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n');
}

// The single place that decides WHICH system prompt a given request gets.
// `history` is always an array (possibly empty) and `imageTask`/
// `imageTarget` are only meaningful when `style === PB_IMAGE_MODE_VALUE`
// — content.js never sends history alongside image mode (SPEC-v0.5.md §5,
// "Cross-Feature Integration": the two features are deliberately kept
// independent), but this function guards on `style` regardless, rather
// than trusting the caller, so it's correct even if that ever changes.
function pbBuildSystemPrompt({ style, history, imageTask, imageTarget }) {
  if (style === PB_IMAGE_MODE_VALUE) {
    const task = pbGetImageTask(imageTask);
    const baseInstruction = task.value === 'edit' ? PB_IMAGE_EDIT_INSTRUCTION : PB_IMAGE_GENERATE_INSTRUCTION;
    const lens = PB_IMAGE_LENSES[imageTarget] || PB_IMAGE_LENSES.generic;
    return `${baseInstruction}\n\n${lens}`;
  }

  if (Array.isArray(history) && history.length > 0) {
    const historyBlock = pbBuildHistoryBlock(history);
    const contextInstruction = PB_CONTEXT_BASE_INSTRUCTION.replace('{{THREAD_HISTORY_BLOCK}}', historyBlock);
    const lens = pbGetMode(style).lens;
    return `${contextInstruction}\n\n${lens}`;
  }

  // No history, not image mode — identical to v0.4.
  return STYLE_PROMPTS[style] || STYLE_PROMPTS.clearer;
}


// ── MESSAGE LISTENER ────────────────────────────────────────────────────
// Content scripts and the popup send messages here.
// We handle them asynchronously and use `return true` to keep the channel open.
//
// This function runs every time ANY part of the extension calls
// chrome.runtime.sendMessage(...) — content.js's handleImproveClick is the
// only caller today, but the popup or a future feature could send
// messages here too, which is why we check `message.type` to route each
// message to the right handler, like a tiny switchboard.
//
// The tricky, extension-specific part is `return true`. Chrome's
// sendMessage system was designed around old-style callbacks, not
// Promises, and it checks THIS LISTENER FUNCTION'S OWN RETURN VALUE
// (synchronously, the instant it's called) to decide: "is this listener
// planning to call sendResponse() later, asynchronously, or is it done
// answering already?" `return true` means "keep the connection open, I'll
// call sendResponse eventually" — without it, Chrome tears the connection
// down immediately, and a `sendResponse` call after that would silently
// do nothing (leaving the caller's `await chrome.runtime.sendMessage(...)`
// hanging until it eventually times out).
//
// That's also exactly why the actual async work below is wrapped in its
// own separate `(async () => { ... })()` — an "immediately-invoked async
// function expression" — rather than just marking THIS OUTER function
// `async`. If the outer listener itself were `async`, it would always
// return a Promise object (that's what `async function`s do), and Chrome
// would see that Promise where it expects a plain `true`/`undefined` and
// misinterpret it. Wrapping the `await`-using code in its own inner
// function, and calling that function immediately with the trailing
// `()`, lets us use `await` freely INSIDE while the OUTSIDE still
// literally executes `return true` as its very last, synchronous step.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IMPROVE_PROMPT') {
    (async () => {
      try {
        // v0.5: content.js now sends a couple of optional extra fields
        // alongside the original `text`/`style` — `history` (Feature 2)
        // and `imageTask`/`imageTarget` (Feature 3). All three are
        // `undefined` on a plain v0.4-shaped message, and every one of
        // them is optional here too (defaulted below), so nothing about
        // this handler's v0.4 behavior changed for a caller that doesn't
        // send them.
        const result = await handleImprovePrompt({
          text: message.text,
          style: message.style,
          history: message.history || [],
          imageTask: message.imageTask,
          imageTarget: message.imageTarget,
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // keeps the message channel open for the async response
  }

  if (message.type === 'CHECK_API_KEY') {
    (async () => {
      try {
        const { apiKey } = await chrome.storage.local.get('apiKey');
        sendResponse({ hasKey: Boolean(apiKey) });
      } catch {
        sendResponse({ hasKey: false });
      }
    })();
    return true;
  }

  // Feature 1 (v0.5), SPEC-v0.5.md §2.6 — one short, cheap Gemini call
  // fired only when the user explicitly clicks "✨ Suggest" while saving a
  // favorite. Uses the exact same request plumbing as IMPROVE_PROMPT (same
  // API key, same error-handling shape), just a different, much shorter
  // system prompt and a tiny output cap.
  if (message.type === 'SUGGEST_TITLE') {
    (async () => {
      try {
        const result = await handleSuggestTitle(message.text);
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});


// ── API CALL HANDLER ────────────────────────────────────────────────────
// `style` is unchanged from v0.4 in every way except one: it can now also
// be PB_IMAGE_MODE_VALUE ('image'), in which case `imageTask`/
// `imageTarget` pick the prompt instead of `style` itself (see
// pbBuildSystemPrompt above). `history` defaults to [] so a v0.4-shaped
// caller that never mentions it behaves exactly as before.
async function handleImprovePrompt({ text, style, history = [], imageTask, imageTarget }) {
  // 1. Read the API key from secure storage
  const { apiKey } = await chrome.storage.local.get('apiKey');

  if (!apiKey) {
    return {
      success: false,
      error:
        'No API key set. Click the PromptBench icon in your toolbar ' +
        'to add your Gemini API key.',
    };
  }

  // 2. Pick the system prompt — see pbBuildSystemPrompt for the
  // context-aware / image-mode / plain-v0.4 decision logic.
  const systemPrompt = pbBuildSystemPrompt({ style, history, imageTask, imageTarget });

  // 3–5. Call Gemini and unwrap its response — shared with
  // handleSuggestTitle below via pbCallGemini, since the request shape,
  // HTTP-error handling, and response unwrapping are identical for both;
  // only the system prompt, the output-length cap, and the field name the
  // result comes back under actually differ between the two call sites.
  const result = await pbCallGemini(apiKey, systemPrompt, text, 2048);
  if (!result.success) return result;
  return { success: true, improved: result.text };
}

// Shared low-level Gemini caller used by both handleImprovePrompt (above)
// and handleSuggestTitle (below). Returns either { success: true, text }
// or { success: false, error } — callers rename `text` to whatever field
// their own response shape uses (`improved` vs. `title`) so existing
// callers in content.js don't need to change how they read a response.
async function pbCallGemini(apiKey, systemPrompt, userText, maxOutputTokens) {
  // fetch() is the standard, built-in way to make an HTTP request from
  // JavaScript. It always returns a Promise that resolves once the
  // response's HEADERS have arrived (not necessarily the full body yet —
  // that's what the separate `await response.json()`/`.text()` calls
  // below are for). The request itself is a POST with a JSON body, built
  // by JSON.stringify()-ing a plain JS object into a JSON string — the
  // exact shape Gemini's API documentation specifies.
  const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userText }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens,
      },
    }),
  });

  // Unlike some HTTP libraries, fetch() does NOT treat a 4xx/5xx status
  // code as an error you `catch` — the Promise still resolves normally.
  // `response.ok` is just a convenience boolean (true for any 200–299
  // status), so checking it explicitly is how you're supposed to notice a
  // failed request with fetch().
  if (!response.ok) {
    const errorBody = await response.text();

    if (response.status === 400 || response.status === 403) {
      return {
        success: false,
        error: 'Invalid API key. Check your key in PromptBench settings.',
      };
    }
    if (response.status === 429) {
      return {
        success: false,
        error: 'Rate limit reached. Wait a moment and try again.',
      };
    }
    return {
      success: false,
      error: `API error (${response.status}): ${errorBody.slice(0, 200)}`,
    };
  }

  const data = await response.json(); // parses the response body as JSON into a plain JS object
  // Gemini's actual response is a deeply nested object shaped roughly like:
  //   { candidates: [ { content: { parts: [ { text: "..." } ] } } ] }
  // Chaining `?.` at every step (rather than plain `.`) means if ANY link
  // in that chain is missing — say Gemini returned zero candidates for
  // some reason — the whole expression short-circuits to `undefined`
  // instead of crashing with "cannot read property 'content' of
  // undefined." `?.[0]` is the same idea applied to an array index.
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    return {
      success: false,
      error: 'Gemini returned an empty response. Try rephrasing your prompt.',
    };
  }

  return { success: true, text: text.trim() };
}

// Feature 1 (v0.5), SPEC-v0.5.md §2.6 — same API key, same error style as
// handleImprovePrompt, but a short fixed system prompt and a tiny output
// cap (a title is a handful of words, not a rewritten prompt), and it
// also strips any stray surrounding quotes Gemini sometimes adds around a
// short literal answer like this.
async function handleSuggestTitle(text) {
  const { apiKey } = await chrome.storage.local.get('apiKey');

  if (!apiKey) {
    return {
      success: false,
      error:
        'No API key set. Click the PromptBench icon in your toolbar ' +
        'to add your Gemini API key.',
    };
  }

  const result = await pbCallGemini(apiKey, PB_TITLE_SUGGEST_INSTRUCTION, text, 16);
  if (!result.success) return result;

  const title = result.text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  return { success: true, title };
}
