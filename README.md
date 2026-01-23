# Pocket Reader

A Chrome extension that reads web page content aloud using [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) - a lightweight text-to-speech model that runs entirely in your browser using WebGPU.

![](./images/demo.png)

## Features

- Read any web page content aloud
- **Runs entirely in-browser** - no server required, powered by WebGPU
- **Paragraph-by-paragraph processing** - audio starts playing quickly even for long documents
- Multiple voice options (8 different voices)
- Automatic content extraction (focuses on main article content)
- Playback controls (play/pause/stop) with speed adjustment
- Highlights current paragraph being read
- Remembers reading position per page
- Right-click "Speak Selection" for selected text
- Keyboard shortcuts (Alt+Shift+P to play/pause, Alt+Shift+S to stop)
- Works entirely locally - no cloud services required

## Prerequisites

- Chrome or Chromium-based browser with WebGPU support
- [pnpm](https://pnpm.io/) package manager
- Node.js 18 or later

## Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Build the Extension

```bash
pnpm build
```

This creates a `dist/` directory with the built extension.

### 3. Install the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `dist` folder from this project

> [!NOTE]
> You may need to restart Chrome for the extension to be fully active. Pocket
> Reader may also not appear in your toolbar by default - click the puzzle piece
> icon to pin it.

## Usage

1. Navigate to any web page you want to read
2. Click the Pocket Reader extension icon
3. **First time only**: Click "Download Model" to download the TTS model (~100MB, cached in browser)
4. Select a voice and speed (optional)
5. Click "Read Page"

The extension will:
1. Scan the page for readable content
2. Generate and play audio paragraph by paragraph using WebGPU
3. Highlight each paragraph as it's being read

### Controls

- **Read Page** - Start reading from selected paragraph
- **Pause/Resume** - Pause or resume playback
- **Stop** - Stop playback completely
- **Scan** - Re-scan the page for paragraphs
- **Speed** - Adjust playback speed (0.5x to 2.0x)

### Keyboard Shortcuts

- `Alt+Shift+P` - Play/Pause reading
- `Alt+Shift+S` - Stop reading

### Right-Click Menu

Select any text on a page, right-click, and choose "Speak Selection" to read just the selected text.

## Available Voices

- **Alba** - Default casual voice
- **Marius** - Male voice
- **Javert** - Male voice
- **Jean** - Male voice
- **Fantine** - Female voice
- **Cosette** - Female voice
- **Eponine** - Female voice
- **Azelma** - Female voice

## Development

### Dev Mode

For development with hot reload:

```bash
pnpm dev
```

Then load the extension from the project root directory in Chrome.

### Project Structure

```
pocket-reader/
├── src/
│   ├── manifest.json       # Extension manifest
│   ├── popup/              # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   ├── content/            # Content extraction script
│   │   └── content.ts
│   ├── background/         # Background service worker
│   │   └── background.ts
│   ├── offscreen/          # WebGPU TTS engine
│   │   ├── offscreen.html
│   │   ├── offscreen.ts
│   │   └── tts/
│   │       ├── audio.ts
│   │       ├── inference.ts
│   │       └── pocket-tts.ts
│   └── icons/              # Extension icons
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Troubleshooting

### WebGPU not available
- Make sure you're using a recent version of Chrome (113+)
- Check that WebGPU is enabled: go to `chrome://gpu/` and look for "WebGPU"
- Some older GPUs may not support WebGPU

### Model download fails
- Check your internet connection
- Ensure you have enough disk space (~100MB for the model)
- Try clearing the extension's storage and downloading again

### No audio playing
- Check browser console for errors
- Ensure your browser allows audio playback
- Try clicking somewhere on the page first (browser autoplay policies)

### Content not extracting properly
- The extension tries to find the main article content automatically
- Some pages with unusual layouts may not extract well
- Use "Speak Selection" for specific text

## Technical Details

This extension uses:
- [jax-js](https://github.com/ekzhang/jax-js) - JAX-like ML library for the browser
- [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) - Lightweight TTS model by Kyutai
- WebGPU for accelerated inference
- Chrome's offscreen documents for WebGPU access in extensions

## License

This project uses Pocket TTS which is licensed under the MIT License. See [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) for more details.
