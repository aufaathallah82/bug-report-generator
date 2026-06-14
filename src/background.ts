import type {
  ActionRecordedMessage,
  BrowserEnvironment,
  BugReport,
  BugReportDraft,
  ContentScriptReadyMessage,
  GenerateBugReportMessage,
  GenerateBugReportResponse,
  GetRecordingStateMessage,
  NavigationDetectedMessage,
  PageContextResponse,
  RecordedUserAction,
  ResumeCaptureMessage,
  StartCaptureMessage,
  StopCaptureMessage,
  UpdateRecordedActionsMessage,
  UserActionCaptureResponse,
  UserActionCaptureSession,
} from './types';
import { BUG_REPORTS_STORAGE_KEY, MAX_STORED_REPORTS, RECORDING_STATE_KEY } from './types';

const DEBUG_PREFIX = '[BugReportGenerator][background]';
const CONTENT_SCRIPT_FLAG = '__BUG_REPORT_GENERATOR_CONTENT_SCRIPT_INSTALLED__';
const CONTENT_SCRIPT_FILE = 'contentScript.js';
const UNSUPPORTED_CAPTURE_PAGE_MESSAGE = 'This page cannot be captured. Please open a normal website tab.';
const START_CAPTURE_FAILURE_MESSAGE = 'Capture could not start. Please refresh this tab or open a normal website tab.';

let captureSessionWriteChain: Promise<unknown> = Promise.resolve();

type ActiveRecordingSession = UserActionCaptureSession & {
  isRecording: true;
  activeRecordingTabId: number;
  sessionId: string;
  startedAt: string;
  currentUrl: string;
};

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  const recordingStateChange = changes[RECORDING_STATE_KEY];

  if (!recordingStateChange) {
    return;
  }

  console.log('[BugReportGenerator][debug] recordingState changed', {
    oldValue: recordingStateChange.oldValue,
    newValue: recordingStateChange.newValue,
    sourceGuess: 'background observed chrome.storage.onChanged',
  });
});

const defaultEnvironment = (tab: chrome.tabs.Tab, warnings: string[]): BrowserEnvironment => {
  warnings.push('Page context was unavailable, so environment information was built from extension context.');

  return {
    url: tab.url || 'Unknown URL',
    pageTitle: tab.title || 'Untitled page',
    userAgent: navigator.userAgent,
    browserName: detectBrowserName(navigator.userAgent),
    platform: navigator.platform,
    language: navigator.language,
    cookieEnabled: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown time zone',
    viewport: {
      width: 0,
      height: 0,
      devicePixelRatio: 0,
    },
    screen: {
      width: 0,
      height: 0,
      availWidth: 0,
      availHeight: 0,
      colorDepth: 0,
    },
    capturedAt: new Date().toISOString(),
  };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isGenerateBugReportMessage(message)) {
    generateBugReport(message.draft)
      .then((report) => sendResponse({ ok: true, report } satisfies GenerateBugReportResponse))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to generate bug report.',
        } satisfies GenerateBugReportResponse);
      });

    return true;
  }

  if (isStartCaptureRequest(message)) {
    startUserActionCapture()
      .then((session) => sendResponse({ ok: true, session } satisfies UserActionCaptureResponse))
      .catch((error: unknown) => {
        console.error(`${DEBUG_PREFIX} START_CAPTURE failed`, error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to start capture.',
        } satisfies UserActionCaptureResponse);
      });

    return true;
  }

  if (isStopCaptureRequest(message)) {
    stopUserActionCapture()
      .then((session) => sendResponse({ ok: true, session } satisfies UserActionCaptureResponse))
      .catch((error: unknown) => {
        console.error(`${DEBUG_PREFIX} STOP_CAPTURE failed`, error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to stop capture.',
        } satisfies UserActionCaptureResponse);
      });

    return true;
  }

  if (isGetUserActionCaptureStateMessage(message)) {
    getCaptureSession()
      .then((session) => sendResponse({ ok: true, session } satisfies UserActionCaptureResponse))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to read capture state.',
        } satisfies UserActionCaptureResponse);
      });

    return true;
  }

  if (isGetRecordingStateMessage(message)) {
    getCaptureSession()
      .then((session) => sendResponse({ ok: true, session } satisfies UserActionCaptureResponse))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to read recording state.',
        } satisfies UserActionCaptureResponse);
      });

    return true;
  }

  if (isUpdateRecordedActionsMessage(message)) {
    updateRecordedActions(message)
      .then((session) => sendResponse({ ok: true, session } satisfies UserActionCaptureResponse))
      .catch((error: unknown) => {
        console.error(`${DEBUG_PREFIX} UPDATE_RECORDED_ACTIONS failed`, error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to update recorded actions.',
        } satisfies UserActionCaptureResponse);
      });

    return true;
  }

  if (isContentScriptReadyMessage(message)) {
    handleContentScriptReady(message, sender)
      .then((session) => sendResponse({ ok: true, session } satisfies UserActionCaptureResponse))
      .catch((error: unknown) => {
        console.error(`${DEBUG_PREFIX} CONTENT_SCRIPT_READY failed`, error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to resume capture.',
        } satisfies UserActionCaptureResponse);
      });

    return true;
  }

  if (isActionRecordedMessage(message)) {
    appendRecordedAction(message)
      .then((session) => sendResponse({ ok: true, session } satisfies UserActionCaptureResponse))
      .catch((error: unknown) => {
        console.error(`${DEBUG_PREFIX} ACTION_RECORDED append failed`, error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to save recorded action.',
        } satisfies UserActionCaptureResponse);
      });

    return true;
  }

  if (isNavigationDetectedMessage(message)) {
    console.log(`${DEBUG_PREFIX} NAVIGATION_DETECTED`, {
      sessionId: message.sessionId,
      url: message.url,
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  console.log(`${DEBUG_PREFIX} tab updated`, {
    tabId,
    status: changeInfo.status,
    url: changeInfo.url || tab.url,
  });

  void handleTabUpdated(tabId, changeInfo, tab).catch((error: unknown) => {
    console.error(`${DEBUG_PREFIX} tab update resume failed`, error);
  });
});

async function generateBugReport(draft: BugReportDraft): Promise<BugReport> {
  const warnings: string[] = [];
  const tab = await getActiveTab();

  if (!tab.id) {
    throw new Error('No active tab is available.');
  }

  const [screenshotDataUrl, pageContext] = await Promise.all([
    captureScreenshot(tab).catch((error: unknown) => {
      warnings.push(getErrorMessage(error, 'Screenshot capture failed.'));
      return undefined;
    }),
    getPageContext(tab.id).catch((error: unknown) => {
      warnings.push(getErrorMessage(error, 'Page context capture failed.'));
      return undefined;
    }),
  ]);

  const environmentInformation = pageContext?.environment ?? defaultEnvironment(tab, warnings);
  const consoleErrors = pageContext?.consoleErrors ?? [];
  const report = buildReport(draft, environmentInformation, consoleErrors, screenshotDataUrl, warnings);

  await storeReport(report);

  return report;
}

async function startUserActionCapture(): Promise<UserActionCaptureSession> {
  const tab = await getActiveTab();

  if (!tab.id) {
    throw new Error('No active tab is available.');
  }

  console.log(`${DEBUG_PREFIX} active tab`, { id: tab.id, url: tab.url });
  assertTabCanBeCaptured(tab);
  await ensureContentScript(tab.id);

  const currentUrl = tab.url || 'Unknown URL';
  const sessionId = crypto.randomUUID();
  const session: ActiveRecordingSession = {
    isRecording: true,
    contentIsRecording: true,
    activeRecordingTabId: tab.id,
    sessionId,
    currentSessionId: sessionId,
    recordedActions: [],
    startedAt: new Date().toISOString(),
    currentUrl,
  };

  await setRecordingState(session, 'START_CAPTURE:create-active-session');
  console.log(`${DEBUG_PREFIX} START_CAPTURE session created`, {
    sessionId: session.sessionId,
    activeRecordingTabId: session.activeRecordingTabId,
    currentUrl: session.currentUrl,
  });

  try {
    await sendStartCapture(tab.id, session);
  } catch (error) {
    console.warn(`${DEBUG_PREFIX} START_CAPTURE acknowledgement failed; storage session remains active`, error);
  }

  return session;
}

async function stopUserActionCapture(): Promise<UserActionCaptureSession> {
  const session = await getCaptureSession();

  if (!isActiveRecordingSession(session)) {
    throw new Error('No active capture session was found.');
  }

  console.log(`${DEBUG_PREFIX} STOP_CAPTURE received`, {
    tabId: session.activeRecordingTabId,
    sessionId: session.sessionId,
  });
  console.log(`${DEBUG_PREFIX} STOP_CAPTURE sent`, {
    tabId: session.activeRecordingTabId,
    sessionId: session.sessionId,
  });

  try {
    await sendTabMessage<{ ok: boolean }>(session.activeRecordingTabId, {
      type: 'STOP_CAPTURE',
      sessionId: session.sessionId,
    } satisfies StopCaptureMessage);
  } catch (error) {
    console.warn(`${DEBUG_PREFIX} STOP_CAPTURE tab message failed; marking storage stopped`, error);
  }

  const stoppedSession = await updateRecordingState((currentSession) => {
    if (!currentSession || currentSession.sessionId !== session.sessionId) {
      return {
        ...session,
        stoppedAt: new Date().toISOString(),
        isRecording: false,
        contentIsRecording: false,
        currentSessionId: session.sessionId,
      };
    }

    return {
      ...currentSession,
      stoppedAt: new Date().toISOString(),
      isRecording: false,
      contentIsRecording: false,
      currentSessionId: currentSession.sessionId,
    };
  }, 'STOP_CAPTURE:mark-inactive');

  if (!stoppedSession) {
    throw new Error('No active capture session was found.');
  }

  console.log(`${DEBUG_PREFIX} STOP_CAPTURE session stopped`, {
    sessionId: stoppedSession.sessionId,
    recordedActions: stoppedSession.recordedActions.length,
  });
  console.log(`${DEBUG_PREFIX} recording state stopped`, {
    sessionId: stoppedSession.sessionId,
    recordedActions: stoppedSession.recordedActions.length,
  });

  return stoppedSession;
}

async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
  const session = await getCaptureSession();

  if (!isActiveRecordingSession(session) || session.activeRecordingTabId !== tabId) {
    return;
  }

  if (changeInfo.url) {
    await saveNavigationAction(tabId, changeInfo.url);
  }

  if (changeInfo.status !== 'complete') {
    return;
  }

  const currentUrl = tab.url || changeInfo.url || session.currentUrl;

  if (!isSupportedCaptureUrl(currentUrl)) {
    return;
  }

  console.log(`${DEBUG_PREFIX} active recording tab completed load`, {
    tabId,
    sessionId: session.sessionId,
    url: currentUrl,
  });
  console.log(`${DEBUG_PREFIX} active recording tab reloaded`, {
    tabId,
    sessionId: session.sessionId,
    url: currentUrl,
  });
  await resumeCaptureForTab(tabId, currentUrl, 'tab-updated');
}

async function handleContentScriptReady(
  message: ContentScriptReadyMessage,
  sender: chrome.runtime.MessageSender,
): Promise<UserActionCaptureSession | undefined> {
  const tabId = sender.tab?.id;

  console.log(`${DEBUG_PREFIX} CONTENT_SCRIPT_READY`, {
    tabId,
    url: message.url,
  });

  if (typeof tabId !== 'number') {
    return undefined;
  }

  const session = await getCaptureSession();

  if (!isActiveRecordingSession(session) || session.activeRecordingTabId !== tabId) {
    return undefined;
  }

  await resumeCaptureForTab(tabId, message.url, 'content-ready');
  return getCaptureSession();
}

async function resumeCaptureForTab(tabId: number, currentUrl: string, reason: string): Promise<void> {
  let session = await getCaptureSession();

  if (!isActiveRecordingSession(session) || session.activeRecordingTabId !== tabId) {
    return;
  }

  if (currentUrl && currentUrl !== session.currentUrl) {
    session = await saveNavigationAction(tabId, currentUrl);
  }

  if (!isActiveRecordingSession(session) || session.activeRecordingTabId !== tabId) {
    return;
  }

  console.log(`${DEBUG_PREFIX} reinjecting content script after navigation`, {
    tabId,
    sessionId: session.sessionId,
    reason,
    url: currentUrl,
  });
  await ensureContentScript(tabId);
  await sendResumeCapture(tabId, session);
}

async function sendStartCapture(tabId: number, session: ActiveRecordingSession): Promise<void> {
  const message: StartCaptureMessage = {
    type: 'START_CAPTURE',
    sessionId: session.sessionId,
    tabId,
  };

  console.log(`${DEBUG_PREFIX} START_CAPTURE sent`, { tabId, sessionId: session.sessionId });

  try {
    const response = await sendTabMessageWithRetry<{ ok: boolean; status?: string }>(tabId, message);
    console.log(`${DEBUG_PREFIX} START_CAPTURE response`, response);

    if (!response?.ok) {
      throw new Error(START_CAPTURE_FAILURE_MESSAGE);
    }
  } catch (error) {
    console.error(`${DEBUG_PREFIX} START_CAPTURE tab message failed after retry`, error);
    throw new Error(START_CAPTURE_FAILURE_MESSAGE);
  }
}

async function sendResumeCapture(tabId: number, session: ActiveRecordingSession): Promise<void> {
  const message: ResumeCaptureMessage = {
    type: 'RESUME_CAPTURE',
    sessionId: session.sessionId,
    tabId,
    currentUrl: session.currentUrl,
  };

  console.log(`${DEBUG_PREFIX} RESUME_CAPTURE sent`, {
    tabId,
    sessionId: session.sessionId,
    currentUrl: session.currentUrl,
  });

  const response = await sendTabMessageWithRetry<{ ok: boolean; status?: string }>(tabId, message);
  console.log(`${DEBUG_PREFIX} RESUME_CAPTURE response`, response);
}

async function saveNavigationAction(
  tabId: number,
  url: string,
): Promise<UserActionCaptureSession | undefined> {
  const updatedSession = await updateRecordingState((session) => {
    if (!isActiveRecordingSession(session) || session.activeRecordingTabId !== tabId) {
      return session;
    }

    return appendNavigationAction(session, url);
  }, 'NAVIGATION:append-navigation-action');

  if (updatedSession?.activeRecordingTabId === tabId && updatedSession.currentUrl === url) {
    console.log(`${DEBUG_PREFIX} navigation action saved`, {
      tabId,
      sessionId: updatedSession.sessionId,
      url,
      recordedActions: updatedSession.recordedActions.length,
    });
  }

  return updatedSession;
}

async function appendRecordedAction(message: ActionRecordedMessage): Promise<UserActionCaptureSession | undefined> {
  console.log(`${DEBUG_PREFIX} ACTION_RECORDED`, {
    sessionId: message.sessionId,
    type: message.action.type,
    url: message.action.pageUrl,
  });

  const updatedSession = await updateRecordingState((session) => {
    if (!session?.isRecording || session.sessionId !== message.sessionId) {
      throw new Error('Recording state is inactive or session id does not match.');
    }

    const recordedActions = mergeRecordedAction(session.recordedActions, message.action);

    return {
      ...session,
      currentUrl: message.action.pageUrl,
      recordedActions: recordedActions.slice(-200),
    };
  }, `ACTION_RECORDED:${message.action.type}`);

  if (updatedSession) {
    console.log(`${DEBUG_PREFIX} action persisted`, {
      sessionId: updatedSession.sessionId,
      recordedActions: updatedSession.recordedActions.length,
    });
  }

  return updatedSession;
}

async function updateRecordedActions(message: UpdateRecordedActionsMessage): Promise<UserActionCaptureSession | undefined> {
  return updateRecordingState((session) => {
    if (!session) {
      throw new Error('No recording state is available.');
    }

    if (session.isRecording) {
      throw new Error('Cannot edit recorded actions while capture is running.');
    }

    return {
      ...session,
      recordedActions: message.recordedActions,
    };
  }, 'POPUP:update-recorded-actions-after-stop');
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chromeTabsQuery({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (!activeTab) {
    throw new Error('No active tab found in the current window.');
  }

  return activeTab;
}

async function captureScreenshot(tab: chrome.tabs.Tab): Promise<string | undefined> {
  const windowId = tab.windowId;

  return new Promise((resolve, reject) => {
    const handleCapture = (dataUrl?: string) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(dataUrl);
    };

    if (typeof windowId === 'number') {
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, handleCapture);
      return;
    }

    chrome.tabs.captureVisibleTab({ format: 'png' }, handleCapture);
  });
}

async function getPageContext(tabId: number): Promise<PageContextResponse> {
  await ensureContentScript(tabId);

  const response = await sendTabMessage<PageContextResponse>(tabId, { type: 'GET_PAGE_CONTEXT' });

  if (!response) {
    throw new Error('Content script did not return page context.');
  }

  return response;
}

async function ensureContentScript(tabId: number): Promise<void> {
  const readyResponse = await pingContentScript(tabId);

  if (isContentScriptPingResponse(readyResponse)) {
    console.log(`${DEBUG_PREFIX} content script already ready`, readyResponse);
    return;
  }

  await resetStaleContentScriptFlag(tabId).catch((error: unknown) => {
    console.warn(`${DEBUG_PREFIX} stale content-script flag reset failed`, error);
  });
  await injectContentScript(tabId);
  await sleep(300);

  const injectedResponse = await waitForContentScript(tabId);

  if (!isContentScriptPingResponse(injectedResponse)) {
    throw new Error(START_CAPTURE_FAILURE_MESSAGE);
  }
}

async function waitForContentScript(tabId: number): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await pingContentScript(tabId);

    if (isContentScriptPingResponse(response)) {
      return response;
    }

    await sleep(200);
  }

  return undefined;
}

async function pingContentScript(tabId: number): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response: { ok: boolean; source?: string } | undefined) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        console.debug(`${DEBUG_PREFIX} PING had no content-script receiver`, { tabId });
        resolve(undefined);
        return;
      }

      console.log(`${DEBUG_PREFIX} PING response`, response);
      resolve(response);
    });
  });
}

async function injectContentScript(tabId: number): Promise<void> {
  console.log(`${DEBUG_PREFIX} injecting content script`, { tabId, file: CONTENT_SCRIPT_FILE });

  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] }, () => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        console.error(`${DEBUG_PREFIX} injection failed`, runtimeError.message);
        reject(new Error(runtimeError.message));
        return;
      }

      console.log(`${DEBUG_PREFIX} injection success`, { tabId, file: CONTENT_SCRIPT_FILE });
      resolve();
    });
  });
}

async function resetStaleContentScriptFlag(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: (flagName: string) => {
          delete (window as unknown as Record<string, unknown>)[flagName];
        },
        args: [CONTENT_SCRIPT_FLAG],
      },
      () => {
        const runtimeError = chrome.runtime.lastError;

        if (runtimeError?.message) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      },
    );
  });
}

async function sendTabMessageWithRetry<TResponse>(tabId: number, message: unknown): Promise<TResponse | undefined> {
  try {
    return await sendTabMessage<TResponse>(tabId, message);
  } catch (error) {
    if (!isReceivingEndError(error)) {
      throw error;
    }

    console.warn(`${DEBUG_PREFIX} receiving end missing; reinjecting content script and retrying once`, error);
    await resetStaleContentScriptFlag(tabId).catch(() => undefined);
    await injectContentScript(tabId);
    await sleep(300);
    const response = await pingContentScript(tabId);

    if (!isContentScriptPingResponse(response)) {
      throw error;
    }

    return sendTabMessage<TResponse>(tabId, message);
  }
}

async function sendTabMessage<TResponse>(tabId: number, message: unknown): Promise<TResponse | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: TResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        console.warn(`${DEBUG_PREFIX} chrome.runtime.lastError`, runtimeError.message);
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

async function chromeTabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
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

function buildReport(
  draft: BugReportDraft,
  environmentInformation: BrowserEnvironment,
  consoleErrors: PageContextResponse['consoleErrors'],
  screenshotDataUrl: string | undefined,
  warnings: string[],
): BugReport {
  const pageName = environmentInformation.pageTitle || environmentInformation.url || 'Current tab';
  const title = draft.title.trim() || `Bug report: ${pageName}`;
  const additionalNotes = draft.additionalNotes.trim() || 'None.';
  const description = additionalNotes;
  const stepsToReproduce = draft.stepsToReproduce.length
    ? draft.stepsToReproduce
    : ['Open the captured URL.', 'Reproduce the issue observed during capture.'];
  const expectedResult = draft.expectedResult.trim() || 'Describe the intended behavior.';
  const actualResult = draft.actualResult.trim() || getDefaultActualResult(consoleErrors, Boolean(screenshotDataUrl));

  return {
    id: crypto.randomUUID(),
    title,
    description,
    stepsToReproduce,
    expectedResult,
    actualResult,
    additionalNotes,
    environmentInformation,
    currentUrl: environmentInformation.url,
    screenshotDataUrl,
    consoleErrors,
    networkErrors: [],
    createdAt: new Date().toISOString(),
    warnings,
  };
}

function getDefaultActualResult(consoleErrors: PageContextResponse['consoleErrors'], hasScreenshot: boolean): string {
  const parts = ['Captured browser state for the current tab.'];

  if (hasScreenshot) {
    parts.push('A screenshot is attached in local storage.');
  }

  if (consoleErrors.length > 0) {
    parts.push(`${consoleErrors.length} console/runtime error${consoleErrors.length === 1 ? '' : 's'} captured.`);
  }

  return parts.join(' ');
}

function appendNavigationAction(session: UserActionCaptureSession, url: string): UserActionCaptureSession {
  const previousAction = session.recordedActions[session.recordedActions.length - 1];

  if (previousAction?.type === 'navigation' && previousAction.pageUrl === url) {
    return {
      ...session,
      currentUrl: url,
    };
  }

  return {
    ...session,
    currentUrl: url,
    recordedActions: [...session.recordedActions, createNavigationAction(url)],
  };
}

function mergeRecordedAction(actions: RecordedUserAction[], action: RecordedUserAction): RecordedUserAction[] {
  const nextActions = [...actions];
  const previousAction = nextActions[nextActions.length - 1];

  if (previousAction && shouldMergeActions(previousAction, action)) {
    const mergedType = previousAction.type === 'input' ? 'input' : action.type;
    const mergedText = previousAction.type === 'input' && action.type === 'change' ? previousAction.text : action.text;
    nextActions[nextActions.length - 1] = {
      ...previousAction,
      timestamp: action.timestamp,
      type: mergedType,
      value: action.value,
      text: mergedText,
    };
    return nextActions;
  }

  if (previousAction?.type === 'navigation' && action.type === 'navigation' && previousAction.pageUrl === action.pageUrl) {
    return nextActions;
  }

  nextActions.push(action);
  return nextActions;
}

function shouldMergeActions(previousAction: RecordedUserAction, action: RecordedUserAction): boolean {
  const previousIsTextInput = previousAction.type === 'input' || previousAction.type === 'change';
  const currentIsTextInput = action.type === 'input' || action.type === 'change';

  return (
    previousIsTextInput &&
    currentIsTextInput &&
    previousAction.targetKey === action.targetKey &&
    previousAction.pageUrl === action.pageUrl
  );
}

function createNavigationAction(url: string): RecordedUserAction {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'navigation',
    pageUrl: url,
    targetKey: `navigation:${url}`,
    target: {
      tagName: 'document',
      selector: 'document',
      label: 'page',
    },
    text: `Navigated to ${url}`,
  };
}

async function storeReport(report: BugReport): Promise<void> {
  const storedReports = await getStoredReports();
  const nextReports = [report, ...storedReports].slice(0, MAX_STORED_REPORTS);

  await setStorageValue(BUG_REPORTS_STORAGE_KEY, nextReports);
}

async function getStoredReports(): Promise<BugReport[]> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({ [BUG_REPORTS_STORAGE_KEY]: [] }, (items) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      const reports = items[BUG_REPORTS_STORAGE_KEY];
      resolve(Array.isArray(reports) ? (reports as BugReport[]) : []);
    });
  });
}

async function getCaptureSession(): Promise<UserActionCaptureSession | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({ [RECORDING_STATE_KEY]: undefined }, (items) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(normalizeCaptureSession(items[RECORDING_STATE_KEY]));
    });
  });
}

async function updateRecordingState(
  updater: (session: UserActionCaptureSession | undefined) => UserActionCaptureSession | undefined,
  reason: string,
): Promise<UserActionCaptureSession | undefined> {
  const update = captureSessionWriteChain
    .catch(() => undefined)
    .then(async () => {
      const currentSession = await getCaptureSession();
      const nextSession = updater(currentSession);

      if (nextSession) {
        await setRecordingState(nextSession, reason);
      }

      return nextSession;
    });

  captureSessionWriteChain = update.catch(() => undefined);
  return update;
}

async function setRecordingState(nextState: UserActionCaptureSession, reason: string): Promise<void> {
  console.log('[BugReportGenerator][state-write]', {
    reason,
    nextState,
  });
  await setStorageValue(RECORDING_STATE_KEY, nextState);
}

async function setStorageValue(key: string, value: unknown): Promise<void> {
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

function normalizeCaptureSession(value: unknown): UserActionCaptureSession | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const candidate = value as Partial<UserActionCaptureSession> & {
    actions?: RecordedUserAction[];
    id?: string;
    tabId?: number;
  };
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : candidate.id ?? null;
  const activeRecordingTabId =
    typeof candidate.activeRecordingTabId === 'number' ? candidate.activeRecordingTabId : candidate.tabId ?? null;
  const recordedActions = Array.isArray(candidate.recordedActions)
    ? candidate.recordedActions
    : Array.isArray(candidate.actions)
      ? candidate.actions
      : [];
  const startedAt = typeof candidate.startedAt === 'string' ? candidate.startedAt : null;
  const currentUrl = typeof candidate.currentUrl === 'string' ? candidate.currentUrl : null;

  if (
    typeof candidate.isRecording !== 'boolean' ||
    (sessionId !== null && typeof sessionId !== 'string') ||
    (activeRecordingTabId !== null && typeof activeRecordingTabId !== 'number')
  ) {
    return undefined;
  }

  return {
    isRecording: candidate.isRecording,
    contentIsRecording: candidate.contentIsRecording,
    activeRecordingTabId,
    sessionId,
    currentSessionId: candidate.currentSessionId,
    recordedActions,
    startedAt,
    currentUrl,
    stoppedAt: candidate.stoppedAt,
  };
}

function isActiveRecordingSession(session: UserActionCaptureSession | undefined): session is ActiveRecordingSession {
  return (
    session?.isRecording === true &&
    typeof session.sessionId === 'string' &&
    typeof session.activeRecordingTabId === 'number' &&
    typeof session.startedAt === 'string' &&
    typeof session.currentUrl === 'string'
  );
}

function assertTabCanBeCaptured(tab: chrome.tabs.Tab): void {
  if (!tab.url || !isSupportedCaptureUrl(tab.url)) {
    throw new Error(UNSUPPORTED_CAPTURE_PAGE_MESSAGE);
  }
}

function isSupportedCaptureUrl(rawUrl: string): boolean {
  if (
    rawUrl.startsWith('chrome://') ||
    rawUrl.startsWith('edge://') ||
    rawUrl.startsWith('about:') ||
    rawUrl.startsWith('chrome-extension://')
  ) {
    return false;
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  return !isChromeWebStoreUrl(url);
}

function isChromeWebStoreUrl(url: URL): boolean {
  return (
    url.hostname === 'chromewebstore.google.com' ||
    (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))
  );
}

function isContentScriptPingResponse(response: unknown): response is { ok: true; source: 'contentScript' } {
  if (typeof response !== 'object' || response === null) {
    return false;
  }

  const candidate = response as { ok?: unknown; source?: unknown };
  return candidate.ok === true && candidate.source === 'contentScript';
}

function detectBrowserName(userAgent: string): string {
  if (userAgent.includes('Edg/')) {
    return 'Microsoft Edge';
  }

  if (userAgent.includes('OPR/') || userAgent.includes('Opera/')) {
    return 'Opera';
  }

  if (userAgent.includes('Chrome/')) {
    return 'Google Chrome';
  }

  if (userAgent.includes('Firefox/')) {
    return 'Firefox';
  }

  if (userAgent.includes('Safari/')) {
    return 'Safari';
  }

  return 'Unknown browser';
}

function isGenerateBugReportMessage(message: unknown): message is GenerateBugReportMessage {
  return isMessageType(message, 'GENERATE_BUG_REPORT');
}

function isStartCaptureRequest(message: unknown): message is StartCaptureMessage {
  return isMessageType(message, 'START_CAPTURE') && !('sessionId' in (message as Record<string, unknown>));
}

function isStopCaptureRequest(message: unknown): message is StopCaptureMessage {
  return isMessageType(message, 'STOP_CAPTURE') && !('sessionId' in (message as Record<string, unknown>));
}

function isGetUserActionCaptureStateMessage(message: unknown): boolean {
  return isMessageType(message, 'GET_USER_ACTION_CAPTURE_STATE');
}

function isGetRecordingStateMessage(message: unknown): message is GetRecordingStateMessage {
  return isMessageType(message, 'GET_RECORDING_STATE');
}

function isUpdateRecordedActionsMessage(message: unknown): message is UpdateRecordedActionsMessage {
  return (
    isMessageType(message, 'UPDATE_RECORDED_ACTIONS') &&
    Array.isArray((message as UpdateRecordedActionsMessage).recordedActions)
  );
}

function isContentScriptReadyMessage(message: unknown): message is ContentScriptReadyMessage {
  return isMessageType(message, 'CONTENT_SCRIPT_READY') && typeof (message as ContentScriptReadyMessage).url === 'string';
}

function isActionRecordedMessage(message: unknown): message is ActionRecordedMessage {
  return (
    isMessageType(message, 'ACTION_RECORDED') &&
    typeof (message as ActionRecordedMessage).sessionId === 'string' &&
    typeof (message as ActionRecordedMessage).action === 'object'
  );
}

function isNavigationDetectedMessage(message: unknown): message is NavigationDetectedMessage {
  return (
    isMessageType(message, 'NAVIGATION_DETECTED') &&
    typeof (message as NavigationDetectedMessage).sessionId === 'string' &&
    typeof (message as NavigationDetectedMessage).url === 'string'
  );
}

function isMessageType(message: unknown, type: string): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === type
  );
}

function isReceivingEndError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist');
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
