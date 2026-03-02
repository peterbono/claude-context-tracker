# Claude Context Tracker

Real-time context window and usage limits tracker for [Claude Chat](https://claude.ai).

Never get blindsided by running out of context or credits mid-conversation again.

## What it does

- Displays a floating widget showing the estimated percentage of context window used
- Color-coded progression: green → yellow → orange → red as context fills up
- **Usage limits**: shows your session, weekly and Sonnet-only limits with progress bars
- Warning banner at 90% usage with one-click summary generation
- Copy a structured conversation summary to continue seamlessly in a new chat
- Celebration animation when your credits recharge
- Draggable, minimizable, keyboard shortcut (Ctrl+Shift+K)

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select this folder
5. Navigate to [claude.ai](https://claude.ai) — the widget appears in the bottom right

## Setup usage limits

To display your usage limits (session, weekly, Sonnet), visit **[claude.ai/settings/usage](https://claude.ai/settings/usage)** once. The extension automatically reads the data from the page and syncs it to the widget on all your Claude tabs.

The limits update every time you visit the settings page.

## How it works

**Context tracking** — A content script reads visible conversation messages from the DOM and estimates token count using a character-based heuristic (~3.5 chars/token), tracking usage against the 200K token context window. Auto-expands details at 85% and warns at 90%.

**Usage limits** — When you visit the Claude settings page, the extension scrapes your current usage data (session limits, weekly limits, model-specific limits) directly from the page DOM. This data is stored locally and displayed in the widget across all Claude tabs.

**Rate limit detection** — A background service worker monitors API response headers for rate limit info and detects 429 status codes, so you know immediately when you've hit a limit.

No API keys needed. No data is sent anywhere. Everything runs locally in your browser.

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Chrome Extension manifest (v3) |
| `content.js` | Token estimation, UI logic, settings scraping, summary generation |
| `background.js` | API header monitoring, rate limit detection, data sync |
| `styles.css` | Claude-native UI styling |
| `icon*.png` | Extension icons |

## Keyboard shortcut

`Ctrl + Shift + K` — Toggle minimize/expand

## License

MIT
