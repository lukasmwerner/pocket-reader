/**
 * Offscreen document for TTS inference using WebGPU
 */

import { defaultDevice, init, numpy as np, tree } from "@jax-js/jax";
import { safetensors } from "@jax-js/loaders";
import { loadSentencePiece, type Unigram } from "./tts/tokenizer";
import { createSilentPlayer, samplesToWav } from "./tts/audio";
import { playTTS } from "./tts/inference";
import { fromSafetensors, type PocketTTS } from "./tts/pocket-tts";

// Model and voice cache
let model: PocketTTS | null = null;
// Cache voice data (raw Float32Array + shape) instead of np.Array to avoid reference issues
let voiceDataCache: Map<string, { data: Float32Array; shape: number[] }> = new Map();
let tokenizer: Unigram | null = null;
let webgpuInitialized = false;

// Model URLs
const MODEL_WEIGHTS_URL =
  "https://huggingface.co/ekzhang/jax-js-models/resolve/main/kyutai-pocket-tts_b6369a24-fp16.safetensors";
const TOKENIZER_URL =
  "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/fbf8280/tokenizer.model";

// Voice embedding URLs from Kyutai
const HF_URL_PREFIX =
  "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/fbf8280";
const VOICE_URLS: Record<string, string> = {
  alba: `${HF_URL_PREFIX}/embeddings/alba.safetensors`,
  azelma: `${HF_URL_PREFIX}/embeddings/azelma.safetensors`,
  cosette: `${HF_URL_PREFIX}/embeddings/cosette.safetensors`,
  eponine: `${HF_URL_PREFIX}/embeddings/eponine.safetensors`,
  fantine: `${HF_URL_PREFIX}/embeddings/fantine.safetensors`,
  javert: `${HF_URL_PREFIX}/embeddings/javert.safetensors`,
  jean: `${HF_URL_PREFIX}/embeddings/jean.safetensors`,
  marius: `${HF_URL_PREFIX}/embeddings/marius.safetensors`,
};

// IndexedDB for caching
const DB_NAME = "pocket-reader-tts";
const DB_VERSION = 1;
const WEIGHTS_STORE = "weights";
const VOICES_STORE = "voices";

interface DownloadProgress {
  loaded: number;
  total: number;
  name: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(WEIGHTS_STORE)) {
        db.createObjectStore(WEIGHTS_STORE);
      }
      if (!db.objectStoreNames.contains(VOICES_STORE)) {
        db.createObjectStore(VOICES_STORE);
      }
    };
  });
}

async function getCachedData(
  storeName: string,
  key: string
): Promise<ArrayBuffer | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

async function setCachedData(
  storeName: string,
  key: string,
  data: ArrayBuffer
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.put(data, key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function downloadWithProgress(
  url: string,
  name: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${name}: ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ loaded, total, name });
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result.buffer;
}

function sendProgress(action: string, data: Record<string, unknown>) {
  chrome.runtime.sendMessage({ action, ...data });
}

async function loadModel(
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  if (model) return;

  // Initialize WebGPU backend
  if (!webgpuInitialized) {
    sendProgress("modelStatus", { status: "loading", name: "WebGPU" });
    const devices = await init();
    console.log("Available devices:", devices);
    if (devices.includes("webgpu")) {
      defaultDevice("webgpu");
      console.log("Using WebGPU backend");
    } else {
      throw new Error("WebGPU not supported - required for TTS inference");
    }
    webgpuInitialized = true;
  }

  // Check cache first
  let weightsData = await getCachedData(WEIGHTS_STORE, "model");
  if (!weightsData) {
    sendProgress("modelStatus", { status: "downloading", name: "model weights" });
    weightsData = await downloadWithProgress(
      MODEL_WEIGHTS_URL,
      "model weights",
      onProgress
    );
    await setCachedData(WEIGHTS_STORE, "model", weightsData);
  }

  sendProgress("modelStatus", { status: "loading", name: "model" });
  const weights = safetensors.parse(new Uint8Array(weightsData));
  
  model = fromSafetensors(weights);

  // Load tokenizer
  sendProgress("modelStatus", { status: "downloading", name: "tokenizer" });
  tokenizer = await loadSentencePiece(TOKENIZER_URL);

  sendProgress("modelStatus", { status: "ready" });
}

async function loadVoice(
  voice: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<np.Array> {
  // Check if we have cached voice data
  if (voiceDataCache.has(voice)) {
    const cached = voiceDataCache.get(voice)!;
    // Create a fresh np.Array from cached data each time
    return np.array(cached.data, {
      dtype: np.float32,
      shape: cached.shape,
    });
  }

  const voiceUrl = VOICE_URLS[voice];
  if (!voiceUrl) {
    throw new Error(`Unknown voice: ${voice}`);
  }

  // Check cache
  let voiceData = await getCachedData(VOICES_STORE, voice);
  if (!voiceData) {
    sendProgress("modelStatus", { status: "downloading", name: `voice: ${voice}` });
    voiceData = await downloadWithProgress(voiceUrl, `voice: ${voice}`, onProgress);
    await setCachedData(VOICES_STORE, voice, voiceData);
  }

  // Parse safetensors and extract embedding
  const voiceFile = safetensors.parse(new Uint8Array(voiceData));
  const audioPrompt = voiceFile.tensors["audio_prompt"];
  if (!audioPrompt) {
    throw new Error(`Voice ${voice} missing audio_prompt tensor`);
  }

  // Cache the raw data and shape for reuse
  const rawData = audioPrompt.data as Float32Array<ArrayBuffer>;
  voiceDataCache.set(voice, { data: rawData, shape: audioPrompt.shape });

  // Return fresh np.Array
  return np.array(rawData, {
    dtype: np.float32,
    shape: audioPrompt.shape,
  });
}

/**
 * Prepare text prompt for TTS
 */
function prepareTextPrompt(text: string): string {
  // Trim and collapse whitespace
  text = text.trim().replace(/\s+/g, " ");

  // Capitalize first character
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Add terminal punctuation if missing
  if (!/[.!?]$/.test(text)) {
    text += ".";
  }

  // Pad short prompts
  while (text.length < 10) {
    text = " " + text;
  }

  return text;
}

/**
 * Tokenize text using SentencePiece
 */
function tokenizeText(text: string): number[] {
  if (!tokenizer) {
    throw new Error("Tokenizer not loaded");
  }
  return tokenizer.encode(text);
}

/**
 * Create text embeddings from tokens
 */
function createTextEmbeddings(tokens: number[]): np.Array {
  if (!model) throw new Error("Model not loaded");

  // Look up embeddings from conditioner embed table using array slicing
  // conditionerEmbed shape: [vocab_size, 1024]
  const tokensArray = np.array(tokens, { dtype: np.int32 });
  return model.flowLM.conditionerEmbed.ref.slice(tokensArray);
}

/**
 * Synthesize speech from text
 */
async function synthesize(
  text: string,
  voice: string,
  requestId: string
): Promise<Blob> {
  if (!model) {
    throw new Error("Model not loaded");
  }

  // Prepare text
  const preparedText = prepareTextPrompt(text);

  // Tokenize
  const tokens = tokenizeText(preparedText);

  // Get voice embedding - shape is [1, frames, 1024], need to squeeze and cast to fp16
  let voiceEmb = await loadVoice(voice, (progress) => {
    sendProgress("downloadProgress", { requestId, ...progress });
  });
  // Remove batch dimension: [1, frames, 1024] -> [frames, 1024]
  voiceEmb = np.squeeze(voiceEmb, 0);
  // Cast to float16 to match model weights
  voiceEmb = voiceEmb.astype(np.float16);

  // Create text embeddings [seq_len, 1024] (already float16 from model)
  const textEmb = createTextEmbeddings(tokens);

  // Combine voice and text embeddings
  const embeds = np.concatenate([voiceEmb, textEmb], 0);

  // Create audio player (silent - just accumulates samples)
  const player = createSilentPlayer();

  // Generate audio
  let stopped = false;
  await playTTS(player as any, tree.ref(model), embeds, {
    temperature: 0.7,
    lsdDecodeSteps: 1,
    framesAfterEos: 2,
    onProgress: (step, total) => {
      sendProgress("synthesisProgress", {
        requestId,
        step,
        total,
        percent: Math.round((step / total) * 100),
      });
    },
    shouldStop: () => stopped,
  });

  // Convert to WAV
  const samples = player.getSamples();
  if (samples.length === 0) {
    throw new Error("No audio samples generated");
  }
  console.log(`Synthesis complete: ${samples.length} samples (${(samples.length / 24000).toFixed(2)}s at 24kHz)`);
  return player.toWav();
}

/**
 * Check if model is cached
 */
async function isModelCached(): Promise<boolean> {
  const weightsData = await getCachedData(WEIGHTS_STORE, "model");
  return weightsData !== null;
}

/**
 * Handle messages from background script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleAsync = async () => {
    try {
      switch (message.action) {
        case "checkModelStatus": {
          const cached = await isModelCached();
          const loaded = model !== null;
          return { cached, loaded };
        }

        case "downloadModel": {
          await loadModel((progress) => {
            sendProgress("downloadProgress", {
              requestId: message.requestId,
              ...progress,
            });
          });
          return { success: true };
        }

        case "synthesize": {
          // Ensure model is loaded
          if (!model) {
            await loadModel((progress) => {
              sendProgress("downloadProgress", {
                requestId: message.requestId,
                ...progress,
              });
            });
          }

          const audioBlob = await synthesize(
            message.text,
            message.voice || "alba",
            message.requestId
          );

          // Convert blob to array buffer, then to Uint8Array for transfer
          // (ArrayBuffer doesn't serialize well through chrome.runtime.sendMessage)
          const arrayBuffer = await audioBlob.arrayBuffer();
          const audioArray = Array.from(new Uint8Array(arrayBuffer));
          console.log(`Sending audio: ${audioArray.length} bytes`);
          return { success: true, audio: audioArray };
        }

        case "preloadVoice": {
          await loadVoice(message.voice, (progress) => {
            sendProgress("downloadProgress", {
              requestId: message.requestId,
              ...progress,
            });
          });
          return { success: true };
        }

        default:
          return { error: `Unknown action: ${message.action}` };
      }
    } catch (error) {
      console.error("Offscreen error:", error);
      return { error: (error as Error).message };
    }
  };

  handleAsync().then(sendResponse);
  return true; // Keep message channel open for async response
});

// Log startup
console.log("Pocket Reader TTS offscreen document loaded");
