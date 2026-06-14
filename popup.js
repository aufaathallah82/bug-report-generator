const RECORDING_STATE_KEY = "bugReportGenerator.recordingState";

const elements = {
  startRecordingBtn: document.getElementById("startRecordingBtn"),
  stopRecordingBtn: document.getElementById("stopRecordingBtn"),
  clearSessionBtn: document.getElementById("clearSessionBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  exportMarkdownBtn: document.getElementById("exportMarkdownBtn"),
  captureScreenshotBtn: document.getElementById("captureScreenshotBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  status: document.getElementById("status"),
  recordingPill: document.getElementById("recordingPill"),
  currentUrl: document.getElementById("currentUrl"),
  actionCount: document.getElementById("actionCount"),
  consoleErrorCount: document.getElementById("consoleErrorCount"),
  networkErrorCount: document.getElementById("networkErrorCount"),
  screenshotCount: document.getElementById("screenshotCount"),
  sessionId: document.getElementById("sessionId"),
  recentActions: document.getElementById("recentActions")
};

let isBusy = false;
let latestSession = null;

elements.startRecordingBtn.addEventListener("click", () => runCommand("START_BUG_RECORDING", "Recording started."));
elements.stopRecordingBtn.addEventListener("click", () => runCommand("STOP_RECORDING", "Recording stopped."));
elements.clearSessionBtn.addEventListener("click", () => runCommand("CLEAR_SESSION", "Session cleared."));
elements.captureScreenshotBtn.addEventListener("click", () =>
  runCommand("CAPTURE_SCREENSHOT", "Screenshot captured.", { reason: "manual" })
);
elements.exportJsonBtn.addEventListener("click", () => runExport("EXPORT_JSON"));
elements.exportMarkdownBtn.addEventListener("click", () => runExport("EXPORT_MARKDOWN"));
elements.refreshBtn.addEventListener("click", () => loadRecordingState("State refreshed."));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[RECORDING_STATE_KEY]) {
    return;
  }

  latestSession = normalizeSession(changes[RECORDING_STATE_KEY].newValue);
  render(latestSession);
});

void loadRecordingState();

async function runCommand(type, successMessage, extra = {}) {
  setBusy(true);
  setStatus("Working...", "muted");

  try {
    const response = await sendRuntimeMessage({ type, ...extra });

    if (!response?.ok) {
      throw new Error(response?.error || "Command failed.");
    }

    latestSession = normalizeSession(response.session) || (await getStoredSession());
    render(latestSession);
    setStatus(successMessage, "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Command failed.", "error");
  } finally {
    setBusy(false);
  }
}

async function runExport(type) {
  setBusy(true);
  setStatus(type === "EXPORT_JSON" ? "Exporting JSON..." : "Exporting Markdown...", "muted");

  try {
    const response = await sendRuntimeMessage({ type });

    if (!response?.ok) {
      throw new Error(response?.error || "Export failed.");
    }

    await loadRecordingState(`${response.filename} exported.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Export failed.", "error");
  } finally {
    setBusy(false);
  }
}

async function loadRecordingState(successMessage) {
  setBusy(true);

  try {
    const response = await sendRuntimeMessage({ type: "GET_RECORDING_STATE" });
    latestSession = normalizeSession(response?.session) || (await getStoredSession());
    render(latestSession);
    setStatus(successMessage || (latestSession?.isRecording ? "Recording is active." : "Ready."), "muted");
  } catch (error) {
    latestSession = await getStoredSession();
    render(latestSession);
    setStatus(error instanceof Error ? error.message : "Unable to load recording state.", "error");
  } finally {
    setBusy(false);
  }
}

async function getStoredSession() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [RECORDING_STATE_KEY]: null }, (items) => {
      resolve(normalizeSession(items[RECORDING_STATE_KEY]));
    });
  });
}

async function getActiveTabUrl() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.url || "-");
    });
  });
}

function render(session) {
  const isRecording = session?.isRecording === true || session?.contentIsRecording === true;
  const statusText = isRecording ? "Recording" : session ? "Stopped" : "Idle";
  const consoleErrorCount =
    (session?.consoleErrors?.length || 0) +
    (session?.javascriptErrors?.length || 0) +
    (session?.promiseRejections?.length || 0);

  elements.recordingPill.textContent = statusText;
  elements.recordingPill.dataset.state = isRecording ? "recording" : session ? "stopped" : "idle";
  elements.actionCount.textContent = String(session?.recordedActions?.length || 0);
  elements.consoleErrorCount.textContent = String(consoleErrorCount);
  elements.networkErrorCount.textContent = String(session?.networkErrors?.length || 0);
  elements.screenshotCount.textContent = String(session?.screenshots?.length || 0);
  elements.sessionId.textContent = session?.sessionId ? shorten(session.sessionId) : "-";

  if (session?.currentUrl) {
    elements.currentUrl.textContent = session.currentUrl;
    elements.currentUrl.title = session.currentUrl;
  } else {
    void getActiveTabUrl().then((url) => {
      elements.currentUrl.textContent = url;
      elements.currentUrl.title = url;
    });
  }

  renderRecentActions(session?.recordedActions || []);
  updateButtons(isRecording, Boolean(session));
}

function renderRecentActions(actions) {
  const recent = actions.slice(-8);

  if (!recent.length) {
    elements.recentActions.innerHTML = "<li>No actions recorded yet.</li>";
    return;
  }

  elements.recentActions.innerHTML = recent
    .map((action) => {
      const best = action.locators?.best;
      const locator = best ? ` <code>${escapeHtml(best.strategy)}: ${escapeHtml(best.value)}</code>` : "";
      return `<li>${escapeHtml(action.description || action.text || action.type)}${locator}</li>`;
    })
    .join("");
}

function updateButtons(isRecording, hasSession) {
  elements.startRecordingBtn.disabled = isBusy || isRecording;
  elements.stopRecordingBtn.disabled = isBusy || !isRecording;
  elements.captureScreenshotBtn.disabled = isBusy || !hasSession;
  elements.exportJsonBtn.disabled = isBusy || !hasSession;
  elements.exportMarkdownBtn.disabled = isBusy || !hasSession;
  elements.clearSessionBtn.disabled = isBusy || !hasSession;
  elements.refreshBtn.disabled = isBusy;
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  updateButtons(latestSession?.isRecording === true || latestSession?.contentIsRecording === true, Boolean(latestSession));
}

function setStatus(message, tone) {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

function normalizeSession(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    ...value,
    recordedActions: Array.isArray(value.recordedActions) ? value.recordedActions : [],
    consoleWarnings: Array.isArray(value.consoleWarnings) ? value.consoleWarnings : [],
    consoleErrors: Array.isArray(value.consoleErrors) ? value.consoleErrors : [],
    javascriptErrors: Array.isArray(value.javascriptErrors) ? value.javascriptErrors : [],
    promiseRejections: Array.isArray(value.promiseRejections) ? value.promiseRejections : [],
    networkErrors: Array.isArray(value.networkErrors) ? value.networkErrors : [],
    screenshots: Array.isArray(value.screenshots) ? value.screenshots : []
  };
}

function shorten(value) {
  return value.length > 10 ? `${value.slice(0, 8)}...` : value;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    };

    return entities[character];
  });
}
