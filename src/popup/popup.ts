/**
 * Pocket Reader - Popup Script
 * Handles UI interactions and communication with background/content scripts
 */

// DOM Elements
const modelStatus = document.getElementById("model-status")!;
const downloadSection = document.getElementById("download-section")!;
const mainControls = document.getElementById("main-controls")!;
const btnDownload = document.getElementById("btn-download")!;
const downloadProgress = document.getElementById("download-progress")!;
const downloadFill = document.getElementById("download-fill")!;
const downloadText = document.getElementById("download-text")!;
const voiceSelect = document.getElementById("voice-select") as HTMLSelectElement;
const speedControl = document.getElementById("speed-control") as HTMLInputElement;
const speedValue = document.getElementById("speed-value")!;
const startPosition = document.getElementById("start-position") as HTMLSelectElement;
const readingTimeEl = document.getElementById("reading-time")!;
const readingTimeValue = document.getElementById("reading-time-value")!;
const btnScan = document.getElementById("btn-scan")!;
const btnRead = document.getElementById("btn-read")!;
const btnPause = document.getElementById("btn-pause")!;
const btnStop = document.getElementById("btn-stop")!;
const progressContainer = document.getElementById("progress-container")!;
const progressFill = document.getElementById("progress-fill")!;
const progressText = document.getElementById("progress-text")!;
const messageEl = document.getElementById("message")!;

// State
let isPlaying = false;
let isPaused = false;
let modelReady = false;
let currentTabId: number | null = null;
let scannedParagraphs: Array<{ text: string; elementIndex: number }> = [];

/**
 * Initialize popup
 */
async function init(): Promise<void> {
  // Load saved preferences
  const { voice, speed } = await chrome.storage.local.get(["voice", "speed"]);
  if (voice) {
    voiceSelect.value = voice;
  }
  if (speed) {
    speedControl.value = String(speed);
    speedValue.textContent = `${speed}x`;
  }

  // Check model status
  await checkModelStatus();

  // Set up event listeners
  voiceSelect.addEventListener("change", saveVoicePreference);
  speedControl.addEventListener("input", handleSpeedChange);
  startPosition.addEventListener("change", updateReadingTimeDisplay);
  btnDownload.addEventListener("click", handleDownload);
  btnScan.addEventListener("click", handleScan);
  btnRead.addEventListener("click", handleRead);
  btnPause.addEventListener("click", handlePause);
  btnStop.addEventListener("click", handleStop);

  // Listen for messages from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  // Check current playback state
  const { playing } = await chrome.storage.local.get("playing");
  if (playing) {
    setPlayingState(true);
  }
}

/**
 * Check if model is downloaded/loaded
 */
async function checkModelStatus(): Promise<void> {
  try {
    setModelStatus("checking", "Checking model...");

    const response = await chrome.runtime.sendMessage({
      action: "checkModelStatus",
    });

    if (response.error) {
      throw new Error(response.error);
    }

    if (response.cached || response.loaded) {
      setModelStatus("ready", "Model ready");
      modelReady = true;
      downloadSection.classList.add("hidden");
      mainControls.classList.remove("hidden");
      btnRead.disabled = false;
      btnScan.disabled = false;

      // Auto-scan on open
      handleScan();
    } else {
      setModelStatus("error", "Model not downloaded");
      downloadSection.classList.remove("hidden");
      mainControls.classList.add("hidden");
    }
  } catch (error) {
    console.error("Error checking model status:", error);
    setModelStatus("error", "Error checking model");
    downloadSection.classList.remove("hidden");
    mainControls.classList.add("hidden");
  }
}

/**
 * Update model status indicator
 */
function setModelStatus(status: string, text: string): void {
  modelStatus.className = `status status-${status}`;
  modelStatus.querySelector(".status-text")!.textContent = text;
}

/**
 * Handle model download
 */
async function handleDownload(): Promise<void> {
  try {
    btnDownload.disabled = true;
    downloadProgress.classList.remove("hidden");
    setModelStatus("downloading", "Downloading...");

    await chrome.runtime.sendMessage({ action: "downloadModel" });

    // Status will be updated by background messages
  } catch (error) {
    console.error("Error downloading model:", error);
    showMessage("error", "Failed to download model");
    btnDownload.disabled = false;
    downloadProgress.classList.add("hidden");
    setModelStatus("error", "Download failed");
  }
}

/**
 * Handle messages from background script
 */
function handleBackgroundMessage(message: Record<string, unknown>): void {
  switch (message.action) {
    case "downloadProgress": {
      const loaded = message.loaded as number;
      const total = message.total as number;
      const name = message.name as string;
      const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
      downloadFill.style.width = `${percent}%`;
      const mb = (loaded / 1024 / 1024).toFixed(1);
      const totalMb = total > 0 ? (total / 1024 / 1024).toFixed(1) : "?";
      downloadText.textContent = `${name}: ${mb}MB / ${totalMb}MB`;
      break;
    }

    case "modelStatus": {
      const status = message.status as string;
      if (status === "ready") {
        setModelStatus("ready", "Model ready");
        modelReady = true;
        downloadSection.classList.add("hidden");
        mainControls.classList.remove("hidden");
        btnRead.disabled = false;
        btnScan.disabled = false;
        handleScan();
      } else if (status === "loading") {
        setModelStatus("downloading", `Loading ${message.name}...`);
      } else if (status === "downloading") {
        setModelStatus("downloading", `Downloading ${message.name}...`);
      }
      break;
    }

    case "synthesisProgress": {
      const step = message.step as number;
      const total = message.total as number;
      const percent = message.percent as number;
      updateProgress(percent, `Generating audio... (${step}/${total})`);
      break;
    }

    case "progress":
      updateProgress(message.percent as number, message.text as string);
      break;

    case "playing":
      setPlayingState(true);
      if (message.total && (message.total as number) > 1) {
        updateProgress(
          10 + Math.floor(((message.current as number) / (message.total as number)) * 80),
          `Playing ${message.current}/${message.total}...`
        );
      } else {
        updateProgress(100, "Playing audio...");
      }
      break;

    case "stopped":
      setPlayingState(false);
      setPausedState(false);
      progressContainer.classList.add("hidden");
      break;

    case "paused":
      setPausedState(true);
      break;

    case "resumed":
      setPausedState(false);
      break;

    case "error":
      showMessage("error", message.text as string);
      setPlayingState(false);
      break;

    case "complete":
      setPlayingState(false);
      progressContainer.classList.add("hidden");
      showMessage("success", "Finished reading");
      break;
  }
}

/**
 * Save voice preference
 */
function saveVoicePreference(): void {
  chrome.storage.local.set({ voice: voiceSelect.value });
}

/**
 * Handle speed change
 */
function handleSpeedChange(): void {
  const speed = parseFloat(speedControl.value);
  speedValue.textContent = `${speed.toFixed(1)}x`;
  chrome.storage.local.set({ speed });

  updateReadingTimeDisplay();

  if (currentTabId && isPlaying) {
    chrome.tabs
      .sendMessage(currentTabId, { action: "setSpeed", speed })
      .catch(() => {});
  }
}

/**
 * Truncate text for display
 */
function truncateText(text: string, maxLength: number = 50): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Estimate reading time
 */
function estimateReadingTime(
  paragraphs: Array<{ text: string }>,
  speed: number = 1.0
): string {
  const totalText = paragraphs.map((p) => p.text).join(" ");
  const wordCount = totalText.split(/\s+/).filter((w) => w.length > 0).length;
  const wordsPerMinute = 150 * speed;
  const minutes = wordCount / wordsPerMinute;

  if (minutes < 1) {
    return "Less than 1 min";
  } else if (minutes < 60) {
    return `~${Math.round(minutes)} min`;
  } else {
    const hours = Math.floor(minutes / 60);
    const remainingMins = Math.round(minutes % 60);
    return `~${hours}h ${remainingMins}m`;
  }
}

/**
 * Update reading time display
 */
function updateReadingTimeDisplay(): void {
  if (scannedParagraphs.length === 0) {
    readingTimeEl.classList.add("hidden");
    return;
  }

  const startIndex = parseInt(startPosition.value, 10) || 0;
  const remainingParagraphs = scannedParagraphs.slice(startIndex);
  const speed = parseFloat(speedControl.value);
  const timeEstimate = estimateReadingTime(remainingParagraphs, speed);

  readingTimeValue.textContent = `Est. reading time: ${timeEstimate}`;
  readingTimeEl.classList.remove("hidden");
}

/**
 * Handle Scan button click
 */
async function handleScan(): Promise<void> {
  if (!modelReady) {
    showMessage("error", "Model not ready");
    return;
  }

  try {
    btnScan.disabled = true;
    btnScan.textContent = "Scanning...";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found");
    }

    currentTabId = tab.id;

    const response = await new Promise<{
      success: boolean;
      paragraphs?: Array<{ text: string; elementIndex: number }>;
      error?: string;
    }>((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id!, { action: "scanElements" }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error("Could not access page"));
        } else {
          resolve(resp);
        }
      });
    });

    if (!response?.success) {
      throw new Error(response?.error || "Could not scan page content");
    }

    scannedParagraphs = response.paragraphs || [];

    // Populate dropdown
    startPosition.innerHTML = "";
    scannedParagraphs.forEach((para, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${index + 1}. ${truncateText(para.text)}`;
      startPosition.appendChild(option);
    });

    startPosition.disabled = false;
    updateReadingTimeDisplay();
    showMessage("success", `Found ${scannedParagraphs.length} paragraphs`);

    // Check for saved position
    try {
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

      if (
        savedPosition?.index &&
        savedPosition.index > 0 &&
        savedPosition.index < scannedParagraphs.length
      ) {
        startPosition.value = String(savedPosition.index);
        showMessage("info", `Resuming from paragraph ${savedPosition.index + 1}`);
      }
    } catch {
      // Ignore errors getting saved position
    }
  } catch (error) {
    console.error("Scan error:", error);
    showMessage("error", (error as Error).message);
  } finally {
    btnScan.disabled = false;
    btnScan.textContent = "Scan";
  }
}

/**
 * Handle Read button click
 */
async function handleRead(): Promise<void> {
  if (!modelReady) {
    showMessage("error", "Model not ready");
    return;
  }

  hideMessage();
  setPlayingState(true);
  updateProgress(0, "Starting...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throw new Error("No active tab found");
    }

    currentTabId = tab.id;

    const startIndex = parseInt(startPosition.value, 10) || 0;

    if (scannedParagraphs.length > 0) {
      const voice = voiceSelect.value;
      const speed = parseFloat(speedControl.value);
      chrome.tabs.sendMessage(tab.id, {
        action: "readParagraphs",
        paragraphs: scannedParagraphs,
        startIndex,
        voice,
        speed,
      });
    } else {
      // Extract and read from beginning
      chrome.tabs.sendMessage(
        tab.id,
        { action: "extractContent" },
        (response) => {
          if (chrome.runtime.lastError) {
            showMessage("error", "Could not access page content");
            setPlayingState(false);
            return;
          }

          if (!response?.text) {
            showMessage("error", "Could not extract page content");
            setPlayingState(false);
            return;
          }

          const voice = voiceSelect.value;
          const speed = parseFloat(speedControl.value);
          chrome.tabs.sendMessage(tab.id!, {
            action: "readText",
            text: response.text,
            voice,
            speed,
          });
        }
      );
    }
  } catch (error) {
    console.error("Error starting read:", error);
    showMessage("error", (error as Error).message);
    setPlayingState(false);
  }
}

/**
 * Handle Pause/Resume button click
 */
function handlePause(): void {
  if (!currentTabId) return;

  if (isPaused) {
    chrome.tabs.sendMessage(currentTabId, { action: "resume" }).catch(() => {});
    setPausedState(false);
  } else {
    chrome.tabs.sendMessage(currentTabId, { action: "pause" }).catch(() => {});
    setPausedState(true);
  }
}

/**
 * Handle Stop button click
 */
function handleStop(): void {
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { action: "stop" }).catch(() => {});
  }
  setPlayingState(false);
  setPausedState(false);
  hideMessage();
  progressContainer.classList.add("hidden");
}

/**
 * Update playing state UI
 */
function setPlayingState(playing: boolean): void {
  isPlaying = playing;
  btnRead.disabled = playing || !modelReady;
  btnPause.disabled = !playing;
  btnStop.disabled = !playing;
  btnScan.disabled = playing;
  startPosition.disabled = playing || scannedParagraphs.length === 0;

  if (playing) {
    progressContainer.classList.remove("hidden");
  }

  chrome.storage.local.set({ playing });
}

/**
 * Update paused state UI
 */
function setPausedState(paused: boolean): void {
  isPaused = paused;
  const pauseIcon = btnPause.querySelector(".icon")!;
  const pauseTextNode = btnPause.childNodes[btnPause.childNodes.length - 1];

  if (paused) {
    pauseIcon.className = "icon icon-play";
    pauseTextNode.textContent = "Resume";
  } else {
    pauseIcon.className = "icon icon-pause";
    pauseTextNode.textContent = "Pause";
  }
}

/**
 * Update progress bar
 */
function updateProgress(percent: number, text: string): void {
  progressContainer.classList.remove("hidden");
  progressFill.style.width = `${percent}%`;
  progressText.textContent = text;
}

/**
 * Show message
 */
function showMessage(type: string, text: string): void {
  messageEl.className = `message ${type}`;
  messageEl.textContent = text;
  messageEl.classList.remove("hidden");
}

/**
 * Hide message
 */
function hideMessage(): void {
  messageEl.classList.add("hidden");
}

// Initialize on load
document.addEventListener("DOMContentLoaded", init);
