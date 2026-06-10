import type {
  BrowserEnvironment,
  BugReport,
  BugReportDraft,
  GenerateBugReportMessage,
  GenerateBugReportResponse,
  PageContextResponse,
} from './types';
import { BUG_REPORTS_STORAGE_KEY, MAX_STORED_REPORTS } from './types';

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isGenerateBugReportMessage(message)) {
    return false;
  }

  generateBugReport(message.draft)
    .then((report) => sendResponse({ ok: true, report } satisfies GenerateBugReportResponse))
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to generate bug report.',
      } satisfies GenerateBugReportResponse);
    });

  return true;
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
  const isReady = await pingContentScript(tabId);

  if (!isReady) {
    await injectContentScript(tabId);
    await sleep(150);
  }

  const response = await sendTabMessage<PageContextResponse>(tabId, { type: 'GET_PAGE_CONTEXT' });

  if (!response) {
    throw new Error('Content script did not return page context.');
  }

  return response;
}

async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const response = await sendTabMessage<{ ok: boolean }>(tabId, { type: 'PING_BUG_REPORT_GENERATOR' });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function injectContentScript(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: ['assets/contentScript.js'] }, () => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}

async function sendTabMessage<TResponse>(tabId: number, message: unknown): Promise<TResponse | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: TResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
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
  const description = draft.description.trim() || 'Generated bug report. Add the observed problem and supporting context here.';
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
    environmentInformation,
    currentUrl: environmentInformation.url,
    screenshotDataUrl,
    consoleErrors,
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
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === 'GENERATE_BUG_REPORT'
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
