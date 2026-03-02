# Claude Context Tracker

Real-time context window usage tracker for [Claude Chat](https://claude.ai).

Never get blindsided by running out of context mid-conversation again.

## What it does

- Displays a floating widget showing the estimated percentage of context window used
- Color-coded progression: green → yellow → orange → red as context fills up
- Warning banner at 90% usage with one-click summary generation
- Copy a structured conversation summary to continue seamlessly in a new chat
- Draggable, minimizable, keyboard shortcut (Ctrl+Shift+K)

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select this folder
5. Navigate to [claude.ai](https://claude.ai) — the widget appears in the bottom right

## How it works

The extension injects a content script that:
- Reads visible conversation messages from the DOM
- Estimates token count using a character-based heuristic (~3.5 chars/token)
- Tracks usage against the 200K token context window
- Auto-expands details at 85% and warns at 90%

No data is sent anywhere. Everything runs locally in your browser.

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Chrome Extension manifest (v3) |
| `content.js` | Token estimation, UI logic, summary generation |
| `styles.css` | Claude-native UI styling |
| `icon*.png` | Extension icons |

## Keyboard shortcut

`Ctrl + Shift + K` — Toggle minimize/expand

## License

MIT
