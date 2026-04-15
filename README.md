# Pocket Reader

A Chrome extension that reads web page content aloud using [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) - a lightweight text-to-speech model that runs on your CPU.

![](./images/demo.png)

## Features

- Read any web page content aloud
- **Paragraph-by-paragraph processing** - audio starts playing quickly even for long documents
- Multiple voice options (8 built-in voices + support for custom cloned voices)
- Automatic content extraction (focuses on main article content)
- Simple playback controls (play/stop)
- Works entirely locally - no cloud services required

## Project Structure

```
pocket-reader/
├── server/             # Python TTS server
│   ├── server.py       # Flask server using Pocket TTS
│   └── pyproject.toml  # UV/Python dependencies
├── extension/          # Chrome extension
│   ├── manifest.json   # Extension manifest
│   ├── popup.html      # Extension popup UI
│   ├── popup.css       # Popup styles
│   ├── popup.js        # Popup logic
│   ├── content.js      # Content extraction script
│   ├── background.js   # Background service worker
│   └── icons/          # Extension icons
└── generate_icons.py   # Script to generate extension icons
```

## Prerequisites

- Python 3.10 or later
- [UV](https://docs.astral.sh/uv/) package manager
- Chrome or Chromium-based browser

## Setup

### 1. Generate Extension Icons

First, generate the extension icons:

```bash
uv run --with pillow generate_icons.py
```

### 2. Start the TTS Server

Navigate to the server directory and start the server:

```bash
cd server
uv run server.py
```

The server will:
- Download the Pocket TTS model on first run (~100MB)
- Preload the default voice
- Listen on http://localhost:5050

### 3. Install the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension` folder from this project

> [!NOTE]
> You may need to restart Chrome for the extension to be fully active. Pocket
> Reader may also not appear in your toolbar by default.

## Usage

1. Make sure the TTS server is running
2. Navigate to any web page you want to read
3. Click the Pocket Reader extension icon
4. Select a voice (optional)
5. Click "Read Page"

The extension will:
1. Extract the main content from the page
2. Split the text into paragraphs
3. Generate and play audio paragraph by paragraph (so you hear audio quickly, even for long articles)

Click "Stop" to stop playback at any time.

## Available Voices

- **Alba** - Default casual voice
- **Marius** - Male voice
- **Javert** - Male voice  
- **Jean** - Male voice
- **Fantine** - Female voice
- **Cosette** - Female voice
- **Eponine** - Female voice
- **Azelma** - Female voice

## Adding a Custom Voice

You can add your own cloned voice by placing a `.safetensors` embedding in `server/voices/` and registering it in `server/voices.json`:

```json
{ "id": "my_voice", "name": "My Voice", "path": "voices/my_voice.safetensors" }
```

Restart the server — the voice will appear in the extension dropdown automatically.

To generate a `.safetensors` from a WAV sample (requires access to [kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts)):

```bash
cd server
uv run ../create_voice_embedding.py voices/my_voice.wav voices/my_voice.safetensors
```

## API Endpoints

The TTS server provides the following endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/voices` | GET | List available voices |
| `/paragraphs` | POST | Split text into paragraphs |
| `/synthesize` | POST | Convert text to speech |
| `/synthesize-stream` | POST | Stream synthesized speech chunks (NDJSON) |
| `/preload` | POST | Preload model and voices |

### Example: Synthesize Text

```bash
curl -X POST http://localhost:5050/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world!", "voice": "alba"}' \
  --output speech.wav
```

## Troubleshooting

### Server not connecting
- Make sure the server is running (`uv run server.py` in the server directory)
- Check that port 5050 is not in use by another application

### No audio playing
- Check browser console for errors
- Ensure your browser allows audio playback

### Content not extracting properly
- The extension tries to find the main article content automatically
- Some pages with unusual layouts may not extract well

### Extension not loading content
- You may need to reload the page to have the extension's script to restart on that page

## License

This project uses Pocket TTS which is licensed under the MIT License. See [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) for more details.
