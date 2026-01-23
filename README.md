# Pocket Reader

A Chrome extension that reads web page content aloud using [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) - a lightweight text-to-speech model that runs entirely in your browser via WebAssembly.

![](./images/demo.png)

## Features

- Read any web page content aloud
- **No server required** - runs entirely in the browser via WebAssembly
- **Paragraph-by-paragraph processing** - audio starts playing quickly even for long documents
- **Smart prefetching** - generates next paragraph while current one plays
- Multiple voice options (8 different voices)
- Automatic content extraction (focuses on main article content)
- **Element highlighting** - shows which paragraph is being read
- **Reading position memory** - resume where you left off
- Adjustable playback speed (0.5x to 2.0x)
- Keyboard shortcuts (Alt+Shift+P to play/pause, Alt+Shift+S to stop)
- Right-click "Speak Selection" for highlighted text
- Works entirely locally - no cloud services required (model downloads from HuggingFace on first use)

## Project Structure

```
pocket-reader/
├── extension/          # Chrome extension
│   ├── manifest.json   # Extension manifest
│   ├── popup.html      # Extension popup UI
│   ├── popup.css       # Popup styles
│   ├── popup.js        # Popup logic
│   ├── content.js      # Content extraction & playback
│   ├── background.js   # Background service worker
│   ├── tts-engine.js   # WASM TTS wrapper
│   ├── wasm/           # WASM files (after setup)
│   │   ├── pocket_tts.js
│   │   └── pocket_tts_bg.wasm
│   └── icons/          # Extension icons
├── setup-wasm.sh       # Script to build/download WASM files
└── generate_icons.py   # Script to generate extension icons
```

## Prerequisites

- [Rust](https://rustup.rs/) (for building WASM)
- Chrome or Chromium-based browser

## Setup

### 1. Generate Extension Icons

First, generate the extension icons (requires Python and Pillow):

```bash
uv run --with pillow generate_icons.py
```

### 2. Build the WASM Package

Run the setup script to clone pocket-tts and build the WASM package:

```bash
./setup-wasm.sh
```

This will:
- Clone the [pocket-tts](https://github.com/babybirdprd/pocket-tts) repository
- Build the WASM package with `wasm-pack`
- Copy the compiled files to `extension/wasm/`

### 3. Install the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension` folder from this project

> [!NOTE]
> On first use, the extension will download the TTS model (~150MB) from HuggingFace.
> This only happens once - subsequent uses will be faster.

## Usage

1. Navigate to any web page you want to read
2. Click the Pocket Reader extension icon
3. Select a voice (optional)
4. Adjust speed (optional)
5. Click "Read Page"

The extension will:
1. Load the TTS model (first time only, ~150MB download)
2. Extract the main content from the page
3. Generate and play audio paragraph by paragraph
4. Highlight the current paragraph being read
5. Prefetch the next paragraph for seamless playback

### Controls

- **Read Page** - Start reading from selected paragraph
- **Pause/Resume** - Pause or resume playback
- **Stop** - Stop playback completely
- **Scan** - Re-scan the page for paragraphs

### Keyboard Shortcuts

- `Alt+Shift+P` - Toggle play/pause
- `Alt+Shift+S` - Stop playback

### Right-Click Menu

Select any text on a page and right-click to use "Speak Selection".

## Available Voices

- **Alba** - Calm, default voice
- **Marius** - Deep male voice
- **Javert** - Firm male voice
- **Jean** - Warm male voice
- **Fantine** - Soft female voice
- **Cosette** - Bright female voice
- **Eponine** - Raspy female voice
- **Azelma** - Bold female voice

## How It Works

1. **WASM TTS Engine**: The extension uses a Rust implementation of Pocket TTS compiled to WebAssembly
2. **On-Demand Loading**: The TTS model (~150MB) is downloaded from HuggingFace on first use
3. **Voice Embeddings**: Voice presets are loaded as needed from HuggingFace
4. **Local Processing**: All text-to-speech synthesis happens in your browser
5. **No Server**: Unlike v1, this version requires no backend server

## Troubleshooting

### Model not loading
- Check your internet connection (model downloads from HuggingFace)
- Check browser console for errors
- Try reloading the page

### No audio playing
- Check browser console for errors
- Ensure your browser allows audio playback
- Some pages with strict CSP may block audio - try a different page

### Content not extracting properly
- The extension tries to find the main article content automatically
- Some pages with unusual layouts may not extract well
- Click "Scan" to re-scan the page

### Extension not loading content
- Reload the page to restart the content script

### WASM not loading
- Make sure you ran `./setup-wasm.sh` to build the WASM files
- Check that `extension/wasm/pocket_tts.js` and `pocket_tts_bg.wasm` exist

## Development

### Manual WASM Build

If you want to build the WASM package manually:

```bash
# Clone pocket-tts
git clone https://github.com/babybirdprd/pocket-tts.git
cd pocket-tts/crates/pocket-tts

# Build with wasm-pack
wasm-pack build --target web --out-dir pkg . -- --features wasm

# Copy files to extension
cp pkg/pocket_tts.js /path/to/pocket-reader/extension/wasm/
cp pkg/pocket_tts_bg.wasm /path/to/pocket-reader/extension/wasm/
```

## License

This project uses Pocket TTS which is licensed under the MIT License. See [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) for more details.
