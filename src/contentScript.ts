import type {
  BrowserEnvironment,
  ConsoleEventRecord,
  GetPageContextMessage,
  PageContextResponse,
  PingContentScriptMessage,
} from './types';

const CONSOLE_EVENT_NAME = 'bug-report-generator:console';
const CONTENT_SCRIPT_FLAG = '__bugReportGeneratorContentScriptInstalled';
const MAX_CONSOLE_EVENTS = 100;
let memoryConsoleEvents: ConsoleEventRecord[] = [];

interface ContentScriptWindow extends Window {
  [CONTENT_SCRIPT_FLAG]?: boolean;
}

if (!(window as ContentScriptWindow)[CONTENT_SCRIPT_FLAG]) {
  (window as ContentScriptWindow)[CONTENT_SCRIPT_FLAG] = true;
  injectPageLogger();
  attachConsoleBridge();
  attachResourceErrorCapture();
  attachMessageListener();
}

function injectPageLogger(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('assets/pageLogger.js');
  script.async = false;
  script.dataset.bugReportGenerator = 'page-logger';

  const parent = document.documentElement || document.head || document.body;

  if (!parent) {
    window.setTimeout(injectPageLogger, 0);
    return;
  }

  parent.appendChild(script);
  script.remove();
}

function attachConsoleBridge(): void {
  window.addEventListener(CONSOLE_EVENT_NAME, (event) => {
    const detail = (event as CustomEvent<ConsoleEventRecord>).detail;

    if (!isConsoleEventRecord(detail)) {
      return;
    }

    pushConsoleEvent(detail);
  });
}

function attachResourceErrorCapture(): void {
  window.addEventListener(
    'error',
    (event) => {
      const target = event.target;

      if (!target || target === window || !(target instanceof HTMLElement)) {
        return;
      }

      const source = getElementSource(target);
      const tagName = target.tagName.toLowerCase();

      pushConsoleEvent({
        id: crypto.randomUUID(),
        level: 'resource-error',
        message: `Failed to load ${tagName}${source ? `: ${source}` : ''}`,
        timestamp: new Date().toISOString(),
        source,
      });
    },
    true,
  );
}

function attachMessageListener(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isPingMessage(message)) {
      sendResponse({ ok: true });
      return false;
    }

    if (isGetPageContextMessage(message)) {
      sendResponse(getPageContext());
      return false;
    }

    return false;
  });
}

function getPageContext(): PageContextResponse {
  return {
    environment: collectEnvironment(),
    consoleErrors: getConsoleEvents(),
  };
}

function collectEnvironment(): BrowserEnvironment {
  return {
    url: window.location.href,
    pageTitle: document.title || 'Untitled page',
    userAgent: navigator.userAgent,
    browserName: detectBrowserName(navigator.userAgent),
    platform: navigator.platform,
    language: navigator.language,
    cookieEnabled: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown time zone',
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      colorDepth: window.screen.colorDepth,
    },
    capturedAt: new Date().toISOString(),
  };
}

function pushConsoleEvent(record: ConsoleEventRecord): void {
  const existingEvents = getConsoleEvents();
  existingEvents.push(record);

  if (existingEvents.length > MAX_CONSOLE_EVENTS) {
    existingEvents.splice(0, existingEvents.length - MAX_CONSOLE_EVENTS);
  }

  memoryConsoleEvents = existingEvents;

  try {
    window.sessionStorage.setItem(getConsoleStorageKey(), JSON.stringify(existingEvents));
  } catch {
    // Some pages disable sessionStorage. The in-memory buffer still serves the active page.
  }
}

function getConsoleEvents(): ConsoleEventRecord[] {
  try {
    const rawEvents = window.sessionStorage.getItem(getConsoleStorageKey());
    const parsedEvents = rawEvents ? JSON.parse(rawEvents) : [];
    return Array.isArray(parsedEvents) ? parsedEvents.filter(isConsoleEventRecord) : memoryConsoleEvents;
  } catch {
    return memoryConsoleEvents;
  }
}

function getConsoleStorageKey(): string {
  return `bugReportGenerator.consoleEvents:${window.location.href}`;
}

function getElementSource(element: HTMLElement): string | undefined {
  if (element instanceof HTMLImageElement || element instanceof HTMLScriptElement) {
    return element.src || undefined;
  }

  if (element instanceof HTMLLinkElement) {
    return element.href || undefined;
  }

  if (element instanceof HTMLIFrameElement) {
    return element.src || undefined;
  }

  if (element instanceof HTMLSourceElement) {
    return element.src || element.srcset || undefined;
  }

  return undefined;
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

function isPingMessage(message: unknown): message is PingContentScriptMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === 'PING_BUG_REPORT_GENERATOR'
  );
}

function isGetPageContextMessage(message: unknown): message is GetPageContextMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === 'GET_PAGE_CONTEXT'
  );
}

function isConsoleEventRecord(value: unknown): value is ConsoleEventRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<ConsoleEventRecord>;

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.level === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.timestamp === 'string'
  );
}
