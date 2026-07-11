const PRODUCT_NAME = "BugReportGenerator";
const SOURCE_PROJECT = "AI-Test-Automation-Generator";
const RECORDING_STATE_KEY = "bugReportGenerator.recordingState";
const CONTENT_SCRIPT_FILE = "content.js";
const DEBUG_PREFIX = "[BugReportGenerator][background]";
const MAX_ACTIONS = 500;
const MAX_EVIDENCE = 250;
const MAX_SCREENSHOTS = 5;
const MAX_PAGE_SNAPSHOTS = 100;
const MAX_HTML_SNIPPET_LENGTH = 1000;
const LOCATOR_EVIDENCE_ACTION_TYPES = new Set(["click", "input", "change", "submit", "enter_key", "tab_key"]);
const DEFAULT_REPORT_METADATA = {
  bugTitle: "",
  description: "",
  expectedResult: "",
  actualResult: "",
  additionalNotes: ""
};

let writeChain = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  console.log(`${PRODUCT_NAME} installed.`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_BUG_RECORDING" || (message?.type === "START_CAPTURE" && !message.sessionId)) {
    startRecording()
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to start recording.") }));
    return true;
  }

  if (message?.type === "STOP_RECORDING" || (message?.type === "STOP_CAPTURE" && !message.sessionId)) {
    stopRecording()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to stop recording.") }));
    return true;
  }

  if (message?.type === "CLEAR_SESSION") {
    clearSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to clear session.") }));
    return true;
  }

  if (message?.type === "GET_RECORDING_STATE" || message?.type === "GET_USER_ACTION_CAPTURE_STATE") {
    getSession()
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to read recording state.") }));
    return true;
  }

  if (message?.type === "UPDATE_REPORT_METADATA") {
    updateReportMetadata(message.metadata)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to save report fields.") }));
    return true;
  }

  if (message?.type === "SAVE_REPORT") {
    saveReport(message.metadata)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to save report.") }));
    return true;
  }

  if (message?.type === "CONTENT_SCRIPT_READY") {
    handleContentScriptReady(message, sender)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to resume recording.") }));
    return true;
  }

  if (message?.type === "RECORD_ACTION" || message?.type === "ACTION_RECORDED") {
    appendRecordedAction(message, sender)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to save action.") }));
    return true;
  }

  if (message?.type === "RECORD_EVIDENCE") {
    appendEvidence(message, sender)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to save evidence.") }));
    return true;
  }

  if (message?.type === "PAGE_LOAD_SNAPSHOT") {
    appendPageSnapshot(message, sender)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to save page snapshot.") }));
    return true;
  }

  if (message?.type === "CAPTURE_SCREENSHOT") {
    captureAndStoreScreenshot(message.reason || "manual")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to capture screenshot.") }));
    return true;
  }

  if (message?.type === "EXPORT_JSON") {
    exportJson()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to export JSON.") }));
    return true;
  }

  if (message?.type === "EXPORT_MARKDOWN") {
    exportMarkdown()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to export Markdown.") }));
    return true;
  }

  if (message?.type === "EXPORT_TXT") {
    exportText()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, "Unable to export TXT.") }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab).catch((error) => {
    console.warn(`${DEBUG_PREFIX} tab update handling failed`, error);
  });
});

if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) {
      return;
    }

    void handleNavigationCommitted(details).catch((error) => {
      console.warn(`${DEBUG_PREFIX} webNavigation handling failed`, error);
    });
  });
}

async function startRecording() {
  const tab = await getActiveTab();

  if (!tab.id) {
    throw new Error("No active tab is available.");
  }

  assertSupportedUrl(tab.url || "");
  await ensureContentScript(tab.id);

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const session = {
    project: PRODUCT_NAME,
    sourceProject: SOURCE_PROJECT,
    exportType: "bug-report",
    isRecording: true,
    contentIsRecording: true,
    status: "recording",
    activeRecordingTabId: tab.id,
    sessionId,
    currentSessionId: sessionId,
    startedAt: now,
    stoppedAt: null,
    savedAt: null,
    currentUrl: tab.url || "",
    currentTitle: tab.title || "",
    reportMetadata: { ...DEFAULT_REPORT_METADATA },
    environment: buildDefaultEnvironment(tab),
    recordedActions: [],
    consoleWarnings: [],
    consoleErrors: [],
    javascriptErrors: [],
    promiseRejections: [],
    networkErrors: [],
    screenshots: [],
    visitedPages: [buildVisitedPage(tab.url || "", tab.title || "", "start")],
    pageLoadSnapshots: [],
    rawEvents: [
      {
        id: crypto.randomUUID(),
        type: "session-started",
        timestamp: now,
        url: tab.url || "",
        title: tab.title || ""
      }
    ]
  };

  await setSession(session, "start-recording");
  await sendTabMessageWithRetry(tab.id, {
    type: "START_RECORDING",
    sessionId,
    tabId: tab.id
  });

  return session;
}

async function stopRecording() {
  const session = await getSession();

  if (!isActiveSession(session)) {
    throw new Error("No active recording session was found.");
  }

  try {
    await sendTabMessage(session.activeRecordingTabId, {
      type: "STOP_RECORDING",
      sessionId: session.sessionId
    });
  } catch (error) {
    console.warn(`${DEBUG_PREFIX} stop message failed; storage will still be marked stopped`, error);
  }

  let warning = "";

  try {
    await captureAndStoreScreenshot("stop-recording");
  } catch (error) {
    warning = `Recording stopped, but the automatic screenshot could not be captured: ${getErrorMessage(error, "Screenshot capture failed.")}`;
    console.warn(`${DEBUG_PREFIX} automatic stop screenshot failed`, error);
    await storeSessionWarning(session.sessionId, warning);
  }

  const stoppedSession = await updateSession((current) => {
    if (!current || current.sessionId !== session.sessionId) {
      return markStopped(session);
    }

    return markStopped(current);
  }, "stop-recording");

  return { session: stoppedSession, warning };
}

async function clearSession() {
  const session = await getSession();

  if (isActiveSession(session)) {
    try {
      await sendTabMessage(session.activeRecordingTabId, {
        type: "STOP_RECORDING",
        sessionId: session.sessionId
      });
    } catch (error) {
      console.warn(`${DEBUG_PREFIX} clear stop message failed`, error);
    }
  }

  await removeStorageValue(RECORDING_STATE_KEY);
}

async function updateReportMetadata(metadata) {
  return updateSession((session) => {
    if (!session) {
      return session;
    }

    return trimSession({
      ...session,
      reportMetadata: normalizeReportMetadata({
        ...(session.reportMetadata || {}),
        ...(metadata || {})
      })
    });
  }, "update-report-metadata");
}

async function saveReport(metadata) {
  const savedAt = new Date().toISOString();
  const savedSession = await updateSession((session) => {
    if (!session) {
      return session;
    }

    return trimSession({
      ...session,
      reportMetadata: normalizeReportMetadata({
        ...(session.reportMetadata || {}),
        ...(metadata || {})
      }),
      savedAt,
      rawEvents: [
        ...(session.rawEvents || []),
        {
          id: crypto.randomUUID(),
          type: "report-saved",
          timestamp: savedAt,
          url: session.currentUrl,
          title: session.currentTitle
        }
      ]
    });
  }, "save-report");

  if (!savedSession) {
    throw new Error("No bug recording session is available to save.");
  }

  return savedSession;
}

async function storeSessionWarning(sessionId, warning) {
  if (!sessionId || !warning) {
    return getSession();
  }

  return updateSession((session) => {
    if (!session || session.sessionId !== sessionId) {
      return session;
    }

    return trimSession({
      ...session,
      lastWarning: warning,
      screenshotCaptureWarning: warning
    });
  }, "session-warning");
}

async function handleContentScriptReady(message, sender) {
  const tabId = sender.tab?.id;

  if (typeof tabId !== "number") {
    return getSession();
  }

  const session = await getSession();

  if (!isActiveSession(session) || session.activeRecordingTabId !== tabId) {
    return session;
  }

  if (message.url && message.url !== session.currentUrl) {
    await appendSystemNavigation(tabId, message.url, "content-ready");
  }

  await sendResumeRecording(tabId);
  return getSession();
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  const session = await getSession();

  if (!isActiveSession(session) || session.activeRecordingTabId !== tabId) {
    return;
  }

  if (changeInfo.url) {
    await appendSystemNavigation(tabId, changeInfo.url, "tab-url-change");
  } else if (changeInfo.status === "loading" && (tab.url || session.currentUrl) === session.currentUrl) {
    await appendSystemNavigation(tabId, tab.url || session.currentUrl, "reload");
  }

  if (changeInfo.status !== "complete") {
    return;
  }

  const currentUrl = tab.url || session.currentUrl;

  if (!isSupportedUrl(currentUrl)) {
    return;
  }

  await ensureContentScript(tabId);
  await sendResumeRecording(tabId);
}

async function handleNavigationCommitted(details) {
  const session = await getSession();

  if (!isActiveSession(session) || session.activeRecordingTabId !== details.tabId) {
    return;
  }

  const source = details.transitionType === "reload" ? "reload" : "navigation";
  await appendSystemNavigation(details.tabId, details.url, source);
}

async function sendResumeRecording(tabId) {
  const session = await getSession();

  if (!isActiveSession(session) || session.activeRecordingTabId !== tabId) {
    return;
  }

  await sendTabMessageWithRetry(tabId, {
    type: "RESUME_RECORDING",
    sessionId: session.sessionId,
    tabId,
    currentUrl: session.currentUrl
  });
}

async function appendRecordedAction(message, sender) {
  const tabId = sender.tab?.id ?? null;
  const incomingAction = message.action;

  if (!incomingAction || !message.sessionId) {
    return getSession();
  }

  return updateSession((session) => {
    if (!session || session.sessionId !== message.sessionId) {
      return session;
    }

    if (session.isRecording === false) {
      return session;
    }

    const action = normalizeAction(incomingAction, session.recordedActions.length + 1, tabId);
    const recordedActions = mergeRecordedActions(session.recordedActions, action).slice(-MAX_ACTIONS);

    return trimSession({
      ...session,
      isRecording: true,
      contentIsRecording: true,
      status: "recording",
      currentSessionId: message.sessionId,
      currentUrl: action.url || action.pageUrl || session.currentUrl,
      currentTitle: action.title || session.currentTitle,
      recordedActions,
      visitedPages: mergeVisitedPages(session.visitedPages, action.url || action.pageUrl, action.title, action.type),
      rawEvents: [
        ...(session.rawEvents || []),
        {
          id: crypto.randomUUID(),
          type: "action",
          timestamp: action.timestamp,
          action
        }
      ]
    });
  }, `record-action:${incomingAction.type || "unknown"}`);
}

async function appendEvidence(message, sender) {
  const tabId = sender.tab?.id ?? null;
  const evidence = normalizeEvidence(message.evidence, tabId);

  if (!message.sessionId || !evidence) {
    return getSession();
  }

  return updateSession((session) => {
    if (!session || session.sessionId !== message.sessionId) {
      return session;
    }

    if (session.isRecording === false) {
      return session;
    }

    const nextSession = {
      ...session,
      currentUrl: evidence.pageUrl || session.currentUrl,
      currentTitle: evidence.title || session.currentTitle,
      visitedPages: mergeVisitedPages(session.visitedPages, evidence.pageUrl, evidence.title, evidence.category),
      rawEvents: [
        ...(session.rawEvents || []),
        {
          id: crypto.randomUUID(),
          type: evidence.category || "evidence",
          timestamp: evidence.timestamp,
          evidence
        }
      ]
    };

    if (evidence.category === "console" && evidence.level === "console.warn") {
      nextSession.consoleWarnings = [...(session.consoleWarnings || []), evidence].slice(-MAX_EVIDENCE);
    } else if (evidence.category === "console") {
      nextSession.consoleErrors = [...(session.consoleErrors || []), evidence].slice(-MAX_EVIDENCE);
    } else if (evidence.category === "javascript-error") {
      nextSession.javascriptErrors = [...(session.javascriptErrors || []), evidence].slice(-MAX_EVIDENCE);
    } else if (evidence.category === "promise-rejection") {
      nextSession.promiseRejections = [...(session.promiseRejections || []), evidence].slice(-MAX_EVIDENCE);
    } else if (evidence.category === "network-error") {
      nextSession.networkErrors = [...(session.networkErrors || []), evidence].slice(-MAX_EVIDENCE);
    }

    return trimSession(nextSession);
  }, `record-evidence:${evidence.category || "unknown"}`);
}

async function appendPageSnapshot(message, sender) {
  const tabId = sender.tab?.id ?? null;
  const snapshot = {
    id: message.snapshot?.id || crypto.randomUUID(),
    timestamp: message.snapshot?.timestamp || new Date().toISOString(),
    url: message.snapshot?.url || sender.tab?.url || "",
    title: message.snapshot?.title || sender.tab?.title || "",
    reason: message.snapshot?.reason || "page-load",
    userAgent: message.snapshot?.userAgent || "",
    viewport: message.snapshot?.viewport || { width: 0, height: 0, devicePixelRatio: 0 },
    screen: message.snapshot?.screen || {},
    language: message.snapshot?.language || "",
    platform: message.snapshot?.platform || "",
    timeZone: message.snapshot?.timeZone || ""
  };

  if (!message.sessionId) {
    return getSession();
  }

  return updateSession((session) => {
    if (!session || session.sessionId !== message.sessionId || session.isRecording === false) {
      return session;
    }

    return trimSession({
      ...session,
      currentUrl: snapshot.url || session.currentUrl,
      currentTitle: snapshot.title || session.currentTitle,
      environment: buildEnvironmentFromSnapshot(snapshot, session.environment),
      visitedPages: mergeVisitedPages(session.visitedPages, snapshot.url, snapshot.title, snapshot.reason),
      pageLoadSnapshots: [...(session.pageLoadSnapshots || []), snapshot].slice(-MAX_PAGE_SNAPSHOTS),
      rawEvents: [
        ...(session.rawEvents || []),
        {
          id: crypto.randomUUID(),
          type: "page-load-snapshot",
          timestamp: snapshot.timestamp,
          snapshot
        }
      ]
    });
  }, "page-load-snapshot");
}

async function appendSystemNavigation(tabId, url, source) {
  if (!url) {
    return getSession();
  }

  return updateSession((session) => {
    if (!isActiveSession(session) || session.activeRecordingTabId !== tabId) {
      return session;
    }

    const previousAction = session.recordedActions[session.recordedActions.length - 1];

    if (previousAction?.type === "navigation" && previousAction.url === url && previousAction.source === source) {
      return {
        ...session,
        currentUrl: url
      };
    }

    const action = normalizeAction(
      {
        id: crypto.randomUUID(),
        step: session.recordedActions.length + 1,
        type: "navigation",
        timestamp: new Date().toISOString(),
        url,
        pageUrl: url,
        title: session.currentTitle || "",
        source,
        description: source === "reload" ? `Reloaded ${url}` : `Navigated to ${url}`,
        text: source === "reload" ? `Reloaded ${url}` : `Navigated to ${url}`,
        element: {
          tag: "document",
          text: "",
          accessibleLabel: "page",
          attributes: {},
          domPath: "document"
        },
        locators: {
          candidates: [
            {
              strategy: "url",
              value: url,
              score: 80,
              reason: "Current page URL",
              uniqueness: "page",
              stabilityNotes: "Useful for page-level reproduction."
            }
          ],
          best: {
            strategy: "url",
            value: url,
            score: 80,
            reason: "Current page URL",
            uniqueness: "page",
            stabilityNotes: "Useful for page-level reproduction."
          }
        }
      },
      session.recordedActions.length + 1,
      tabId
    );

    return trimSession({
      ...session,
      currentUrl: url,
      recordedActions: mergeRecordedActions(session.recordedActions, action).slice(-MAX_ACTIONS),
      visitedPages: mergeVisitedPages(session.visitedPages, url, session.currentTitle || "", source),
      rawEvents: [
        ...(session.rawEvents || []),
        {
          id: crypto.randomUUID(),
          type: source,
          timestamp: action.timestamp,
          action
        }
      ]
    });
  }, `system-navigation:${source}`);
}

async function captureAndStoreScreenshot(reason) {
  const session = await getSession();
  const tab = isActiveSession(session) ? await getTab(session.activeRecordingTabId) : await getActiveTab();

  if (!tab?.id || !tab.windowId) {
    throw new Error("No capturable tab is available.");
  }

  assertSupportedUrl(tab.url || "");

  const dataUrl = await captureVisibleTab(tab.windowId);
  const screenshot = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    reason,
    pageUrl: tab.url || "",
    title: tab.title || "",
    tabId: tab.id,
    mimeType: "image/png",
    dataUrl,
    note: "Stored in chrome.storage.local for the latest session. Export includes this data URL when present."
  };

  if (session) {
    await updateSession((current) => {
      if (!current || current.sessionId !== session.sessionId) {
        return current;
      }

      return trimSession({
        ...current,
        screenshots: [...(current.screenshots || []), screenshot].slice(-MAX_SCREENSHOTS),
        rawEvents: [
          ...(current.rawEvents || []),
          {
            id: crypto.randomUUID(),
            type: "screenshot",
            timestamp: screenshot.timestamp,
            screenshot: withoutDataUrl(screenshot)
          }
        ]
      });
    }, "capture-screenshot");
  }

  return { screenshot: withoutDataUrl(screenshot), session: await getSession() };
}

async function exportJson() {
  const session = await getSession();

  if (!session) {
    throw new Error("No bug recording session is available to export.");
  }

  const report = buildBugReportJson(session);
  const text = JSON.stringify(report, null, 2);
  const filename = `bug-report-${sanitizeFilename(session.sessionId || formatTimestampForFile(new Date()))}.json`;

  await downloadText(filename, "application/json", text);
  return { filename };
}

async function exportMarkdown() {
  const session = await getSession();

  if (!session) {
    throw new Error("No bug recording session is available to export.");
  }

  const report = buildBugReportJson(session);
  const text = buildBugReportMarkdown(report);
  const filename = `bug-report-${sanitizeFilename(session.sessionId || formatTimestampForFile(new Date()))}.md`;

  await downloadText(filename, "text/markdown", text);
  return { filename };
}

async function exportText() {
  const session = await getSession();

  if (!session) {
    throw new Error("No bug recording session is available to export.");
  }

  const report = buildBugReportJson(session);
  const text = buildBugReportText(report);
  const filename = `bug-report-${sanitizeFilename(session.sessionId || formatTimestampForFile(new Date()))}.txt`;

  await downloadText(filename, "text/plain", text);
  return { filename };
}

function buildBugReportJson(session) {
  const actions = (session.recordedActions || []).map((action, index) => buildExportAction(action, index + 1));
  const reportMetadata = normalizeReportMetadata(session.reportMetadata);
  const environment = normalizeEnvironment(
    session.environment || buildDefaultEnvironment({ url: session.currentUrl, title: session.currentTitle })
  );
  environment.url = session.currentUrl || environment.url || "";
  environment.pageTitle = session.currentTitle || environment.pageTitle || "";
  const latestPage = session.visitedPages?.[session.visitedPages.length - 1];
  const affectedPage = latestPage?.title || session.currentTitle || session.currentUrl || "Current page";
  const allErrors = [
    ...(session.consoleErrors || []),
    ...(session.javascriptErrors || []),
    ...(session.promiseRejections || [])
  ];
  const networkErrors = session.networkErrors || [];
  const severity = suggestSeverity(allErrors, networkErrors);
  const priority = allErrors.length || networkErrors.length ? "Medium" : "Low";
  const titleSuggestion = reportMetadata.bugTitle || suggestTitle(session, allErrors, networkErrors);

  return {
    project: PRODUCT_NAME,
    sourceProject: SOURCE_PROJECT,
    exportType: "bug-report",
    generatedAt: new Date().toISOString(),
    extensionMetadata: {
      name: PRODUCT_NAME,
      version: chrome.runtime.getManifest().version,
      architecture: "Plain JavaScript MV3 extension forked from AI-Test-Automation-Generator lifecycle."
    },
    reportMetadata,
    session: {
      id: session.sessionId,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt || null,
      endedAt: session.stoppedAt || null,
      savedAt: session.savedAt || null,
      status: session.isRecording ? "recording" : "stopped",
      activeRecordingTabId: session.activeRecordingTabId
    },
    environment,
    summary: {
      titleSuggestion,
      severitySuggestion: severity,
      prioritySuggestion: priority,
      affectedPage
    },
    visitedPages: session.visitedPages || [],
    pageLoadSnapshots: session.pageLoadSnapshots || [],
    reproductionSteps: buildReproductionSteps(actions, session.currentUrl),
    actions,
    locatorData: actions.map((action) => ({
      step: action.step,
      description: action.description || action.text || "",
      htmlSnippet: getActionHtmlSnippet(action),
      element: action.element || null,
      locators: action.locators || null
    })),
    consoleLogs: [],
    consoleWarnings: session.consoleWarnings || [],
    consoleErrors: session.consoleErrors || [],
    javascriptErrors: session.javascriptErrors || [],
    promiseRejections: session.promiseRejections || [],
    networkErrors,
    screenshots: (session.screenshots || []).map((screenshot) => ({
      ...screenshot,
      dataUrl: screenshot.dataUrl || null
    })),
    suspectedAffectedComponent: inferAffectedComponent(session, allErrors, networkErrors),
    severitySuggestion: severity,
    prioritySuggestion: priority,
    aiAnalysisNotes: buildAiNotes(session, allErrors, networkErrors),
    rawEvents: session.rawEvents || []
  };
}

function buildExportAction(action, step) {
  const htmlSnippet = normalizeHtmlSnippet(getActionHtmlSnippet(action));
  const element = action.element
    ? {
        ...action.element,
        ...(htmlSnippet ? { htmlSnippet } : {})
      }
    : action.element;
  const locators = action.locators
    ? {
        ...action.locators,
        ...(htmlSnippet ? { html: htmlSnippet } : {})
      }
    : action.locators;

  return {
    ...action,
    step,
    ...(htmlSnippet ? { htmlSnippet } : {}),
    element,
    locators
  };
}

function buildBugReportMarkdown(report) {
  const metadata = report.reportMetadata || DEFAULT_REPORT_METADATA;
  const title = metadata.bugTitle || report.summary.titleSuggestion;
  const description = metadata.description || "Not provided.";
  const expectedResult = metadata.expectedResult || "Not provided.";
  const actualResult = metadata.actualResult || buildActualResult(report);
  const additionalNotes = metadata.additionalNotes || "None.";
  const consoleEvidence = getCombinedConsoleEvidence(report);

  return [
    `# Bug Report: ${title}`,
    "",
    "## Description",
    description,
    "",
    "## Steps to Reproduce",
    ...report.reproductionSteps.map((step) => `${step.step}. ${step.action}`),
    "",
    "## Locator Evidence",
    ...formatLocatorEvidenceMarkdown(report),
    "",
    "## Expected Result",
    expectedResult,
    "",
    "## Actual Result",
    actualResult,
    "",
    "## Environment",
    `- URL: ${getEnvironmentUrl(report)}`,
    `- Browser: ${formatBrowser(report.environment)}`,
    `- User Agent: ${report.environment.userAgent || ""}`,
    `- OS/Platform: ${report.environment.osPlatform || report.environment.platform || ""}`,
    `- Screen Size: ${formatScreen(report.environment.screen)}`,
    `- Viewport: ${formatViewport(report.environment.viewport)}`,
    `- Device Pixel Ratio: ${report.environment.devicePixelRatio || report.environment.viewport?.devicePixelRatio || ""}`,
    `- Language: ${report.environment.language || ""}`,
    `- Timestamp: ${report.environment.timestamp || report.environment.capturedAt || report.generatedAt}`,
    `- Extension Version: ${report.environment.extensionVersion || report.extensionMetadata.version || ""}`,
    "",
    "## Console Errors",
    formatEvidenceList(consoleEvidence),
    "",
    "## Network Errors",
    formatNetworkEvidenceList(report.networkErrors),
    "",
    "## Screenshots",
    `- Screenshot count: ${report.screenshots.length}`,
    ...formatScreenshotMarkdownList(report.screenshots),
    "",
    "## Session",
    `- Session ID: ${report.session.id}`,
    `- Started At: ${report.session.startedAt || ""}`,
    `- Stopped At: ${report.session.stoppedAt || ""}`,
    `- Saved At: ${report.session.savedAt || ""}`,
    `- Exported At: ${report.generatedAt}`,
    "",
    "## Additional Notes",
    additionalNotes,
    "",
    "## AI Notes",
    report.aiAnalysisNotes.join("\n")
  ].join("\n");
}

function buildBugReportText(report) {
  const metadata = report.reportMetadata || DEFAULT_REPORT_METADATA;
  const title = metadata.bugTitle || report.summary.titleSuggestion;
  const consoleEvidence = getCombinedConsoleEvidence(report);

  return [
    `BUG REPORT: ${title}`,
    "",
    "DESCRIPTION",
    metadata.description || "Not provided.",
    "",
    "STEPS TO REPRODUCE",
    ...report.reproductionSteps.map((step) => `${step.step}. ${step.action}`),
    "",
    "LOCATOR EVIDENCE",
    ...formatLocatorEvidenceText(report),
    "",
    "EXPECTED RESULT",
    metadata.expectedResult || "Not provided.",
    "",
    "ACTUAL RESULT",
    metadata.actualResult || buildActualResult(report),
    "",
    "ENVIRONMENT",
    `URL: ${getEnvironmentUrl(report)}`,
    `Browser: ${formatBrowser(report.environment)}`,
    `User Agent: ${report.environment.userAgent || ""}`,
    `OS/Platform: ${report.environment.osPlatform || report.environment.platform || ""}`,
    `Screen Size: ${formatScreen(report.environment.screen)}`,
    `Viewport: ${formatViewport(report.environment.viewport)}`,
    `Device Pixel Ratio: ${report.environment.devicePixelRatio || report.environment.viewport?.devicePixelRatio || ""}`,
    `Language: ${report.environment.language || ""}`,
    `Timestamp: ${report.environment.timestamp || report.environment.capturedAt || report.generatedAt}`,
    `Extension Version: ${report.environment.extensionVersion || report.extensionMetadata.version || ""}`,
    "",
    "CONSOLE ERRORS",
    formatPlainEvidenceList(consoleEvidence),
    "",
    "NETWORK ERRORS",
    formatPlainNetworkEvidenceList(report.networkErrors),
    "",
    "SCREENSHOTS",
    `Screenshot count: ${report.screenshots.length}`,
    ...formatScreenshotTextList(report.screenshots),
    "",
    "SESSION",
    `Session ID: ${report.session.id}`,
    `Started At: ${report.session.startedAt || ""}`,
    `Stopped At: ${report.session.stoppedAt || ""}`,
    `Saved At: ${report.session.savedAt || ""}`,
    `Exported At: ${report.generatedAt}`,
    "",
    "ADDITIONAL NOTES",
    metadata.additionalNotes || "None."
  ].join("\n");
}

function buildReproductionSteps(actions, fallbackUrl) {
  const steps = [];
  const firstUrl = actions.find((action) => action.url || action.pageUrl)?.url || fallbackUrl;

  if (firstUrl) {
    steps.push({
      step: 1,
      action: `Open ${firstUrl}`
    });
  }

  for (const action of actions) {
    const text = action.description || action.text || describeActionForStep(action);

    if (!text || (steps.length === 1 && text === steps[0].action)) {
      continue;
    }

    steps.push({
      step: steps.length + 1,
      action: text
    });
  }

  return steps.length ? steps : [{ step: 1, action: "Open the target page and reproduce the issue." }];
}

function describeActionForStep(action) {
  if (action.type === "navigation") {
    return `Navigate to ${action.url || action.pageUrl}`;
  }

  if (action.type === "click") {
    return `Click ${action.target?.label || action.element?.text || "the target element"}`;
  }

  if (action.type === "input") {
    return `Type into ${action.target?.label || action.element?.placeholder || "the target field"}`;
  }

  if (action.type === "change") {
    return `Change ${action.target?.label || "the target field"}`;
  }

  if (action.type === "enter_key") {
    return `Press Enter on ${action.target?.label || "the target element"}`;
  }

  if (action.type === "tab_key") {
    return `Press Tab on ${action.target?.label || "the target element"}`;
  }

  if (action.type === "submit") {
    return "Submit the form";
  }

  return action.type;
}

function suggestTitle(session, errors, networkErrors) {
  const page = session.currentTitle || session.currentUrl || "recorded flow";

  if (errors.length) {
    return `Bug encountered on ${page}: ${truncate(errors[0].message || "console error", 80)}`;
  }

  if (networkErrors.length) {
    return `Network failure during ${page}`;
  }

  return `Bug encountered during ${page}`;
}

function suggestSeverity(errors, networkErrors) {
  if (errors.some((error) => /uncaught|runtime|crash|fatal/i.test(error.message || ""))) {
    return "High";
  }

  if (errors.length || networkErrors.some((error) => Number(error.status) >= 500 || Number(error.status) === 0)) {
    return "Medium";
  }

  return "Low";
}

function inferAffectedComponent(session, errors, networkErrors) {
  const latestAction = session.recordedActions?.[session.recordedActions.length - 1];

  if (networkErrors.length) {
    try {
      return new URL(networkErrors[0].requestUrl).pathname || "Network/API";
    } catch (_error) {
      return "Network/API";
    }
  }

  if (latestAction?.element?.parentContext) {
    return latestAction.element.parentContext;
  }

  if (errors[0]?.source) {
    return errors[0].source;
  }

  return session.currentTitle || session.currentUrl || "Unknown component";
}

function buildAiNotes(session, errors, networkErrors) {
  const notes = [];

  notes.push(`Captured ${session.recordedActions?.length || 0} user actions across ${(session.visitedPages || []).length} visited page entries.`);

  if (errors.length) {
    notes.push(`Console/runtime evidence exists. Start debugging from: ${truncate(errors[0].message || "Unknown error", 140)}.`);
  }

  if (networkErrors.length) {
    notes.push(`Network evidence exists. First failed request: ${networkErrors[0].method || "GET"} ${networkErrors[0].requestUrl || ""} (${networkErrors[0].status || "no status"}).`);
  }

  const latestLocator = session.recordedActions?.slice().reverse().find((action) => action.locators?.best)?.locators.best;

  if (latestLocator) {
    notes.push(`Most recent strong locator hint: ${latestLocator.strategy} = ${latestLocator.value}.`);
  }

  if (!errors.length && !networkErrors.length) {
    notes.push("No console or network failure was detected; review the reproduction timeline and screenshots for visual/UI defects.");
  }

  return notes;
}

function summarizeEvidence(report) {
  const parts = [];

  if (report.consoleErrors.length) {
    parts.push(`${report.consoleErrors.length} console error(s)`);
  }

  if (report.javascriptErrors.length) {
    parts.push(`${report.javascriptErrors.length} JavaScript runtime error(s)`);
  }

  if (report.promiseRejections.length) {
    parts.push(`${report.promiseRejections.length} unhandled promise rejection(s)`);
  }

  if (report.networkErrors.length) {
    parts.push(`${report.networkErrors.length} network error(s)`);
  }

  if (report.screenshots.length) {
    parts.push(`${report.screenshots.length} screenshot(s)`);
  }

  return parts.length ? `Evidence captured: ${parts.join(", ")}.` : "No console or network errors were detected during the recording.";
}

function buildActualResult(report) {
  const evidence = summarizeEvidence(report);
  const latestError =
    report.javascriptErrors[0]?.message ||
    report.consoleErrors[0]?.message ||
    report.promiseRejections[0]?.message ||
    report.networkErrors[0]?.failureReason ||
    "";

  return latestError ? `${evidence} Latest issue: ${latestError}` : evidence;
}

function formatEvidenceList(items) {
  if (!items.length) {
    return "No entries captured.";
  }

  return items
    .map((item, index) => {
      const location = item.source ? ` (${item.source}${item.line ? `:${item.line}` : ""})` : "";
      const stack = item.stack ? `\n\n\`\`\`\n${item.stack}\n\`\`\`` : "";
      return `${index + 1}. [${item.level || item.category}] ${item.message || item.failureReason || "Unknown"}${location}\n   Time: ${item.timestamp}${stack}`;
    })
    .join("\n\n");
}

function formatNetworkEvidenceList(items) {
  if (!items.length) {
    return "No entries captured.";
  }

  return items
    .map((item, index) => `${index + 1}. ${item.method || "GET"} ${item.requestUrl || ""} - ${item.status || "failed"} ${item.failureReason || ""}\n   Time: ${item.timestamp}`)
    .join("\n\n");
}

function formatPlainEvidenceList(items) {
  if (!items.length) {
    return "No entries captured.";
  }

  return items
    .map((item, index) => {
      const location = item.source ? ` (${item.source}${item.line ? `:${item.line}` : ""})` : "";
      return `${index + 1}. [${item.level || item.category}] ${item.message || item.failureReason || "Unknown"}${location}\n   Time: ${item.timestamp}`;
    })
    .join("\n\n");
}

function formatPlainNetworkEvidenceList(items) {
  if (!items.length) {
    return "No entries captured.";
  }

  return items
    .map((item, index) => `${index + 1}. ${item.method || "GET"} ${item.requestUrl || ""} - ${item.status || "failed"} ${item.failureReason || ""}\n   Time: ${item.timestamp}`)
    .join("\n\n");
}

function formatLocatorEvidenceMarkdown(report) {
  const actions = getLocatorEvidenceActions(report);

  if (!actions.length) {
    return ["No locator evidence captured."];
  }

  const lines = [];

  for (const action of actions) {
    const bestLocator = getBestLocator(action);
    const fallbackLocators = getFallbackLocators(action);
    const htmlSnippet = getActionHtmlSnippet(action);

    lines.push(`### Step ${getLocatorEvidenceStepNumber(report, action)}: ${formatEvidenceActionDescription(action)}`);

    if (bestLocator) {
      lines.push(`- Best locator: \`${escapeMarkdownInlineCode(bestLocator.value)}\``);
      lines.push(`- Strategy: ${bestLocator.strategy || "unknown"}`);
    } else {
      lines.push("- Best locator: Not available.");

      if (fallbackLocators.css) {
        lines.push(`- CSS: \`${escapeMarkdownInlineCode(fallbackLocators.css)}\``);
      }

      if (fallbackLocators.xpath) {
        lines.push(`- XPath: \`${escapeMarkdownInlineCode(fallbackLocators.xpath)}\``);
      }
    }

    if (htmlSnippet) {
      lines.push("- HTML:");
      lines.push("```html");
      lines.push(escapeMarkdownFenceContent(htmlSnippet));
      lines.push("```");
    } else {
      lines.push("- HTML: Not captured.");
    }

    lines.push("");
  }

  return lines.slice(0, -1);
}

function formatLocatorEvidenceText(report) {
  const actions = getLocatorEvidenceActions(report);

  if (!actions.length) {
    return ["No locator evidence captured."];
  }

  const lines = [];

  for (const action of actions) {
    const bestLocator = getBestLocator(action);
    const fallbackLocators = getFallbackLocators(action);
    const htmlSnippet = getActionHtmlSnippet(action);

    lines.push(`Step ${getLocatorEvidenceStepNumber(report, action)}: ${formatEvidenceActionDescription(action)}`);

    if (bestLocator) {
      lines.push(`Best locator: ${bestLocator.value || ""}`);
      lines.push(`Strategy: ${bestLocator.strategy || "unknown"}`);
    } else {
      lines.push("Best locator: Not available.");

      if (fallbackLocators.css) {
        lines.push(`CSS: ${fallbackLocators.css}`);
      }

      if (fallbackLocators.xpath) {
        lines.push(`XPath: ${fallbackLocators.xpath}`);
      }
    }

    lines.push(`HTML: ${htmlSnippet || "Not captured."}`);
    lines.push("");
  }

  return lines.slice(0, -1);
}

function getLocatorEvidenceActions(report) {
  return (report.actions || []).filter((action) => {
    if (!action || !LOCATOR_EVIDENCE_ACTION_TYPES.has(action.type)) {
      return false;
    }

    const fallbackLocators = getFallbackLocators(action);
    return Boolean(getBestLocator(action) || getActionHtmlSnippet(action) || fallbackLocators.css || fallbackLocators.xpath);
  });
}

function getBestLocator(action) {
  const best = action?.locators?.best;

  if (!best || best.strategy === "url" || !best.value) {
    return null;
  }

  return best;
}

function getFallbackLocators(action) {
  const candidates = Array.isArray(action?.locators?.candidates) ? action.locators.candidates : [];
  const css = candidates.find((candidate) => candidate.strategy === "css" && candidate.value)?.value || "";
  const xpath =
    candidates.find((candidate) => /xpath/i.test(candidate.strategy || "") && candidate.value)?.value || "";

  return { css, xpath };
}

function getLocatorEvidenceStepNumber(report, action) {
  const hasOpeningStep = String(report.reproductionSteps?.[0]?.action || "").startsWith("Open ");
  return (Number(action.step) || 0) + (hasOpeningStep ? 1 : 0);
}

function formatEvidenceActionDescription(action) {
  const text = action.description || action.text || describeActionForStep(action);

  if (!isSensitiveEvidenceAction(action)) {
    return text;
  }

  return text.replace(/"[^"]*"/g, "[REDACTED]");
}

function isSensitiveEvidenceAction(action) {
  const inputType = action.target?.inputType || action.element?.attributes?.type || "";
  const label = [
    action.target?.label,
    action.element?.accessibleLabel,
    action.element?.placeholder,
    action.element?.attributes?.name,
    action.element?.attributes?.id,
    action.element?.attributes?.["data-testid"],
    action.element?.attributes?.["data-test"],
    action.element?.attributes?.["data-qa"],
    action.element?.attributes?.["data-cy"]
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return inputType.toLowerCase() === "password" || /password|secret|token|credential/.test(label);
}

function getActionHtmlSnippet(action) {
  return normalizeHtmlSnippet(
    action?.htmlSnippet ||
      action?.element?.htmlSnippet ||
      action?.locators?.html ||
      action?.locators?.htmlSnippet ||
      ""
  );
}

function normalizeHtmlSnippet(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > MAX_HTML_SNIPPET_LENGTH ? `${text.slice(0, MAX_HTML_SNIPPET_LENGTH - 3)}...` : text;
}

function escapeMarkdownInlineCode(value) {
  return String(value || "").replace(/\s+/g, " ").trim().replace(/`/g, "\\`");
}

function escapeMarkdownFenceContent(value) {
  return String(value || "").replace(/```/g, "'''");
}

function getCombinedConsoleEvidence(report) {
  return [
    ...(report.consoleErrors || []),
    ...(report.javascriptErrors || []),
    ...(report.promiseRejections || [])
  ];
}

function getEnvironmentUrl(report) {
  const visitedPages = report.visitedPages || [];
  const latestPage = visitedPages[visitedPages.length - 1];
  return report.environment?.url || latestPage?.url || "";
}

function formatBrowser(environment) {
  if (!environment) {
    return "";
  }

  if (environment.browser) {
    return environment.browser;
  }

  return [environment.browserName, environment.browserVersion].filter(Boolean).join(" ");
}

function formatScreen(screen) {
  if (!screen) {
    return "";
  }

  return `${screen.width || 0} x ${screen.height || 0}`;
}

function formatScreenshotMarkdownList(screenshots) {
  if (!screenshots.length) {
    return ["- Captured at: None"];
  }

  return screenshots.map(
    (screenshot, index) =>
      `- Screenshot ${index + 1}: captured at ${screenshot.timestamp || ""}; reason: ${screenshot.reason || ""}; URL: ${screenshot.pageUrl || ""}; data URL included in JSON: ${screenshot.dataUrl ? "yes" : "no"}`
  );
}

function formatScreenshotTextList(screenshots) {
  if (!screenshots.length) {
    return ["Captured at: None"];
  }

  return screenshots.map(
    (screenshot, index) =>
      `Screenshot ${index + 1}: captured at ${screenshot.timestamp || ""}; reason: ${screenshot.reason || ""}; URL: ${screenshot.pageUrl || ""}; data URL included in JSON: ${screenshot.dataUrl ? "yes" : "no"}`
  );
}

function formatLocatorHints(actions) {
  const hints = actions
    .filter((action) => action.locators?.best)
    .slice(-10)
    .map((action) => `* Step ${action.step}: ${action.locators.best.strategy} \`${action.locators.best.value}\` (${action.locators.best.reason})`);

  return hints.length ? hints.join("\n") : "No locator hints captured.";
}

function formatViewport(viewport) {
  if (!viewport) {
    return "";
  }

  return `${viewport.width || 0} x ${viewport.height || 0} @ ${viewport.devicePixelRatio || 1}x`;
}

function normalizeAction(action, step, tabId) {
  const timestamp = action.timestamp || new Date().toISOString();
  const url = action.url || action.pageUrl || "";
  const normalized = {
    ...action,
    id: action.id || crypto.randomUUID(),
    step,
    timestamp,
    url,
    pageUrl: action.pageUrl || url,
    title: action.title || "",
    tabId: typeof action.tabId === "number" ? action.tabId : tabId,
    description: action.description || action.text || describeActionForStep(action),
    text: action.text || action.description || describeActionForStep(action)
  };

  if (!normalized.element && normalized.target) {
    normalized.element = {
      tag: normalized.target.tagName || "element",
      text: normalized.target.label || "",
      accessibleLabel: normalized.target.label || "",
      attributes: normalized.target.inputType ? { type: normalized.target.inputType } : {},
      domPath: normalized.target.selector || ""
    };
  }

  if (!normalized.locators) {
    normalized.locators = {
      candidates: [],
      best: null
    };
  }

  const htmlSnippet = getActionHtmlSnippet(normalized);

  if (htmlSnippet) {
    normalized.htmlSnippet = htmlSnippet;
    normalized.element = normalized.element
      ? {
          ...normalized.element,
          htmlSnippet
        }
      : normalized.element;
    normalized.locators = {
      ...normalized.locators,
      html: htmlSnippet
    };
  }

  return normalized;
}

function normalizeEvidence(evidence, tabId) {
  if (!evidence || typeof evidence !== "object") {
    return null;
  }

  return {
    id: evidence.id || crypto.randomUUID(),
    category: evidence.category || "evidence",
    level: evidence.level || evidence.category || "evidence",
    message: evidence.message || evidence.failureReason || "",
    timestamp: evidence.timestamp || new Date().toISOString(),
    pageUrl: evidence.pageUrl || "",
    title: evidence.title || "",
    tabId,
    source: evidence.source || evidence.requestUrl || "",
    line: evidence.line || undefined,
    column: evidence.column || undefined,
    stack: evidence.stack || "",
    arguments: evidence.arguments || [],
    transport: evidence.transport || "",
    requestUrl: evidence.requestUrl || "",
    method: evidence.method || "",
    status: typeof evidence.status === "number" ? evidence.status : undefined,
    statusText: evidence.statusText || "",
    failureReason: evidence.failureReason || evidence.message || "",
    startedAt: evidence.startedAt || "",
    endedAt: evidence.endedAt || "",
    lastUserAction: evidence.lastUserAction || null
  };
}

function mergeRecordedActions(actions, action) {
  const nextActions = [...(actions || [])];
  const previousAction = nextActions[nextActions.length - 1];

  if (previousAction && shouldMergeActions(previousAction, action)) {
    nextActions[nextActions.length - 1] = {
      ...previousAction,
      timestamp: action.timestamp,
      value: action.value,
      description: action.description,
      text: action.text,
      htmlSnippet: action.htmlSnippet || previousAction.htmlSnippet,
      element: action.element || previousAction.element,
      locators: action.locators || previousAction.locators,
      target: action.target || previousAction.target,
      step: previousAction.step
    };
    return renumberActions(nextActions);
  }

  if (previousAction?.type === "navigation" && action.type === "navigation" && previousAction.url === action.url) {
    return renumberActions(nextActions);
  }

  nextActions.push(action);
  return renumberActions(nextActions);
}

function shouldMergeActions(previousAction, action) {
  const previousIsTextInput = previousAction.type === "input" || previousAction.type === "change";
  const currentIsTextInput = action.type === "input" || action.type === "change";

  return (
    previousIsTextInput &&
    currentIsTextInput &&
    previousAction.targetKey === action.targetKey &&
    (previousAction.url || previousAction.pageUrl) === (action.url || action.pageUrl)
  );
}

function renumberActions(actions) {
  return actions.map((action, index) => ({
    ...action,
    step: index + 1
  }));
}

function markStopped(session) {
  const stoppedAt = new Date().toISOString();

  return {
    ...session,
    isRecording: false,
    contentIsRecording: false,
    status: "stopped",
    stoppedAt,
    rawEvents: [
      ...(session.rawEvents || []),
      {
        id: crypto.randomUUID(),
        type: "session-stopped",
        timestamp: stoppedAt,
        url: session.currentUrl,
        title: session.currentTitle
      }
    ]
  };
}

function trimSession(session) {
  return {
    ...session,
    recordedActions: (session.recordedActions || []).slice(-MAX_ACTIONS),
    consoleWarnings: (session.consoleWarnings || []).slice(-MAX_EVIDENCE),
    consoleErrors: (session.consoleErrors || []).slice(-MAX_EVIDENCE),
    javascriptErrors: (session.javascriptErrors || []).slice(-MAX_EVIDENCE),
    promiseRejections: (session.promiseRejections || []).slice(-MAX_EVIDENCE),
    networkErrors: (session.networkErrors || []).slice(-MAX_EVIDENCE),
    screenshots: (session.screenshots || []).slice(-MAX_SCREENSHOTS),
    pageLoadSnapshots: (session.pageLoadSnapshots || []).slice(-MAX_PAGE_SNAPSHOTS),
    rawEvents: (session.rawEvents || []).slice(-1000)
  };
}

function mergeVisitedPages(pages, url, title, reason) {
  if (!url) {
    return pages || [];
  }

  const nextPages = [...(pages || [])];
  const previous = nextPages[nextPages.length - 1];

  if (previous?.url === url) {
    nextPages[nextPages.length - 1] = {
      ...previous,
      title: title || previous.title,
      lastSeenAt: new Date().toISOString(),
      reasons: Array.from(new Set([...(previous.reasons || []), reason || "seen"]))
    };
    return nextPages;
  }

  nextPages.push(buildVisitedPage(url, title, reason || "seen"));
  return nextPages.slice(-100);
}

function buildVisitedPage(url, title, reason) {
  const timestamp = new Date().toISOString();

  return {
    url,
    title: title || "",
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    reasons: [reason || "seen"]
  };
}

function buildDefaultEnvironment(tab) {
  const userAgent = navigator.userAgent || "";
  const browserName = detectBrowserName(userAgent);
  const browserVersion = detectBrowserVersion(userAgent, browserName);
  const now = new Date().toISOString();

  return {
    browser: [browserName, browserVersion].filter(Boolean).join(" "),
    browserName,
    browserVersion,
    userAgent,
    url: tab.url || "",
    pageTitle: tab.title || "",
    viewport: {
      width: 0,
      height: 0,
      devicePixelRatio: 0
    },
    screen: {
      width: 0,
      height: 0,
      availWidth: 0,
      availHeight: 0,
      colorDepth: 0
    },
    platform: navigator.platform || "",
    osPlatform: navigator.platform || "",
    language: navigator.language || "",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    devicePixelRatio: 0,
    timestamp: now,
    capturedAt: now,
    extensionVersion: getExtensionVersion()
  };
}

function buildEnvironmentFromSnapshot(snapshot, fallback) {
  const userAgent = snapshot.userAgent || fallback?.userAgent || navigator.userAgent || "";
  const browserName = detectBrowserName(userAgent);
  const browserVersion = detectBrowserVersion(userAgent, browserName);
  const viewport = snapshot.viewport || fallback?.viewport || { width: 0, height: 0, devicePixelRatio: 0 };
  const timestamp = snapshot.timestamp || fallback?.timestamp || fallback?.capturedAt || new Date().toISOString();

  return {
    browser: [browserName, browserVersion].filter(Boolean).join(" "),
    browserName,
    browserVersion,
    userAgent,
    url: snapshot.url || fallback?.url || "",
    pageTitle: snapshot.title || fallback?.pageTitle || "",
    viewport,
    screen: snapshot.screen || fallback?.screen || {},
    platform: snapshot.platform || fallback?.platform || "",
    osPlatform: snapshot.platform || fallback?.osPlatform || fallback?.platform || "",
    language: snapshot.language || fallback?.language || "",
    timeZone: snapshot.timeZone || fallback?.timeZone || "",
    devicePixelRatio: viewport.devicePixelRatio || fallback?.devicePixelRatio || 0,
    timestamp,
    capturedAt: timestamp,
    extensionVersion: getExtensionVersion()
  };
}

function normalizeReportMetadata(value) {
  return {
    bugTitle: sanitizeMetadataField(value?.bugTitle),
    description: sanitizeMetadataField(value?.description),
    expectedResult: sanitizeMetadataField(value?.expectedResult),
    actualResult: sanitizeMetadataField(value?.actualResult),
    additionalNotes: sanitizeMetadataField(value?.additionalNotes)
  };
}

function sanitizeMetadataField(value) {
  return typeof value === "string" ? value : "";
}

function normalizeEnvironment(value) {
  const fallback = buildDefaultEnvironment({ url: "", title: "" });
  const source = value && typeof value === "object" ? value : fallback;
  const userAgent = source.userAgent || fallback.userAgent || "";
  const browserName = source.browserName || detectBrowserName(userAgent);
  const browserVersion = source.browserVersion || detectBrowserVersion(userAgent, browserName);
  const viewport = source.viewport || fallback.viewport;
  const timestamp = source.timestamp || source.capturedAt || fallback.timestamp;

  return {
    ...source,
    browser: source.browser || [browserName, browserVersion].filter(Boolean).join(" "),
    browserName,
    browserVersion,
    userAgent,
    url: source.url || "",
    pageTitle: source.pageTitle || "",
    viewport,
    screen: source.screen || fallback.screen,
    platform: source.platform || "",
    osPlatform: source.osPlatform || source.platform || "",
    language: source.language || "",
    timeZone: source.timeZone || "",
    devicePixelRatio: source.devicePixelRatio || viewport?.devicePixelRatio || 0,
    timestamp,
    capturedAt: source.capturedAt || timestamp,
    extensionVersion: source.extensionVersion || getExtensionVersion()
  };
}

function isActiveSession(session) {
  return (
    session &&
    session.isRecording === true &&
    typeof session.sessionId === "string" &&
    typeof session.activeRecordingTabId === "number"
  );
}

async function getSession() {
  const items = await getStorageValue({ [RECORDING_STATE_KEY]: null });
  return normalizeSession(items[RECORDING_STATE_KEY]);
}

async function updateSession(updater, reason) {
  const update = writeChain
    .catch(() => undefined)
    .then(async () => {
      const current = await getSession();
      const next = updater(current);

      if (next) {
        await setSession(next, reason);
      }

      return next;
    });

  writeChain = update.catch(() => undefined);
  return update;
}

async function setSession(session, reason) {
  console.log(`${DEBUG_PREFIX} state write`, {
    reason,
    sessionId: session.sessionId,
    isRecording: session.isRecording,
    actions: session.recordedActions?.length || 0
  });
  await setStorageValue(RECORDING_STATE_KEY, session);
}

function normalizeSession(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    ...value,
    project: value.project || PRODUCT_NAME,
    sourceProject: value.sourceProject || SOURCE_PROJECT,
    exportType: value.exportType || "bug-report",
    isRecording: value.isRecording === true,
    contentIsRecording: value.contentIsRecording === true,
    status: value.isRecording === true ? "recording" : value.status || "stopped",
    activeRecordingTabId: typeof value.activeRecordingTabId === "number" ? value.activeRecordingTabId : null,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : value.currentSessionId || null,
    currentSessionId: value.currentSessionId || value.sessionId || null,
    savedAt: value.savedAt || null,
    reportMetadata: normalizeReportMetadata(value.reportMetadata),
    environment: normalizeEnvironment(value.environment),
    recordedActions: Array.isArray(value.recordedActions) ? value.recordedActions : [],
    consoleWarnings: Array.isArray(value.consoleWarnings) ? value.consoleWarnings : [],
    consoleErrors: Array.isArray(value.consoleErrors) ? value.consoleErrors : [],
    javascriptErrors: Array.isArray(value.javascriptErrors) ? value.javascriptErrors : [],
    promiseRejections: Array.isArray(value.promiseRejections) ? value.promiseRejections : [],
    networkErrors: Array.isArray(value.networkErrors) ? value.networkErrors : [],
    screenshots: Array.isArray(value.screenshots) ? value.screenshots : [],
    visitedPages: Array.isArray(value.visitedPages) ? value.visitedPages : [],
    pageLoadSnapshots: Array.isArray(value.pageLoadSnapshots) ? value.pageLoadSnapshots : [],
    rawEvents: Array.isArray(value.rawEvents) ? value.rawEvents : [],
    lastWarning: value.lastWarning || "",
    screenshotCaptureWarning: value.screenshotCaptureWarning || ""
  };
}

async function ensureContentScript(tabId) {
  const ping = await pingContentScript(tabId);

  if (ping?.ok) {
    return;
  }

  await executeContentScript(tabId);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(150);
    const response = await pingContentScript(tabId);

    if (response?.ok) {
      return;
    }
  }

  throw new Error("Content script could not be initialized for this page.");
}

async function pingContentScript(tabId) {
  try {
    return await sendTabMessage(tabId, { type: "PING_BUG_REPORT_GENERATOR" });
  } catch (_error) {
    return null;
  }
}

async function executeContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] }, () => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}

async function sendTabMessageWithRetry(tabId, message) {
  try {
    return await sendTabMessage(tabId, message);
  } catch (error) {
    if (!String(error?.message || "").includes("Receiving end does not exist")) {
      throw error;
    }

    await executeContentScript(tabId);
    await sleep(250);
    return sendTabMessage(tabId, message);
  }
}

async function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

async function getActiveTab() {
  const tabs = await chromeTabsQuery({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab) {
    throw new Error("No active tab found in the current window.");
  }

  return tab;
}

async function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(tab);
    });
  });
}

async function chromeTabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(tabs);
    });
  });
}

async function captureVisibleTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(dataUrl);
    });
  });
}

async function downloadText(filename, mimeType, text) {
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(text)}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false
      },
      (downloadId) => {
        const runtimeError = chrome.runtime.lastError;

        if (runtimeError?.message) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(downloadId);
      }
    );
  });
}

async function getStorageValue(defaults) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(defaults, (items) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(items);
    });
  });
}

async function setStorageValue(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}

async function removeStorageValue(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}

function assertSupportedUrl(url) {
  if (!isSupportedUrl(url)) {
    throw new Error("This page cannot be recorded. Open a normal http or https website tab.");
  }
}

function isSupportedUrl(rawUrl) {
  if (!rawUrl) {
    return false;
  }

  if (
    rawUrl.startsWith("chrome://") ||
    rawUrl.startsWith("edge://") ||
    rawUrl.startsWith("about:") ||
    rawUrl.startsWith("chrome-extension://")
  ) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && !isChromeWebStoreUrl(url);
  } catch (_error) {
    return false;
  }
}

function isChromeWebStoreUrl(url) {
  return (
    url.hostname === "chromewebstore.google.com" ||
    (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"))
  );
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

function getExtensionVersion() {
  return chrome.runtime.getManifest().version || "";
}

function withoutDataUrl(screenshot) {
  const { dataUrl, ...rest } = screenshot;
  return {
    ...rest,
    hasDataUrl: Boolean(dataUrl)
  };
}

function formatTimestampForFile(date) {
  const pad = (value) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function sanitizeFilename(value) {
  const text = String(value || "").replace(/[^a-zA-Z0-9._-]/g, "-");
  return text || formatTimestampForFile(new Date());
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function getErrorMessage(error, fallback) {
  return error instanceof Error ? error.message : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
