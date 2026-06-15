const RECORDING_STATE_KEY = "bugReportGenerator.recordingState";
const DEFAULT_REPORT_METADATA = {
  bugTitle: "",
  description: "",
  expectedResult: "",
  actualResult: "",
  additionalNotes: ""
};

const elements = {
  startRecordingBtn: document.getElementById("startRecordingBtn"),
  stopRecordingBtn: document.getElementById("stopRecordingBtn"),
  clearSessionBtn: document.getElementById("clearSessionBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  exportMarkdownBtn: document.getElementById("exportMarkdownBtn"),
  exportTxtBtn: document.getElementById("exportTxtBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  status: document.getElementById("status"),
  recordingPill: document.getElementById("recordingPill"),
  currentUrl: document.getElementById("currentUrl"),
  actionCount: document.getElementById("actionCount"),
  consoleErrorCount: document.getElementById("consoleErrorCount"),
  networkErrorCount: document.getElementById("networkErrorCount"),
  screenshotCount: document.getElementById("screenshotCount"),
  sessionId: document.getElementById("sessionId"),
  recentActions: document.getElementById("recentActions"),
  pageTabs: Array.from(document.querySelectorAll(".page-tab")),
  pagePanels: Array.from(document.querySelectorAll("[data-page-panel]")),
  saveReportBtns: Array.from(document.querySelectorAll("[data-action='save-report']")),
  metadataFields: {
    bugTitle: document.getElementById("bugTitle"),
    description: document.getElementById("description"),
    expectedResult: document.getElementById("expectedResult"),
    actualResult: document.getElementById("actualResult"),
    additionalNotes: document.getElementById("additionalNotes")
  },
  envBrowser: document.getElementById("envBrowser"),
  envPlatform: document.getElementById("envPlatform"),
  envScreen: document.getElementById("envScreen"),
  envViewport: document.getElementById("envViewport"),
  envDpr: document.getElementById("envDpr"),
  envLanguage: document.getElementById("envLanguage"),
  envTimestamp: document.getElementById("envTimestamp"),
  envExtensionVersion: document.getElementById("envExtensionVersion"),
  envUserAgent: document.getElementById("envUserAgent"),
  screenshotStatus: document.getElementById("screenshotStatus"),
  screenshotPreview: document.getElementById("screenshotPreview"),
  exportSummary: document.getElementById("exportSummary")
};

let isBusy = false;
let isRendering = false;
let latestSession = null;
let metadataSaveTimer = null;

elements.startRecordingBtn.addEventListener("click", () => runCommand("START_BUG_RECORDING", "Recording started."));
elements.stopRecordingBtn.addEventListener("click", () => runCommand("STOP_RECORDING", "Recording stopped."));
elements.clearSessionBtn.addEventListener("click", () => runCommand("CLEAR_SESSION", "Session cleared."));
elements.exportJsonBtn.addEventListener("click", () => runExport("EXPORT_JSON", "JSON"));
elements.exportMarkdownBtn.addEventListener("click", () => runExport("EXPORT_MARKDOWN", "Markdown"));
elements.exportTxtBtn.addEventListener("click", () => runExport("EXPORT_TXT", "TXT"));
elements.refreshBtn.addEventListener("click", () => loadRecordingState("State refreshed."));

for (const button of elements.saveReportBtns) {
  button.addEventListener("click", () => saveReport());
}

for (const tab of elements.pageTabs) {
  tab.addEventListener("click", () => setPage(tab.dataset.page));
}

for (const field of Object.values(elements.metadataFields)) {
  field.addEventListener("input", scheduleMetadataSave);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[RECORDING_STATE_KEY]) {
    return;
  }

  latestSession = normalizeSession(changes[RECORDING_STATE_KEY].newValue);
  render(latestSession);
});

setPage("recording");
void loadRecordingState();

async function runCommand(type, successMessage) {
  setBusy(true);
  setStatus("Working...", "muted");

  try {
    const response = await sendRuntimeMessage({ type });

    if (!response?.ok) {
      throw new Error(response?.error || "Command failed.");
    }

    latestSession = normalizeSession(response.session) || (await getStoredSession());
    render(latestSession);

    if (response.warning) {
      setStatus(response.warning, "warning");
    } else {
      setStatus(successMessage, "success");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Command failed.", "error");
  } finally {
    setBusy(false);
  }
}

async function saveReport() {
  setBusy(true);
  setStatus("Saving report...", "muted");

  try {
    const response = await sendRuntimeMessage({
      type: "SAVE_REPORT",
      metadata: readMetadataForm()
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Save failed.");
    }

    latestSession = normalizeSession(response.session) || (await getStoredSession());
    render(latestSession);
    setStatus("Report saved locally.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Save failed.", "error");
  } finally {
    setBusy(false);
  }
}

async function runExport(type, label) {
  setBusy(true);
  setStatus(`Exporting ${label}...`, "muted");

  try {
    await flushMetadataSave();
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

function scheduleMetadataSave() {
  if (isRendering || !latestSession) {
    return;
  }

  if (metadataSaveTimer) {
    window.clearTimeout(metadataSaveTimer);
  }

  metadataSaveTimer = window.setTimeout(() => {
    void flushMetadataSave().catch((error) => {
      setStatus(error instanceof Error ? error.message : "Unable to save report fields.", "error");
    });
  }, 350);
}

async function flushMetadataSave() {
  if (metadataSaveTimer) {
    window.clearTimeout(metadataSaveTimer);
    metadataSaveTimer = null;
  }

  if (!latestSession) {
    return;
  }

  const response = await sendRuntimeMessage({
    type: "UPDATE_REPORT_METADATA",
    metadata: readMetadataForm()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to save report fields.");
  }

  latestSession = normalizeSession(response.session) || latestSession;
  render(latestSession);
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
  const consoleErrorCount = getConsoleErrorCount(session);

  elements.recordingPill.textContent = statusText;
  elements.recordingPill.dataset.state = isRecording ? "recording" : session ? "stopped" : "idle";
  elements.actionCount.textContent = String(session?.recordedActions?.length || 0);
  elements.consoleErrorCount.textContent = String(consoleErrorCount);
  elements.networkErrorCount.textContent = String(session?.networkErrors?.length || 0);
  elements.screenshotCount.textContent = String(session?.screenshots?.length || 0);
  elements.sessionId.textContent = session?.sessionId ? shorten(session.sessionId) : "-";

  if (session?.currentUrl) {
    setTextWithTitle(elements.currentUrl, session.currentUrl);
  } else {
    void getActiveTabUrl().then((url) => setTextWithTitle(elements.currentUrl, url));
  }

  renderMetadataForm(session);
  renderEnvironment(session);
  renderRecentActions(session?.recordedActions || []);
  renderScreenshot(session);
  renderExportSummary(session);
  updateButtons(isRecording, Boolean(session));
}

function renderMetadataForm(session) {
  const metadata = normalizeReportMetadata(session?.reportMetadata);
  const isEditingMetadata =
    Boolean(metadataSaveTimer) && Object.values(elements.metadataFields).includes(document.activeElement);

  if (isEditingMetadata) {
    for (const field of Object.values(elements.metadataFields)) {
      field.disabled = !session;
    }

    return;
  }

  isRendering = true;

  for (const [key, field] of Object.entries(elements.metadataFields)) {
    field.value = metadata[key] || "";
    field.disabled = !session;
  }

  isRendering = false;
}

function renderEnvironment(session) {
  const environment = normalizeEnvironment(session?.environment);
  const url = environment.url || session?.currentUrl || "-";

  setTextWithTitle(elements.envBrowser, formatBrowser(environment) || "-");
  setTextWithTitle(elements.envPlatform, environment.osPlatform || environment.platform || "-");
  setTextWithTitle(elements.envScreen, formatScreen(environment.screen));
  setTextWithTitle(elements.envViewport, formatViewport(environment.viewport));
  setTextWithTitle(elements.envDpr, String(environment.devicePixelRatio || environment.viewport?.devicePixelRatio || "-"));
  setTextWithTitle(elements.envLanguage, environment.language || "-");
  setTextWithTitle(elements.envTimestamp, environment.timestamp || environment.capturedAt || "-");
  setTextWithTitle(elements.envExtensionVersion, environment.extensionVersion || chrome.runtime.getManifest().version || "-");
  setTextWithTitle(elements.envUserAgent, environment.userAgent || "-");

  if (!session) {
    setTextWithTitle(elements.envBrowser, "-");
    setTextWithTitle(elements.envPlatform, "-");
    setTextWithTitle(elements.envScreen, "-");
    setTextWithTitle(elements.envViewport, "-");
    setTextWithTitle(elements.envDpr, "-");
    setTextWithTitle(elements.envLanguage, "-");
    setTextWithTitle(elements.envTimestamp, "-");
    setTextWithTitle(elements.envUserAgent, "-");
  }

  elements.currentUrl.dataset.environmentUrl = url;
}

function renderRecentActions(actions) {
  const orderedActions = actions
    .slice()
    .sort((first, second) => (first.step || 0) - (second.step || 0));

  if (!orderedActions.length) {
    elements.recentActions.innerHTML = "<li>No actions recorded yet.</li>";
    return;
  }

  elements.recentActions.innerHTML = orderedActions
    .map((action, index) => {
      const step = Number(action.step) || index + 1;
      const locator = formatLocator(action);

      return `<li value="${step}"><span class="action-text">${escapeHtml(formatActionDescription(action))}</span>${locator}</li>`;
    })
    .join("");
}

function renderScreenshot(session) {
  const screenshots = session?.screenshots || [];
  const latest = screenshots[screenshots.length - 1];

  if (!latest) {
    elements.screenshotStatus.textContent = "No screenshot captured yet.";
    elements.screenshotPreview.hidden = true;
    elements.screenshotPreview.removeAttribute("src");
    return;
  }

  const timestamp = latest.timestamp || "unknown time";
  elements.screenshotStatus.textContent = `${screenshots.length} screenshot(s). Latest captured at ${timestamp}.`;

  if (latest.dataUrl) {
    elements.screenshotPreview.src = latest.dataUrl;
    elements.screenshotPreview.hidden = false;
  } else {
    elements.screenshotPreview.hidden = true;
    elements.screenshotPreview.removeAttribute("src");
  }
}

function renderExportSummary(session) {
  if (!session) {
    elements.exportSummary.innerHTML = '<div class="wide"><dt>Status</dt><dd>No active or saved session.</dd></div>';
    return;
  }

  const metadata = normalizeReportMetadata(session.reportMetadata);
  const consoleErrorCount = getConsoleErrorCount(session);
  const rows = [
    ["Bug Title", metadata.bugTitle || "-"],
    ["Session ID", session.sessionId || "-"],
    ["Status", session.isRecording ? "Recording" : "Stopped"],
    ["Actions", String(session.recordedActions.length)],
    ["Console Errors", String(consoleErrorCount)],
    ["Network Errors", String(session.networkErrors.length)],
    ["Screenshots", String(session.screenshots.length)],
    ["Started At", session.startedAt || "-"],
    ["Stopped At", session.stoppedAt || "-"],
    ["Saved At", session.savedAt || "-"],
    ["URL", session.currentUrl || session.environment?.url || "-"]
  ];

  elements.exportSummary.innerHTML = rows
    .map(([label, value]) => {
      const className = label === "URL" || label === "Bug Title" || label === "Session ID" ? ' class="wide"' : "";
      return `<div${className}><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`;
    })
    .join("");
}

function updateButtons(isRecording, hasSession) {
  elements.startRecordingBtn.disabled = isBusy || isRecording;
  elements.stopRecordingBtn.disabled = isBusy || !isRecording;
  elements.exportJsonBtn.disabled = isBusy || !hasSession;
  elements.exportMarkdownBtn.disabled = isBusy || !hasSession;
  elements.exportTxtBtn.disabled = isBusy || !hasSession;
  elements.clearSessionBtn.disabled = isBusy || !hasSession;
  elements.refreshBtn.disabled = isBusy;

  for (const button of elements.saveReportBtns) {
    button.disabled = isBusy || !hasSession;
  }
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  updateButtons(latestSession?.isRecording === true || latestSession?.contentIsRecording === true, Boolean(latestSession));
}

function setPage(page) {
  const nextPage = page === "export" ? "export" : "recording";

  for (const tab of elements.pageTabs) {
    const selected = tab.dataset.page === nextPage;
    tab.dataset.active = String(selected);
    tab.setAttribute("aria-selected", String(selected));
  }

  for (const panel of elements.pagePanels) {
    panel.hidden = panel.dataset.pagePanel !== nextPage;
  }
}

function setStatus(message, tone) {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function readMetadataForm() {
  return Object.fromEntries(
    Object.entries(elements.metadataFields).map(([key, field]) => [key, field.value])
  );
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
    reportMetadata: normalizeReportMetadata(value.reportMetadata),
    environment: normalizeEnvironment(value.environment),
    recordedActions: Array.isArray(value.recordedActions) ? value.recordedActions : [],
    consoleWarnings: Array.isArray(value.consoleWarnings) ? value.consoleWarnings : [],
    consoleErrors: Array.isArray(value.consoleErrors) ? value.consoleErrors : [],
    javascriptErrors: Array.isArray(value.javascriptErrors) ? value.javascriptErrors : [],
    promiseRejections: Array.isArray(value.promiseRejections) ? value.promiseRejections : [],
    networkErrors: Array.isArray(value.networkErrors) ? value.networkErrors : [],
    screenshots: Array.isArray(value.screenshots) ? value.screenshots : []
  };
}

function normalizeReportMetadata(value) {
  return {
    ...DEFAULT_REPORT_METADATA,
    ...(value && typeof value === "object" ? value : {})
  };
}

function normalizeEnvironment(value) {
  const extensionVersion = chrome.runtime.getManifest().version || "";
  const environment = value && typeof value === "object" ? value : {};
  const viewport = environment.viewport || {};
  const userAgent = environment.userAgent || navigator.userAgent || "";
  const browserName = environment.browserName || detectBrowserName(userAgent);
  const browserVersion = environment.browserVersion || detectBrowserVersion(userAgent, browserName);

  return {
    ...environment,
    browser: environment.browser || [browserName, browserVersion].filter(Boolean).join(" "),
    browserName,
    browserVersion,
    userAgent,
    viewport,
    screen: environment.screen || {},
    platform: environment.platform || navigator.platform || "",
    osPlatform: environment.osPlatform || environment.platform || navigator.platform || "",
    language: environment.language || navigator.language || "",
    devicePixelRatio: environment.devicePixelRatio || viewport.devicePixelRatio || window.devicePixelRatio || "",
    timestamp: environment.timestamp || environment.capturedAt || "",
    capturedAt: environment.capturedAt || environment.timestamp || "",
    extensionVersion: environment.extensionVersion || extensionVersion
  };
}

function formatActionDescription(action) {
  const text = action.description || action.text || action.type || "Recorded action";

  if (isSensitiveAction(action)) {
    return text.replace(/"[^"]*"/g, "[REDACTED]");
  }

  return text;
}

function isSensitiveAction(action) {
  const inputType = action.target?.inputType || action.element?.attributes?.type || "";
  const label = [
    action.target?.label,
    action.element?.accessibleLabel,
    action.element?.placeholder,
    action.element?.attributes?.name,
    action.element?.attributes?.id
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return inputType.toLowerCase() === "password" || /password|secret|token|credential/.test(label);
}

function formatLocator(action) {
  const best = action.locators?.best;

  if (!best || best.strategy === "url") {
    return "";
  }

  const value = String(best.value || "");
  const shortened = value.length > 90 ? `${value.slice(0, 87)}...` : value;
  return `<span class="action-locator">${escapeHtml(best.strategy)}: <code>${escapeHtml(shortened)}</code></span>`;
}

function getConsoleErrorCount(session) {
  return (
    (session?.consoleErrors?.length || 0) +
    (session?.javascriptErrors?.length || 0) +
    (session?.promiseRejections?.length || 0)
  );
}

function formatBrowser(environment) {
  return environment.browser || [environment.browserName, environment.browserVersion].filter(Boolean).join(" ");
}

function formatViewport(viewport) {
  if (!viewport || (!viewport.width && !viewport.height)) {
    return "-";
  }

  return `${viewport.width || 0} x ${viewport.height || 0}`;
}

function formatScreen(screen) {
  if (!screen || (!screen.width && !screen.height)) {
    return "-";
  }

  return `${screen.width || 0} x ${screen.height || 0}`;
}

function detectBrowserName(userAgent) {
  if (userAgent.includes("Edg/")) {
    return "Microsoft Edge";
  }

  if (userAgent.includes("OPR/") || userAgent.includes("Opera/")) {
    return "Opera";
  }

  if (userAgent.includes("Chrome/")) {
    return "Google Chrome";
  }

  if (userAgent.includes("Firefox/")) {
    return "Firefox";
  }

  if (userAgent.includes("Safari/")) {
    return "Safari";
  }

  return "Unknown browser";
}

function detectBrowserVersion(userAgent, browserName) {
  const patterns = {
    "Microsoft Edge": /Edg\/([\d.]+)/,
    Opera: /(?:OPR|Opera)\/([\d.]+)/,
    "Google Chrome": /Chrome\/([\d.]+)/,
    Firefox: /Firefox\/([\d.]+)/,
    Safari: /Version\/([\d.]+).*Safari/
  };
  const match = userAgent.match(patterns[browserName] || /(?:Chrome|Firefox|Version)\/([\d.]+)/);
  return match?.[1] || "";
}

function setTextWithTitle(element, value) {
  const text = String(value || "-");
  element.textContent = text;
  element.title = text;
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
