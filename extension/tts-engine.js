/**
 * Pocket Reader - TTS Engine
 * WASM-based text-to-speech using Pocket TTS
 * Uses chrome.runtime messaging to communicate with worker iframe
 */

// Worker iframe for WASM execution
let workerFrame = null;
let workerReady = false;
let pendingRequests = new Map();
let requestId = 0;
let progressCallback = null;

// Unique ID for this content script instance
const instanceId = Math.random().toString(36).substring(2);

/**
 * Create and initialize the worker iframe
 */
function ensureWorkerFrame() {
  return new Promise((resolve, reject) => {
    if (workerFrame && workerReady) {
      resolve();
      return;
    }

    if (workerFrame) {
      // Already creating, wait for ready
      const checkReady = setInterval(() => {
        if (workerReady) {
          clearInterval(checkReady);
          resolve();
        }
      }, 50);
      return;
    }

    // Set up message listener BEFORE creating iframe
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Only handle messages meant for this instance
      if (message.targetInstance !== instanceId) return;

      const data = message.data;
      console.log('TTS Engine received via runtime:', data.type || data.id);

      if (data.type === 'worker-ready') {
        workerReady = true;
        console.log('TTS Worker is ready!');
        resolve();
        return;
      }

      if (data.type === 'worker-error') {
        console.error('TTS Worker error:', data.error);
        reject(new Error(`Worker error: ${data.error}`));
        return;
      }

      if (data.type === 'progress' && progressCallback) {
        progressCallback(data.status, data.text);
        return;
      }

      if (data.id && pendingRequests.has(data.id)) {
        const { resolve: res, reject: rej } = pendingRequests.get(data.id);
        pendingRequests.delete(data.id);

        if (data.type === 'error') {
          rej(new Error(data.error));
        } else {
          res(data);
        }
      }
    });

    // Create hidden iframe with instance ID in URL
    workerFrame = document.createElement('iframe');
    workerFrame.src = chrome.runtime.getURL('tts-worker.html') + '?instance=' + instanceId;
    workerFrame.style.cssText = 'display:none;width:0;height:0;border:none;position:absolute;';

    workerFrame.onload = () => {
      console.log('TTS Worker iframe onload fired');
    };

    workerFrame.onerror = (e) => {
      console.error('TTS Worker iframe error:', e);
      reject(new Error('Failed to load TTS worker iframe'));
    };

    document.body.appendChild(workerFrame);
    console.log('TTS Worker iframe created:', workerFrame.src);

    // Timeout for worker initialization
    setTimeout(() => {
      if (!workerReady) {
        console.error('TTS Worker timeout. Instance:', instanceId);
        reject(new Error('TTS worker failed to initialize (timeout)'));
      }
    }, 10000);
  });
}

/**
 * Send a message to the worker via the iframe's postMessage
 * (worker will respond via chrome.runtime)
 */
function sendToWorker(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });

    // Send via postMessage to the iframe
    workerFrame.contentWindow.postMessage({ id, action, payload }, '*');

    // Timeout for individual requests (5 minutes for model download)
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 300000);
  });
}

/**
 * Initialize the TTS model
 */
async function initializeTTS(onProgress) {
  progressCallback = onProgress;

  await ensureWorkerFrame();

  const result = await sendToWorker('initialize');
  if (!result.success) {
    throw new Error('Failed to initialize TTS');
  }

  progressCallback = null;
  return true;
}

/**
 * Generate speech from text
 * Returns a Blob containing WAV audio
 */
async function synthesize(text, voiceName, onProgress) {
  progressCallback = onProgress;

  await ensureWorkerFrame();

  const result = await sendToWorker('synthesize', { text, voice: voiceName });

  if (!result.success) {
    throw new Error('Synthesis failed');
  }

  // Convert data URL to Blob
  const base64 = result.wavDataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  progressCallback = null;
  return new Blob([bytes], { type: 'audio/wav' });
}

/**
 * Check if the TTS engine is ready
 */
async function isReady() {
  if (!workerFrame || !workerReady) return false;

  try {
    const result = await sendToWorker('isReady');
    return result.ready;
  } catch {
    return false;
  }
}

/**
 * Get the sample rate of the generated audio
 */
function getSampleRate() {
  return 24000;
}

// Export functions for use by content script
window.TTSEngine = {
  initialize: initializeTTS,
  synthesize,
  isReady,
  getSampleRate,
};

console.log('Pocket Reader TTS Engine loaded, instance:', instanceId);
