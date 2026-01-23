/**
 * Pocket Reader - Content Script
 * Extracts main content from web pages and handles audio playback
 * Uses WebGPU TTS via offscreen document (no server required)
 */

// Audio playback state
let audioContext: AudioContext | null = null;
let currentAudioSource: AudioBufferSourceNode | null = null;
let currentAudioBuffer: AudioBuffer | null = null;
let audioStartTime = 0;
let audioPauseTime = 0;
let shouldStop = false;
let isPaused = false;
let playbackSpeed = 1.0;
let currentParagraphIndex = 0;
let totalParagraphs = 0;

// Selection reading state (separate from main page reading)
let selectionAudioContext: AudioContext | null = null;
let selectionAudioSource: AudioBufferSourceNode | null = null;
let isReadingSelection = false;

// DOM element tracking for highlighting
let readableElements: Array<{ element: HTMLElement; text: string }> = [];
let currentHighlightedElement: HTMLElement | null = null;

// CSS class for highlighting
const HIGHLIGHT_CLASS = "pocket-reader-highlight";
const HIGHLIGHT_STYLE_ID = "pocket-reader-styles";

/**
 * Get or create the audio context
 */
function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Get or create the selection audio context
 */
function getSelectionAudioContext(): AudioContext {
  if (!selectionAudioContext) {
    selectionAudioContext = new AudioContext();
  }
  return selectionAudioContext;
}

/**
 * Inject highlight styles into the page
 */
function injectHighlightStyles(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background-color: rgba(99, 102, 241, 0.15) !important;
      outline: 2px solid rgba(99, 102, 241, 0.5) !important;
      outline-offset: 2px !important;
      border-radius: 4px !important;
      transition: background-color 0.2s ease, outline 0.2s ease !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Highlight a specific element
 */
function highlightElement(element: HTMLElement | null): void {
  if (currentHighlightedElement) {
    currentHighlightedElement.classList.remove(HIGHLIGHT_CLASS);
  }

  if (element) {
    element.classList.add(HIGHLIGHT_CLASS);
    currentHighlightedElement = element;
    element.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }
}

/**
 * Remove all highlights
 */
function removeHighlight(): void {
  if (currentHighlightedElement) {
    currentHighlightedElement.classList.remove(HIGHLIGHT_CLASS);
    currentHighlightedElement = null;
  }
}

/**
 * Find the main content container
 */
function findContentContainer(): HTMLElement {
  const selectors = [
    "article",
    '[role="main"]',
    "main",
    ".article-content",
    ".post-content",
    ".entry-content",
    ".content",
    "#content",
    ".story-body",
    ".article-body",
    ".post-body",
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element && element.innerText.trim().length > 200) {
      return element;
    }
  }

  return document.body;
}

/**
 * Check if an element should be excluded from reading
 */
function isExcludedElement(element: HTMLElement): boolean {
  const excludedTags = [
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "NAV",
    "HEADER",
    "FOOTER",
    "ASIDE",
  ];
  if (excludedTags.includes(element.tagName)) return true;

  const excludedClasses = [
    "sidebar",
    "navigation",
    "menu",
    "comments",
    "comment",
    "advertisement",
    "ad",
    "ads",
    "social-share",
    "share-buttons",
    "related-posts",
    "recommended",
  ];

  const classList = Array.from(element.classList).map((c) => c.toLowerCase());
  if (excludedClasses.some((exc) => classList.includes(exc))) return true;

  const role = element.getAttribute("role");
  if (role && ["navigation", "banner", "complementary"].includes(role))
    return true;

  if (element.getAttribute("aria-hidden") === "true") return true;

  return false;
}

/**
 * Check if an element is visible
 */
function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    element.offsetParent !== null
  );
}

/**
 * Extract readable elements from the DOM
 */
function extractReadableElements(): Array<{ element: HTMLElement; text: string }> {
  const container = findContentContainer();
  const elements: Array<{ element: HTMLElement; text: string }> = [];

  const readableSelectors =
    "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd, pre";
  const candidates = container.querySelectorAll<HTMLElement>(readableSelectors);

  for (const element of candidates) {
    // Skip if inside an excluded parent
    let parent = element.parentElement;
    let excluded = false;
    while (parent && parent !== container) {
      if (isExcludedElement(parent as HTMLElement)) {
        excluded = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (excluded) continue;

    if (isExcludedElement(element)) continue;
    if (!isVisible(element)) continue;

    const text = (element.innerText || element.textContent || "").trim();
    if (text.length < 10) continue;

    // Skip if content is entirely in children we'll process
    const childReadables = element.querySelectorAll(readableSelectors);
    if (childReadables.length > 0) {
      const childText = Array.from(childReadables)
        .map((c) => (c as HTMLElement).innerText?.trim() || "")
        .join("");
      if (childText.length >= text.length * 0.9) {
        continue;
      }
    }

    elements.push({ element, text });
  }

  return elements;
}

/**
 * Extract the main readable content from the page
 */
function extractMainContent(): string {
  const elements = extractReadableElements();
  const texts = elements.map((e) => e.text);
  const title = getPageTitle();
  if (title) {
    texts.unshift(title);
  }
  return texts.join("\n\n");
}

/**
 * Get page title
 */
function getPageTitle(): string {
  return document.title || "";
}

/**
 * Get normalized URL for position storage
 */
function getNormalizedUrl(): string {
  const url = new URL(window.location.href);
  return url.origin + url.pathname;
}

/**
 * Save reading position to chrome storage
 */
function saveReadingPosition(paragraphIndex: number, total: number): void {
  const url = getNormalizedUrl();
  chrome.storage.local.get("readingPositions", (result) => {
    const positions = (result.readingPositions as Record<string, unknown>) || {};
    positions[url] = {
      index: paragraphIndex,
      total,
      timestamp: Date.now(),
    };
    chrome.storage.local.set({ readingPositions: positions });
  });
}

/**
 * Clear reading position for current URL
 */
function clearReadingPosition(): void {
  const url = getNormalizedUrl();
  chrome.storage.local.get("readingPositions", (result) => {
    const positions = (result.readingPositions as Record<string, unknown>) || {};
    delete positions[url];
    chrome.storage.local.set({ readingPositions: positions });
  });
}

/**
 * Send message to popup/background
 */
function notifyExtension(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Extension context might be invalid
  });
}

/**
 * Synthesize a single paragraph via background/offscreen
 */
async function synthesizeParagraph(
  text: string,
  voice: string
): Promise<ArrayBuffer> {
  const response = await chrome.runtime.sendMessage({
    action: "synthesize",
    text,
    voice,
  });

  if (response.error) {
    throw new Error(response.error);
  }

  // Audio comes back as a regular array (since ArrayBuffer doesn't serialize well)
  // Convert it back to ArrayBuffer
  const audioArray = response.audio as number[];
  const audioBuffer = new Uint8Array(audioArray).buffer;
  
  console.log(`Synthesized audio: ${audioBuffer.byteLength} bytes`);
  return audioBuffer;
}

/**
 * Play audio from ArrayBuffer using Web Audio API
 */
async function playAudioBuffer(
  audioData: ArrayBuffer,
  onReadyToPrefetch?: () => void
): Promise<{ stopped: boolean }> {
  return new Promise(async (resolve, reject) => {
    if (shouldStop) {
      resolve({ stopped: true });
      return;
    }

    try {
      const context = getAudioContext();

      // Resume context if suspended (browser autoplay policy)
      if (context.state === "suspended") {
        await context.resume();
      }

      // Decode audio data
      const audioBuffer = await context.decodeAudioData(audioData.slice(0));

      if (shouldStop) {
        resolve({ stopped: true });
        return;
      }

      currentAudioBuffer = audioBuffer;

      // Create source node
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = playbackSpeed;
      source.connect(context.destination);

      currentAudioSource = source;

      // Set up prefetch timer (at 70% of duration)
      const duration = audioBuffer.duration;
      const prefetchTime = ((duration / playbackSpeed) * 0.7 * 1000);
      const prefetchTimer = setTimeout(() => {
        onReadyToPrefetch?.();
      }, prefetchTime);

      source.onended = () => {
        clearTimeout(prefetchTimer);
        currentAudioSource = null;
        currentAudioBuffer = null;
        if (!shouldStop) {
          resolve({ stopped: false });
        }
      };

      // Start playback
      audioStartTime = context.currentTime;
      audioPauseTime = 0;
      source.start(0);
    } catch (error) {
      currentAudioSource = null;
      currentAudioBuffer = null;
      reject(error);
    }
  });
}

/**
 * Read paragraphs with prefetching
 */
async function readParagraphsFromIndex(
  paragraphs: Array<string | { text: string; elementIndex: number }>,
  voice: string,
  startIndex: number = 0,
  speed: number = 1.0,
  useHighlighting: boolean = false
): Promise<void> {
  shouldStop = false;
  isPaused = false;
  playbackSpeed = speed;
  totalParagraphs = paragraphs.length;
  currentParagraphIndex = startIndex;

  if (useHighlighting) {
    injectHighlightStyles();
  }

  const total = paragraphs.length;
  const remaining = total - startIndex;

  try {
    notifyExtension({
      action: "progress",
      percent: 10,
      text: `Reading from paragraph ${startIndex + 1}/${total}...`,
    });

    // Cache for prefetched audio
    const prefetchedAudio = new Map<number, ArrayBuffer>();

    const getText = (para: string | { text: string }): string =>
      typeof para === "string" ? para : para.text;

    const getElement = (
      para: string | { text: string; elementIndex: number }
    ): HTMLElement | null => {
      if (typeof para === "object" && para.elementIndex !== undefined) {
        return readableElements[para.elementIndex]?.element || null;
      }
      return null;
    };

    const prefetchNext = (index: number): void => {
      if (
        index < paragraphs.length &&
        !prefetchedAudio.has(index) &&
        !shouldStop
      ) {
        synthesizeParagraph(getText(paragraphs[index]), voice)
          .then((audio) => {
            if (!shouldStop) {
              prefetchedAudio.set(index, audio);
            }
          })
          .catch((err) => {
            console.warn(`Prefetch failed for paragraph ${index}:`, err);
          });
      }
    };

    for (let i = startIndex; i < paragraphs.length; i++) {
      if (shouldStop) break;

      currentParagraphIndex = i;
      const progressPercent = 10 + Math.floor(((i - startIndex) / remaining) * 80);

      // Get audio (prefetched or generate)
      let audioData: ArrayBuffer;
      if (prefetchedAudio.has(i)) {
        audioData = prefetchedAudio.get(i)!;
        prefetchedAudio.delete(i);
      } else {
        notifyExtension({
          action: "progress",
          percent: progressPercent,
          text: `Generating ${i + 1}/${total}...`,
        });
        audioData = await synthesizeParagraph(getText(paragraphs[i]), voice);
      }

      if (shouldStop) break;

      // Highlight current element
      if (useHighlighting) {
        const element = getElement(paragraphs[i]);
        if (element) {
          highlightElement(element);
        }
      }

      notifyExtension({
        action: "playing",
        current: i + 1,
        total,
      });

      saveReadingPosition(i, total);

      // Start prefetching next paragraph
      if (i + 1 < paragraphs.length) {
        prefetchNext(i + 1);
      }

      // Play audio with callback for second prefetch
      const result = await playAudioBuffer(audioData, () => {
        if (i + 2 < paragraphs.length) {
          prefetchNext(i + 2);
        }
      });

      if (result.stopped || shouldStop) break;
    }

    removeHighlight();

    if (!shouldStop) {
      clearReadingPosition();
      notifyExtension({ action: "complete" });
    }
  } catch (error) {
    removeHighlight();
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("TTS error:", errorMessage, error);
    notifyExtension({ action: "error", text: errorMessage });
  }
}

/**
 * Process and read text
 */
async function readText(
  text: string,
  voice: string,
  speed: number = 1.0
): Promise<void> {
  shouldStop = false;
  isPaused = false;
  playbackSpeed = speed;

  try {
    notifyExtension({
      action: "progress",
      percent: 5,
      text: "Splitting into paragraphs...",
    });

    // Split text into paragraphs locally
    const paragraphs = text
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 10);

    if (shouldStop) return;

    await readParagraphsFromIndex(paragraphs, voice, 0, speed);
  } catch (error) {
    console.error("TTS error:", error);
    notifyExtension({ action: "error", text: (error as Error).message });
  }
}

/**
 * Stop audio playback
 */
function stopPlayback(): void {
  shouldStop = true;
  isPaused = false;

  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch {
      // Source might already be stopped
    }
    currentAudioSource = null;
  }

  currentAudioBuffer = null;
  audioStartTime = 0;
  audioPauseTime = 0;

  removeHighlight();
  notifyExtension({ action: "stopped" });
}

/**
 * Pause audio playback
 */
function pausePlayback(): void {
  if (currentAudioSource && !isPaused && audioContext) {
    audioPauseTime = audioContext.currentTime - audioStartTime;

    try {
      currentAudioSource.stop();
    } catch {
      // Source might already be stopped
    }
    currentAudioSource = null;

    isPaused = true;
    notifyExtension({ action: "paused" });
  }
}

/**
 * Resume audio playback
 */
async function resumePlayback(): Promise<void> {
  if (isPaused && currentAudioBuffer && audioContext) {
    try {
      const source = audioContext.createBufferSource();
      source.buffer = currentAudioBuffer;
      source.playbackRate.value = playbackSpeed;
      source.connect(audioContext.destination);

      currentAudioSource = source;

      const offset = audioPauseTime * playbackSpeed;
      audioStartTime = audioContext.currentTime - audioPauseTime;

      source.start(0, offset);

      isPaused = false;
      notifyExtension({ action: "resumed" });
    } catch (error) {
      console.error("Resume playback error:", error);
      notifyExtension({ action: "error", text: "Failed to resume playback" });
    }
  }
}

/**
 * Stop selection reading
 */
function stopSelectionReading(): void {
  isReadingSelection = false;

  if (selectionAudioSource) {
    try {
      selectionAudioSource.stop();
    } catch {
      // Source might already be stopped
    }
    selectionAudioSource = null;
  }
}

/**
 * Speak selected text
 */
async function speakSelection(voice: string, speed: number): Promise<void> {
  try {
    const selectedText = window.getSelection()?.toString().trim();

    if (!selectedText) {
      alert("No text selected");
      return;
    }

    stopSelectionReading();
    isReadingSelection = true;

    const audioData = await synthesizeParagraph(selectedText, voice);

    if (!isReadingSelection) return;

    const context = getSelectionAudioContext();

    if (context.state === "suspended") {
      await context.resume();
    }

    const audioBuffer = await context.decodeAudioData(audioData.slice(0));

    if (!isReadingSelection) return;

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = speed;
    source.connect(context.destination);

    selectionAudioSource = source;

    source.onended = () => {
      selectionAudioSource = null;
      isReadingSelection = false;
    };

    source.start(0);
  } catch (error) {
    isReadingSelection = false;
    selectionAudioSource = null;
    console.error("Error speaking selection:", error);
    alert("Error: " + (error as Error).message);
  }
}

/**
 * Listen for messages from popup or background
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case "extractContent": {
      try {
        const text = extractMainContent();
        const title = getPageTitle();
        const fullText = title ? `${title}. ${text}` : text;

        sendResponse({
          success: true,
          text: fullText,
          title,
          url: window.location.href,
          length: fullText.length,
        });
      } catch (error) {
        console.error("Error extracting content:", error);
        sendResponse({
          success: false,
          error: (error as Error).message,
        });
      }
      break;
    }

    case "scanElements": {
      try {
        readableElements = extractReadableElements();
        const paragraphs = readableElements.map((item, index) => ({
          text: item.text,
          elementIndex: index,
        }));

        sendResponse({
          success: true,
          paragraphs,
          count: paragraphs.length,
        });
      } catch (error) {
        console.error("Error scanning elements:", error);
        sendResponse({
          success: false,
          error: (error as Error).message,
        });
      }
      break;
    }

    case "readText":
      readText(message.text, message.voice, message.speed || 1.0);
      sendResponse({ status: "started" });
      break;

    case "readParagraphs": {
      const useHighlighting =
        message.paragraphs.length > 0 &&
        typeof message.paragraphs[0] === "object" &&
        message.paragraphs[0].elementIndex !== undefined;
      readParagraphsFromIndex(
        message.paragraphs,
        message.voice,
        message.startIndex || 0,
        message.speed || 1.0,
        useHighlighting
      );
      sendResponse({ status: "started" });
      break;
    }

    case "stop":
      stopPlayback();
      sendResponse({ status: "stopped" });
      break;

    case "pause":
      pausePlayback();
      sendResponse({ status: "paused" });
      break;

    case "resume":
      resumePlayback();
      sendResponse({ status: "resumed" });
      break;

    case "setSpeed":
      playbackSpeed = message.speed;
      if (currentAudioSource) {
        currentAudioSource.playbackRate.value = playbackSpeed;
      }
      sendResponse({ status: "speed_set", speed: playbackSpeed });
      break;

    case "getPlaybackState":
      sendResponse({
        isPlaying: currentAudioSource !== null && !isPaused,
        isPaused,
        isStopped: currentAudioSource === null,
      });
      break;

    case "getSavedPosition": {
      const url = getNormalizedUrl();
      chrome.storage.local.get("readingPositions", (result) => {
        const positions = (result.readingPositions as Record<string, unknown>) || {};
        sendResponse(positions[url] || null);
      });
      return true; // Async response
    }

    case "clearSavedPosition":
      clearReadingPosition();
      sendResponse({ status: "cleared" });
      break;

    case "speakSelection":
      speakSelection(message.voice, message.speed);
      sendResponse({ status: "started" });
      break;
  }

  return true;
});

console.log("Pocket Reader content script loaded");
