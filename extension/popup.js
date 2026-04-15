/**
 * Pocket Reader - Popup Script
 * Handles UI interactions and communication with content script
 */

const SERVER_URL = 'http://localhost:5050';

// DOM Elements
const serverStatus = document.getElementById('server-status');
const voiceSelect = document.getElementById('voice-select');
const speedControl = document.getElementById('speed-control');
const speedValue = document.getElementById('speed-value');
const startPosition = document.getElementById('start-position');
const readingTimeEl = document.getElementById('reading-time');
const readingTimeValue = document.getElementById('reading-time-value');
const btnScan = document.getElementById('btn-scan');
const btnRead = document.getElementById('btn-read');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const messageEl = document.getElementById('message');

// State
let isPlaying = false;
let isPaused = false;
let serverConnected = false;
let currentTabId = null;
let scannedParagraphs = [];

/**
 * Initialize popup
 */
async function init() {
  const { voice, speed } = await chrome.storage.local.get(['voice', 'speed']);
  if (speed) {
    speedControl.value = speed;
    speedValue.textContent = `${speed}x`;
  }

  // Check server status and populate voices from config
  await checkServerStatus();
  await populateVoices(voice);

  // Set up event listeners
  voiceSelect.addEventListener('change', saveVoicePreference);
  speedControl.addEventListener('input', handleSpeedChange);
  startPosition.addEventListener('change', updateReadingTimeDisplay);
  btnScan.addEventListener('click', handleScan);
  btnRead.addEventListener('click', handleRead);
  btnPause.addEventListener('click', handlePause);
  btnStop.addEventListener('click', handleStop);

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener(handleContentMessage);

  // Check current playback state
  const { playing } = await chrome.storage.local.get('playing');
  if (playing) {
    setPlayingState(true);
  }

  // Auto-scan on open if server is connected
  if (serverConnected) {
    handleScan();
  }
}

/**
 * Check if the TTS server is running
 */
async function checkServerStatus() {
  try {
    const response = await fetch(`${SERVER_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    });

    if (response.ok) {
      setServerStatus('connected', 'Server connected');
      serverConnected = true;
      btnRead.disabled = false;
      btnScan.disabled = false;
    } else {
      throw new Error('Server returned error');
    }
  } catch (error) {
    setServerStatus('disconnected', 'Server offline');
    serverConnected = false;
    btnRead.disabled = true;
    btnScan.disabled = true;
    showMessage('error', 'Server not running. Start it with: uv run server.py');
  }
}

/**
 * Update server status indicator
 */
function setServerStatus(status, text) {
  serverStatus.className = `status status-${status}`;
  serverStatus.querySelector('.status-text').textContent = text;
}

/**
 * Fetch voices from server and populate the dropdown.
 * Falls back to the saved preference once options are built.
 */
async function populateVoices(savedVoice) {
  try {
    const response = await fetch(`${SERVER_URL}/voices`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await response.json();
    const voices = data.voices || [];
    const defaultVoice = data.default || (voices[0] && voices[0].id);

    voiceSelect.innerHTML = '';
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      voiceSelect.appendChild(opt);
    }

    voiceSelect.value = savedVoice && voices.some(v => v.id === savedVoice)
      ? savedVoice
      : defaultVoice;
  } catch {
    // Server offline — leave dropdown empty, user will see disconnected status
  }
}

/**
 * Save voice preference
 */
function saveVoicePreference() {
  chrome.storage.local.set({ voice: voiceSelect.value });
}

/**
 * Handle speed change
 */
function handleSpeedChange() {
  const speed = parseFloat(speedControl.value);
  speedValue.textContent = `${speed.toFixed(1)}x`;
  chrome.storage.local.set({ speed: speed });
  
  // Update reading time estimate
  updateReadingTimeDisplay();
  
  // Update current playback speed if playing
  if (currentTabId && isPlaying) {
    chrome.tabs.sendMessage(currentTabId, { action: 'setSpeed', speed: speed }).catch(() => {});
  }
}

/**
 * Truncate text for display
 */
function truncateText(text, maxLength = 50) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Estimate reading time based on word count
 * Average TTS speed is roughly 150 words per minute at 1.0x speed
 */
function estimateReadingTime(paragraphs, speed = 1.0) {
  // Handle both string arrays and object arrays with {text, elementIndex}
  const getText = (p) => typeof p === 'string' ? p : p.text;
  const totalText = paragraphs.map(getText).join(' ');
  const wordCount = totalText.split(/\s+/).filter(w => w.length > 0).length;
  const wordsPerMinute = 150 * speed;
  const minutes = wordCount / wordsPerMinute;
  
  if (minutes < 1) {
    return 'Less than 1 min';
  } else if (minutes < 60) {
    return `~${Math.round(minutes)} min`;
  } else {
    const hours = Math.floor(minutes / 60);
    const remainingMins = Math.round(minutes % 60);
    return `~${hours}h ${remainingMins}m`;
  }
}

/**
 * Update the reading time display based on current start position
 */
function updateReadingTimeDisplay() {
  if (scannedParagraphs.length === 0) {
    readingTimeEl.classList.add('hidden');
    return;
  }
  
  const startIndex = parseInt(startPosition.value, 10) || 0;
  const remainingParagraphs = scannedParagraphs.slice(startIndex);
  const speed = parseFloat(speedControl.value);
  const timeEstimate = estimateReadingTime(remainingParagraphs, speed);
  
  readingTimeValue.textContent = `Est. reading time: ${timeEstimate}`;
  readingTimeEl.classList.remove('hidden');
}

/**
 * Handle Scan button click - extract and show paragraphs
 */
async function handleScan() {
  if (!serverConnected) {
    showMessage('error', 'Server not connected');
    return;
  }

  try {
    btnScan.disabled = true;
    btnScan.textContent = 'Scanning...';

    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      throw new Error('No active tab found');
    }

    currentTabId = tab.id;

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

    if (!response || !response.success) {
      throw new Error(response?.error || 'Could not scan page content');
    }

    // Store paragraphs with element indices for highlighting
    scannedParagraphs = response.paragraphs;

    // Populate the dropdown
    startPosition.innerHTML = '';
    scannedParagraphs.forEach((para, index) => {
      const option = document.createElement('option');
      option.value = index;
      const text = typeof para === 'string' ? para : para.text;
      option.textContent = `${index + 1}. ${truncateText(text)}`;
      startPosition.appendChild(option);
    });

    startPosition.disabled = false;
    updateReadingTimeDisplay();
    showMessage('success', `Found ${scannedParagraphs.length} paragraphs`);

    // Check for saved reading position
    try {
      const savedPosition = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'getSavedPosition' }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      });

      if (savedPosition && savedPosition.index > 0 && savedPosition.index < scannedParagraphs.length) {
        startPosition.value = savedPosition.index;
        showMessage('info', `Resuming from paragraph ${savedPosition.index + 1}`);
      }
    } catch (e) {
      // Ignore errors in getting saved position
    }

  } catch (error) {
    console.error('Scan error:', error);
    showMessage('error', error.message);
  } finally {
    btnScan.disabled = false;
    btnScan.textContent = 'Scan';
  }
}

/**
 * Handle Read button click
 */
async function handleRead() {
  if (!serverConnected) {
    showMessage('error', 'Server not connected');
    return;
  }

  hideMessage();
  setPlayingState(true);
  updateProgress(0, 'Starting...');

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      throw new Error('No active tab found');
    }

    currentTabId = tab.id;

    // Ensure content script is loaded
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (e) {
      // Script might already be loaded
    }

    // Get start index
    const startIndex = parseInt(startPosition.value, 10) || 0;

    // If we have scanned paragraphs, use them directly
    if (scannedParagraphs.length > 0) {
      const voice = voiceSelect.value;
      const speed = parseFloat(speedControl.value);
      chrome.tabs.sendMessage(tab.id, {
        action: 'readParagraphs',
        paragraphs: scannedParagraphs,
        startIndex: startIndex,
        voice: voice,
        speed: speed
      });
    } else {
      // Otherwise extract and read from beginning
      chrome.tabs.sendMessage(tab.id, { action: 'extractContent' }, (response) => {
        if (chrome.runtime.lastError) {
          showMessage('error', 'Could not access page content');
          setPlayingState(false);
          return;
        }

        if (!response || !response.text) {
          showMessage('error', 'Could not extract page content');
          setPlayingState(false);
          return;
        }

        const voice = voiceSelect.value;
        const speed = parseFloat(speedControl.value);
        chrome.tabs.sendMessage(tab.id, {
          action: 'readText',
          text: response.text,
          voice: voice,
          speed: speed
        });
      });
    }
  } catch (error) {
    console.error('Error starting read:', error);
    showMessage('error', error.message);
    setPlayingState(false);
  }
}

/**
 * Handle Pause/Resume button click
 */
function handlePause() {
  if (!currentTabId) return;

  if (isPaused) {
    // Resume playback
    chrome.tabs.sendMessage(currentTabId, { action: 'resume' }).catch(() => {});
    setPausedState(false);
  } else {
    // Pause playback
    chrome.tabs.sendMessage(currentTabId, { action: 'pause' }).catch(() => {});
    setPausedState(true);
  }
}

/**
 * Handle Stop button click
 */
function handleStop() {
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { action: 'stop' }).catch(() => {});
  }
  setPlayingState(false);
  setPausedState(false);
  hideMessage();
  progressContainer.classList.add('hidden');
}

/**
 * Handle messages from content script
 */
function handleContentMessage(message, sender) {
  // Only handle messages from content scripts (they have a tab)
  if (!sender.tab) return;

  switch (message.action) {
    case 'progress':
      updateProgress(message.percent, message.text);
      break;

    case 'playing':
      setPlayingState(true);
      if (message.total && message.total > 1) {
        updateProgress(
          10 + Math.floor((message.current / message.total) * 80),
          `Playing ${message.current}/${message.total}...`
        );
      } else {
        updateProgress(100, 'Playing audio...');
      }
      break;

    case 'stopped':
      setPlayingState(false);
      setPausedState(false);
      progressContainer.classList.add('hidden');
      break;

    case 'paused':
      setPausedState(true);
      break;

    case 'resumed':
      setPausedState(false);
      break;

    case 'error':
      showMessage('error', message.text);
      setPlayingState(false);
      break;

    case 'complete':
      setPlayingState(false);
      progressContainer.classList.add('hidden');
      showMessage('success', 'Finished reading');
      break;
  }
}

/**
 * Update playing state UI
 */
function setPlayingState(playing) {
  isPlaying = playing;
  btnRead.disabled = playing || !serverConnected;
  btnPause.disabled = !playing;
  btnStop.disabled = !playing;
  btnScan.disabled = playing;
  startPosition.disabled = playing || scannedParagraphs.length === 0;

  if (playing) {
    progressContainer.classList.remove('hidden');
  }

  chrome.storage.local.set({ playing: playing });
}

/**
 * Update paused state UI
 */
function setPausedState(paused) {
  isPaused = paused;
  const pauseIcon = btnPause.querySelector('.icon');
  const pauseText = btnPause.childNodes[btnPause.childNodes.length - 1];
  
  if (paused) {
    pauseIcon.className = 'icon icon-play';
    pauseText.textContent = 'Resume';
  } else {
    pauseIcon.className = 'icon icon-pause';
    pauseText.textContent = 'Pause';
  }
}

/**
 * Update progress bar
 */
function updateProgress(percent, text) {
  progressContainer.classList.remove('hidden');
  progressFill.style.width = `${percent}%`;
  progressText.textContent = text;
}

/**
 * Show message
 */
function showMessage(type, text) {
  messageEl.className = `message ${type}`;
  messageEl.textContent = text;
  messageEl.classList.remove('hidden');
}

/**
 * Hide message
 */
function hideMessage() {
  messageEl.classList.add('hidden');
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
