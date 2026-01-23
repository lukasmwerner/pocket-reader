# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
pnpm install        # Install dependencies
pnpm build          # Build extension to dist/
pnpm dev            # Development mode with hot reload
```

After building, load the extension in Chrome via `chrome://extensions/` → "Developer mode" → "Load unpacked" → select `dist/` folder.

## Architecture

This is a Chrome extension that performs text-to-speech entirely in-browser using WebGPU. The architecture uses Chrome's offscreen documents to run WebGPU inference since content scripts and service workers cannot access WebGPU.

### Message Flow

```
Popup ─────────────────────────────────────────────────────────────────────────>
   │
   └──> Background (service worker) ──> Offscreen Document (WebGPU/TTS)
              │                               │
              │                               └──> Returns audio ArrayBuffer
              v
        Content Script <───────────────────────────────────────────────────────
              │
              └──> Web Audio API playback + DOM highlighting
```

### Key Components

**src/offscreen/offscreen.ts** - TTS engine entry point. Handles model loading, IndexedDB caching (~100MB model weights), and synthesis requests. Receives messages from background, returns audio as ArrayBuffer.

**src/offscreen/tts/** - TTS implementation ported from jax-js:
- `pocket-tts.ts` - FlowLM model architecture and Mimi codec
- `inference.ts` - Generation loop with `playTTS()`
- `tokenizer.ts` - SentencePiece Unigram tokenizer (local implementation because npm package lacks this export)
- `audio.ts` - Silent audio player that accumulates samples, converts to WAV

**src/background/background.ts** - Service worker that manages offscreen document lifecycle, forwards messages between popup/content/offscreen, handles keyboard shortcuts and context menu.

**src/content/content.ts** - DOM extraction using heuristics (finds `<article>`, `[role="main"]`, etc.), audio playback via Web Audio API, paragraph prefetching for smoother playback, element highlighting during reading.

**src/popup/** - Extension popup UI for model download, voice/speed selection, playback controls.

### Model Files (downloaded from Hugging Face)

- Model weights: `ekzhang/jax-js-models/kyutai-pocket-tts_b6369a24-fp16.safetensors`
- Tokenizer: `kyutai/pocket-tts-without-voice-cloning/.../tokenizer.model`
- Voice embeddings: `kyutai/pocket-tts-without-voice-cloning/.../embeddings/{voice}.safetensors`

Voice embeddings use tensor name `audio_prompt` with Float32 dtype, shape `[1, frames, 1024]`. Must squeeze batch dimension and cast to float16 before concatenating with text embeddings.

### Chrome Extension Specifics

- Manifest V3 with `offscreen` permission
- Offscreen document created with `AUDIO_PLAYBACK` reason for WebGPU access
- Content script injected on all URLs at `document_idle`
- Keyboard shortcuts: Alt+Shift+P (toggle playback), Alt+Shift+S (stop)
