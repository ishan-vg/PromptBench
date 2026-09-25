# PromptBench

A Chrome extension that improves your prompts right inside **ChatGPT, Claude and Gemini**. Type a rough prompt, pick a mode, and PromptBench rewrites it with the Gemini API before you send it.

## Features

- **7 improvement modes:** Clearer, Detailed, Professional, Creative, Coding, Learning and Research. Every mode shares one base methodology and adds its own short "lens".
- **Conversation-aware rewrites (optional):** reads the last few turns of the current chat, capped at 6 messages and 6,000 characters, so the improved prompt fits the conversation instead of repeating context. It keeps standing instructions and ignores unrelated history.
- **Image-prompt mode:** writes new-generation or targeted-edit prompts tuned for Midjourney, DALL·E, Stable Diffusion or a generic model.
- **Favorites:** save prompts you reuse, with AI-suggested titles, plus JSON export and import for backup.
- **Works in place:** a dropdown sits next to each site's chat box. Per-site adapters handle ChatGPT, Claude and Gemini's different editors.

## How it works

PromptBench is a Manifest V3 extension split across three isolated contexts:

```
Content scripts (inside the chat page)          Service worker (background)
  modes.js, dropdown.js, favorites.js,   ──msg──►  service-worker.js
  inject-utils.js, platforms/*.js,       ◄───────  holds the API key,
  content.js                                        calls the Gemini API
                         Popup (settings): popup/popup.html · .css · .js
```

**Security design:** your Gemini API key is stored in `chrome.storage.local` and only ever read by the background service worker. The content scripts run inside third-party pages, so they never touch the key. They send plain-text messages to the worker and receive the rewritten prompt.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a file-by-file walkthrough.

## Install (developer mode)

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Click the PromptBench icon, paste your [Gemini API key](https://aistudio.google.com/app/apikey), choose a default mode and click **Save Settings**.
5. Open ChatGPT, Claude or Gemini, type a prompt and use the PromptBench dropdown.

No API key is included in this repository. You bring your own.

## Project structure

```
manifest.json          extension config (MV3)
service-worker.js      background worker: Gemini API calls, message routing
modes.js               improvement modes and prompt-engineering instructions
content.js             entry point inside chat pages
dropdown.js            mode picker UI
favorites.js           saved prompts (chrome.storage.local)
inject-utils.js        reading and writing each site's editor
platforms/             ChatGPT, Claude and Gemini adapters
popup/                 settings page
content.css            in-page styles
```

## Tech

JavaScript · Chrome Extensions (Manifest V3) · Gemini API · chrome.storage
