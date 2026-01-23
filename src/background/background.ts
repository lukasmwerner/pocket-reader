/**
 * Pocket Reader - Background Service Worker
 * Manages offscreen document lifecycle and coordinates between popup/content scripts
 */

// Track offscreen document state
let offscreenDocumentCreated = false;
let activeTabId: number | null = null;

// Request ID counter for tracking async operations
let requestIdCounter = 0;
function generateRequestId(): string {
  return `req-${Date.now()}-${++requestIdCounter}`;
}

/**
 * Create offscreen document for TTS
 */
async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenDocumentCreated) return;

  // Check if already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL("src/offscreen/offscreen.html")],
  });

  if (existingContexts.length > 0) {
    offscreenDocumentCreated = true;
    return;
  }

  // Create new offscreen document
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL("src/offscreen/offscreen.html"),
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: "WebGPU TTS inference and audio generation",
  });

  offscreenDocumentCreated = true;
  console.log("Offscreen document created");
}

/**
 * Send message to offscreen document
 */
async function sendToOffscreen(
  message: Record<string, unknown>
): Promise<unknown> {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message);
}

/**
 * Forward stop command to the active tab's content script
 */
function stopPlayback(): void {
  if (activeTabId) {
    chrome.tabs
      .sendMessage(activeTabId, { action: "stop" })
      .catch(() => {
        // Tab might be closed, ignore
      });
  }
}

/**
 * Handle keyboard commands
 */
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "toggle-playback") {
    try {
      const state = await new Promise<{
        isPlaying: boolean;
        isPaused: boolean;
      } | null>((resolve) => {
        chrome.tabs.sendMessage(
          tab.id!,
          { action: "getPlaybackState" },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve(null);
            } else {
              resolve(response);
            }
          }
        );
      });

      if (state?.isPlaying) {
        chrome.tabs.sendMessage(tab.id, { action: "pause" });
      } else if (state?.isPaused) {
        chrome.tabs.sendMessage(tab.id, { action: "resume" });
      } else {
        await startReadingFromShortcut(tab);
      }
    } catch (error) {
      console.error("Error handling toggle-playback:", error);
    }
  } else if (command === "stop-playback") {
    chrome.tabs.sendMessage(tab.id, { action: "stop" }).catch(() => {});
    activeTabId = null;
  }
});

/**
 * Start reading the current page from a keyboard shortcut
 */
async function startReadingFromShortcut(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return;

  try {
    // Scan for readable elements
    const response = await new Promise<{
      success: boolean;
      paragraphs?: Array<{ text: string; elementIndex: number }>;
    }>((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id!, { action: "scanElements" }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error("Could not access page"));
        } else {
          resolve(resp);
        }
      });
    });

    if (!response?.success || !response.paragraphs) {
      console.error("Could not scan page content");
      return;
    }

    const paragraphs = response.paragraphs;

    // Get saved preferences
    const { voice, speed } = await chrome.storage.local.get(["voice", "speed"]);

    // Check for saved position
    const savedPosition = await new Promise<{ index: number } | null>(
      (resolve) => {
        chrome.tabs.sendMessage(
          tab.id!,
          { action: "getSavedPosition" },
          (resp) => {
            if (chrome.runtime.lastError) {
              resolve(null);
            } else {
              resolve(resp);
            }
          }
        );
      }
    );

    const startIndex =
      savedPosition?.index && savedPosition.index < paragraphs.length
        ? savedPosition.index
        : 0;

    // Start reading
    activeTabId = tab.id;
    chrome.tabs.sendMessage(tab.id, {
      action: "readParagraphs",
      paragraphs,
      startIndex,
      voice: voice || "alba",
      speed: speed || 1.0,
    });
  } catch (error) {
    console.error("Error starting reading from shortcut:", error);
  }
}

/**
 * Handle messages from popup and content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages from offscreen document (progress updates)
  if (
    message.action === "downloadProgress" ||
    message.action === "synthesisProgress" ||
    message.action === "modelStatus"
  ) {
    // Forward to popup if it's open
    chrome.runtime
      .sendMessage(message)
      .catch(() => {
        // Popup might be closed
      });
    return;
  }

  // Messages from content script
  if (sender.tab) {
    // Forward to popup
    return;
  }

  // Messages from popup
  const handleAsync = async () => {
    try {
      switch (message.action) {
        case "checkModelStatus": {
          const result = await sendToOffscreen({ action: "checkModelStatus" });
          return result;
        }

        case "downloadModel": {
          const requestId = generateRequestId();
          const result = await sendToOffscreen({
            action: "downloadModel",
            requestId,
          });
          return result;
        }

        case "synthesize": {
          const requestId = generateRequestId();
          const result = await sendToOffscreen({
            action: "synthesize",
            text: message.text,
            voice: message.voice,
            requestId,
          });
          return result;
        }

        case "preloadVoice": {
          const requestId = generateRequestId();
          const result = await sendToOffscreen({
            action: "preloadVoice",
            voice: message.voice,
            requestId,
          });
          return result;
        }

        case "startReading":
          activeTabId = message.tabId;
          chrome.tabs
            .sendMessage(message.tabId, {
              action: "readText",
              text: message.text,
              voice: message.voice,
            })
            .catch((error) => {
              console.error("Error sending to content script:", error);
            });
          return { status: "started" };

        case "stop":
          stopPlayback();
          return { status: "stopped" };

        default:
          return { error: `Unknown action: ${message.action}` };
      }
    } catch (error) {
      console.error("Background error:", error);
      return { error: (error as Error).message };
    }
  };

  handleAsync().then(sendResponse);
  return true;
});

/**
 * Create context menu for speaking selected text
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "speakSelection",
    title: "Speak Selection",
    contexts: ["selection"],
  });
});

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "speakSelection" && tab?.id) {
    try {
      // Get saved preferences
      const { voice, speed } = await chrome.storage.local.get([
        "voice",
        "speed",
      ]);

      // Send message to content script to speak selection
      chrome.tabs
        .sendMessage(tab.id, {
          action: "speakSelection",
          voice: voice || "alba",
          speed: speed || 1.0,
        })
        .catch((error) => {
          console.error("Error sending speakSelection message:", error);
        });
    } catch (error) {
      console.error("Error handling context menu click:", error);
    }
  }
});

console.log("Pocket Reader background service worker started");
