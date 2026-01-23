/**
 * Pocket Reader - Background Service Worker
 * Coordinates between popup and content scripts
 * Handles keyboard shortcuts
 */

// State tracking
let activeTabId = null;

/**
 * Forward stop command to the active tab's content script
 */
function stopPlayback() {
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'stop' }).catch(() => {
      // Tab might be closed, ignore
    });
  }
}

/**
 * Handle keyboard commands
 */
chrome.commands.onCommand.addListener(async (command) => {
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'toggle-playback') {
    // First check if we're currently playing
    try {
      const state = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'getPlaybackState' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      });

      if (state && state.isPlaying) {
        // Currently playing, pause it
        chrome.tabs.sendMessage(tab.id, { action: 'pause' });
      } else if (state && state.isPaused) {
        // Currently paused, resume it
        chrome.tabs.sendMessage(tab.id, { action: 'resume' });
      } else {
        // Not playing, start reading
        await startReadingFromShortcut(tab);
      }
    } catch (error) {
      console.error('Error handling toggle-playback:', error);
    }
  } else if (command === 'stop-playback') {
    chrome.tabs.sendMessage(tab.id, { action: 'stop' }).catch(() => {});
    activeTabId = null;
  }
});

/**
 * Start reading the current page from a keyboard shortcut
 */
async function startReadingFromShortcut(tab) {
  try {
    // Ensure content script is loaded
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (e) {
      // Script might already be loaded
    }

    // Scan for readable elements (with DOM references for highlighting)
    const response = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { action: 'scanElements' }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error('Could not access page'));
        } else {
          resolve(resp);
        }
      });
    });

    if (!response || !response.success || !response.paragraphs) {
      console.error('Could not scan page content');
      return;
    }

    const paragraphs = response.paragraphs;

    // Get saved preferences
    const { voice, speed } = await chrome.storage.local.get(['voice', 'speed']);

    // Check for saved position
    const savedPosition = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getSavedPosition' }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(resp);
        }
      });
    });

    const startIndex = (savedPosition && savedPosition.index > 0 && savedPosition.index < paragraphs.length) 
      ? savedPosition.index 
      : 0;

    // Start reading with highlighting enabled
    activeTabId = tab.id;
    chrome.tabs.sendMessage(tab.id, {
      action: 'readParagraphs',
      paragraphs: paragraphs,
      startIndex: startIndex,
      voice: voice || 'alba',
      speed: speed || 1.0
    });

  } catch (error) {
    console.error('Error starting reading from shortcut:', error);
  }
}

/**
 * Handle messages from popup and TTS worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // If message is from content script, forward to popup
  if (sender.tab) {
    // Message from content script - forward to popup
    // The popup listens directly via chrome.runtime.onMessage
    return;
  }

  // If message is from TTS worker (has targetInstance), relay to all tabs
  if (message.targetInstance) {
    // Broadcast to all tabs - the content script will filter by instanceId
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
          // Tab might not have content script, ignore
        });
      }
    });
    return;
  }

  // Message from popup
  switch (message.action) {
    case 'startReading':
      activeTabId = message.tabId;
      // Forward to content script
      chrome.tabs.sendMessage(message.tabId, {
        action: 'readText',
        text: message.text,
        voice: message.voice,
      }).catch((error) => {
        console.error('Error sending to content script:', error);
      });
      sendResponse({ status: 'started' });
      break;

    case 'stop':
      stopPlayback();
      sendResponse({ status: 'stopped' });
      break;
  }

  return true;
});

/**
 * Create context menu for speaking selected text
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'speakSelection',
    title: 'Speak Selection',
    contexts: ['selection']
  });
});

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'speakSelection') {
    try {
      // Ensure content script is loaded
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
      } catch (e) {
        // Script might already be loaded
      }

      // Get saved preferences
      const { voice, speed } = await chrome.storage.local.get(['voice', 'speed']);

      // Send message to content script to speak selection
      chrome.tabs.sendMessage(tab.id, {
        action: 'speakSelection',
        voice: voice || 'alba',
        speed: speed || 1.0
      }).catch((error) => {
        console.error('Error sending speakSelection message:', error);
      });
    } catch (error) {
      console.error('Error handling context menu click:', error);
    }
  }
});

// Log service worker start
console.log('Pocket Reader background service worker started');
