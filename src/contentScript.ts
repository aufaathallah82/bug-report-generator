import type {
  BrowserEnvironment,
  ConsoleEventRecord,
  GetPageContextMessage,
  PageContextResponse,
  PingContentScriptMessage,
  RecordedActionTarget,
  RecordedActionType,
  RecordedUserAction,
  ResumeCaptureMessage,
  StartCaptureMessage,
  StopCaptureMessage,
  ContentScriptReadyMessage,
  UserActionCaptureSession,
  UserActionCaptureResponse,
} from './types';

const CONSOLE_EVENT_NAME = 'bug-report-generator:console';
const CONTENT_SCRIPT_FLAG = '__BUG_REPORT_GENERATOR_CONTENT_SCRIPT_INSTALLED__';
const MESSAGE_LISTENER_KEY = '__BUG_REPORT_GENERATOR_MESSAGE_LISTENER__';
const STORAGE_LISTENER_KEY = '__BUG_REPORT_GENERATOR_STORAGE_LISTENER__';
const DEBUG_PREFIX = '[BugReportGenerator][content]';
const RECORDING_STATE_KEY = 'bugReportGenerator.recordingState';
const MAX_CONSOLE_EVENTS = 100;
const MAX_CAPTURED_VALUE_LENGTH = 160;
const SENSITIVE_FIELD_TOKENS = ['password', 'token', 'secret', 'api_key', 'authorization', 'credential'];

let memoryConsoleEvents: ConsoleEventRecord[] = [];
let isCapturingActions = false;
let activeSessionId: string | undefined;
let activeCaptureTabId: number | undefined;
let actionCaptureCleanup: Array<() => void> = [];
let navigationWatcherId: number | undefined;
let lastKnownUrl = window.location.href;
let recordingStorageWriteChain: Promise<unknown> = Promise.resolve();

type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;
type StorageChangeListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

interface ContentScriptWindow extends Window {
  [CONTENT_SCRIPT_FLAG]?: boolean;
  [MESSAGE_LISTENER_KEY]?: RuntimeMessageListener;
  [STORAGE_LISTENER_KEY]?: StorageChangeListener;
}

const contentWindow = window as ContentScriptWindow;
const wasInstalled = contentWindow[CONTENT_SCRIPT_FLAG] === true;
contentWindow[CONTENT_SCRIPT_FLAG] = true;

attachMessageListener();
attachStorageCaptureStateListener();

if (!wasInstalled) {
  console.log(`${DEBUG_PREFIX} installed`);
  console.log(`${DEBUG_PREFIX} current page URL`, window.location.href);
  injectPageLogger();
  attachConsoleBridge();
  attachResourceErrorCapture();
  notifyCaptureReady();
} else {
  console.debug(`${DEBUG_PREFIX} already installed`);
}

function injectPageLogger(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('pageLogger.js');
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
  const previousListener = contentWindow[MESSAGE_LISTENER_KEY];

  if (previousListener) {
    chrome.runtime.onMessage.removeListener(previousListener);
  }

  const listener: RuntimeMessageListener = (message, _sender, sendResponse) => {
    if (isPingMessage(message)) {
      console.log(`${DEBUG_PREFIX} PING received`);
      sendResponse({ ok: true, source: 'contentScript' });
      return false;
    }

    if (isGetPageContextMessage(message)) {
      sendResponse(getPageContext());
      return false;
    }

    if (isStartCaptureMessage(message)) {
      startActionCapture(message)
        .then(() => sendResponse({ ok: true, status: 'recording-started' }))
        .catch((error: unknown) => {
          console.error(`${DEBUG_PREFIX} START_CAPTURE failed`, error);
          sendResponse({ ok: false, status: 'recording-start-failed' });
        });
      return true;
    }

    if (isResumeCaptureMessage(message)) {
      resumeActionCapture(message)
        .then(() => sendResponse({ ok: true, status: 'recording-resumed' }))
        .catch((error: unknown) => {
          console.error(`${DEBUG_PREFIX} RESUME_CAPTURE failed`, error);
          sendResponse({ ok: false, status: 'recording-resume-failed' });
        });
      return true;
    }

    if (isStopCaptureMessage(message)) {
      stopActionCapture(message.sessionId)
        .then(() => sendResponse({ ok: true, status: 'recording-stopped' }))
        .catch((error: unknown) => {
          console.error(`${DEBUG_PREFIX} STOP_CAPTURE storage update failed`, error);
          sendResponse({ ok: false, status: 'recording-stop-failed' });
        });

      return true;
    }

    return false;
  };

  contentWindow[MESSAGE_LISTENER_KEY] = listener;
  chrome.runtime.onMessage.addListener(listener);
}

function attachStorageCaptureStateListener(): void {
  const previousListener = contentWindow[STORAGE_LISTENER_KEY];

  if (previousListener) {
    chrome.storage.onChanged.removeListener(previousListener);
  }

  const listener: StorageChangeListener = (changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    const captureChange = changes[RECORDING_STATE_KEY];

    if (!captureChange) {
      return;
    }

    console.log('[BugReportGenerator][debug] recordingState changed', {
      oldValue: captureChange.oldValue,
      newValue: captureChange.newValue,
      sourceGuess: 'content script observed chrome.storage.onChanged',
      contentIsRecording: isCapturingActions,
      currentSessionId: activeSessionId,
      currentTabId: activeCaptureTabId,
    });

    const nextState = normalizeCaptureSession(captureChange.newValue);

    if (
      nextState?.isRecording === false &&
      typeof nextState.sessionId === 'string' &&
      nextState.sessionId === activeSessionId
    ) {
      console.log(`${DEBUG_PREFIX} STOP_CAPTURE observed in storage`, {
        sessionId: activeSessionId,
        source: 'STOP_CAPTURE storage change',
      });
      stopActionCaptureWithoutStorageUpdate();
    }
  };

  contentWindow[STORAGE_LISTENER_KEY] = listener;
  chrome.storage.onChanged.addListener(listener);
}

async function startActionCapture(message: StartCaptureMessage): Promise<void> {
  if (!message.sessionId) {
    return;
  }

  console.log(`${DEBUG_PREFIX} START_CAPTURE received`, {
    sessionId: message.sessionId,
    tabId: message.tabId,
    url: window.location.href,
  });

  if (isCapturingActions && activeSessionId === message.sessionId) {
    await ensureStoredActiveSession(message.sessionId, message.tabId);
    return;
  }

  activateActionCapture(message.sessionId, message.tabId, 'start');
  await ensureStoredActiveSession(message.sessionId, message.tabId);
}

async function resumeActionCapture(message: ResumeCaptureMessage): Promise<void> {
  console.log(`${DEBUG_PREFIX} RESUME_CAPTURE received`, {
    sessionId: message.sessionId,
    tabId: message.tabId,
    currentUrl: message.currentUrl,
    pageUrl: window.location.href,
  });

  if (isCapturingActions && activeSessionId === message.sessionId) {
    await ensureStoredActiveSession(message.sessionId, message.tabId);
    return;
  }

  activateActionCapture(message.sessionId, message.tabId, 'resume');
  await ensureStoredActiveSession(message.sessionId, message.tabId);
}

function activateActionCapture(sessionId: string, tabId?: number, reason: 'start' | 'resume' = 'start'): void {
  stopActionCaptureWithoutStorageUpdate();
  isCapturingActions = true;
  activeSessionId = sessionId;
  activeCaptureTabId = tabId;
  lastKnownUrl = window.location.href;

  addCaptureListener(document, 'click', handleClick, true);
  addCaptureListener(document, 'input', handleInput, true);
  addCaptureListener(document, 'change', handleChange, true);
  addCaptureListener(document, 'submit', handleSubmit, true);
  addCaptureListener(window, 'hashchange', handleNavigationChange);
  addCaptureListener(window, 'popstate', handleNavigationChange);

  navigationWatcherId = window.setInterval(checkForNavigationChange, 500);

  if (reason === 'resume') {
    console.log(`${DEBUG_PREFIX} recording resumed after navigation`, {
      sessionId,
      tabId,
      url: window.location.href,
    });
  }
}

async function stopActionCapture(sessionId?: string): Promise<void> {
  const stoppedSessionId = sessionId || activeSessionId;
  console.log(`${DEBUG_PREFIX} STOP_CAPTURE received`, { sessionId: stoppedSessionId, url: window.location.href });
  stopActionCaptureWithoutStorageUpdate();
}

function stopActionCaptureWithoutStorageUpdate(): void {
  const wasCapturing = isCapturingActions;
  isCapturingActions = false;
  activeSessionId = undefined;
  activeCaptureTabId = undefined;

  actionCaptureCleanup.forEach((cleanup) => cleanup());
  actionCaptureCleanup = [];

  if (navigationWatcherId !== undefined) {
    window.clearInterval(navigationWatcherId);
    navigationWatcherId = undefined;
  }

  if (wasCapturing) {
    console.log(`${DEBUG_PREFIX} recording stopped`, { url: window.location.href });
  }
}

function addCaptureListener<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void;
function addCaptureListener<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void;
function addCaptureListener(
  target: Document | Window,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  target.addEventListener(type, listener, options);
  actionCaptureCleanup.push(() => target.removeEventListener(type, listener, options));
}

function handleClick(event: MouseEvent): void {
  const element = getClickableElement(event.target);

  if (!element) {
    return;
  }

  saveAction('click', element);
}

function handleInput(event: Event): void {
  const element = getEditableElement(event.target);

  if (!element) {
    return;
  }

  saveAction('input', element, getSafeElementValue(element));
}

function handleChange(event: Event): void {
  const element = getEditableElement(event.target);

  if (!element) {
    return;
  }

  saveAction('change', element, getSafeElementValue(element));
}

function handleSubmit(event: SubmitEvent): void {
  if (!(event.target instanceof HTMLFormElement)) {
    return;
  }

  saveAction('submit', event.target);
}

function handleNavigationChange(): void {
  window.setTimeout(checkForNavigationChange, 0);
}

function checkForNavigationChange(): void {
  if (!isCapturingActions || window.location.href === lastKnownUrl) {
    return;
  }

  lastKnownUrl = window.location.href;
  saveAction('navigation', document.documentElement);
}

function saveAction(type: RecordedActionType, element: HTMLElement, value?: string): void {
  if (!isCapturingActions || !activeSessionId) {
    return;
  }

  const target = describeElement(element);
  const pageUrl = window.location.href;
  const action: RecordedUserAction = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    target,
    targetKey: type === 'navigation' ? `navigation:${pageUrl}` : `${pageUrl}:${target.selector}`,
    value,
    pageUrl,
    text: '',
  };

  console.log(`${DEBUG_PREFIX} action recorded`, {
    type: action.type,
    target: action.target.label,
    pageUrl: action.pageUrl,
  });

  void appendActionToStorage(action, activeSessionId);
}

async function appendActionToStorage(
  incomingAction: RecordedUserAction,
  sessionId: string,
): Promise<UserActionCaptureSession | undefined> {
  let skippedBecauseStopped = false;
  const action = {
    ...incomingAction,
    text: formatRecordedAction(incomingAction),
  };

  console.log(`${DEBUG_PREFIX} action accepted`, {
    currentSessionId: sessionId,
    contentIsRecording: isCapturingActions,
    currentUrl: window.location.href,
    actionUrl: incomingAction.pageUrl,
    actionType: incomingAction.type,
  });

  return updateStoredCaptureSession((session) => {
    if (session?.sessionId === sessionId && session.isRecording === false) {
      skippedBecauseStopped = true;
      return session;
    }

    const nextSession = createOrRepairActiveSession(session, sessionId, activeCaptureTabId);
    const recordedActions = mergeRecordedActions(nextSession.recordedActions, action).slice(-200);

    return {
      ...nextSession,
      currentUrl: action.pageUrl,
      recordedActions,
    };
  }, `content:${action.type}`).then((session) => {
    if (skippedBecauseStopped) {
      console.log(`${DEBUG_PREFIX} action ignored because recording is stopped`, {
        sessionId,
        actionType: action.type,
        recordedActionsLength: session.recordedActions.length,
      });
      return session;
    }

    console.log(`${DEBUG_PREFIX} action saved`, {
      sessionId,
      recordedActionsLength: session.recordedActions.length,
    });
    console.log(`${DEBUG_PREFIX} recordedActions length: ${session.recordedActions.length}`);
    return session;
  }).catch((error: unknown) => {
    console.warn(`${DEBUG_PREFIX} action save failed`, {
      reason: error instanceof Error ? error.message : String(error),
      currentSessionId: sessionId,
      contentIsRecording: isCapturingActions,
      currentUrl: window.location.href,
      actionUrl: action.pageUrl,
      actionType: action.type,
    });
    return undefined;
  });
}

function formatRecordedAction(action: RecordedUserAction): string {
  if (action.type === 'navigation') {
    return `Navigated to ${action.pageUrl}`;
  }

  if (action.type === 'click') {
    return `Clicked ${action.target.label}`;
  }

  if (action.type === 'submit') {
    return 'Submitted form';
  }

  if (action.type === 'manual') {
    return action.text;
  }

  if (!action.value) {
    return `Typed into ${action.target.label}`;
  }

  const valueText = action.value === '[REDACTED]' ? action.value : `"${action.value}"`;
  return `Typed ${valueText} into ${action.target.label}`;
}

async function ensureStoredActiveSession(sessionId: string, tabId?: number): Promise<UserActionCaptureSession> {
  return updateStoredCaptureSession((session) => createOrRepairActiveSession(session, sessionId, tabId), 'content:activate');
}

function createOrRepairActiveSession(
  session: UserActionCaptureSession | undefined,
  sessionId: string,
  tabId?: number,
): UserActionCaptureSession {
  if (session?.sessionId === sessionId) {
    return {
      ...session,
      isRecording: true,
      contentIsRecording: true,
      activeRecordingTabId: typeof tabId === 'number' ? tabId : session.activeRecordingTabId,
      currentSessionId: sessionId,
      startedAt: session.startedAt || new Date().toISOString(),
      currentUrl: window.location.href,
      recordedActions: session.recordedActions,
    };
  }

  return {
    isRecording: true,
    contentIsRecording: true,
    activeRecordingTabId: typeof tabId === 'number' ? tabId : null,
    sessionId,
    currentSessionId: sessionId,
    startedAt: new Date().toISOString(),
    currentUrl: window.location.href,
    recordedActions: [],
  };
}

async function updateStoredCaptureSession(
  updater: (session: UserActionCaptureSession | undefined) => UserActionCaptureSession,
  reason: string,
): Promise<UserActionCaptureSession> {
  const update = recordingStorageWriteChain
    .catch(() => undefined)
    .then(async () => {
      const currentSession = await getStoredCaptureSession();
      const nextSession = updater(currentSession);

      console.log('[BugReportGenerator][state-write]', {
        reason,
        source: 'content script',
        nextState: {
          isRecording: nextSession.isRecording,
          sessionId: nextSession.sessionId,
          activeRecordingTabId: nextSession.activeRecordingTabId,
          recordedActionsLength: nextSession.recordedActions.length,
          currentUrl: nextSession.currentUrl,
        },
      });
      await setStoredCaptureSession(nextSession);
      return nextSession;
    });

  recordingStorageWriteChain = update.catch(() => undefined);
  return update;
}

async function getStoredCaptureSession(): Promise<UserActionCaptureSession | undefined> {
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

async function setStoredCaptureSession(session: UserActionCaptureSession): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [RECORDING_STATE_KEY]: session }, () => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}

function mergeRecordedActions(actions: RecordedUserAction[], action: RecordedUserAction): RecordedUserAction[] {
  const nextActions = [...actions];
  const previousAction = nextActions[nextActions.length - 1];

  if (previousAction && shouldMergeRecordedActions(previousAction, action)) {
    nextActions[nextActions.length - 1] = {
      ...previousAction,
      timestamp: action.timestamp,
      type: previousAction.type === 'input' ? 'input' : action.type,
      value: action.value,
      text: previousAction.type === 'input' && action.type === 'change' ? previousAction.text : action.text,
    };
    return nextActions;
  }

  if (previousAction?.type === 'navigation' && action.type === 'navigation' && previousAction.pageUrl === action.pageUrl) {
    return nextActions;
  }

  nextActions.push(action);
  return nextActions;
}

function shouldMergeRecordedActions(previousAction: RecordedUserAction, action: RecordedUserAction): boolean {
  const previousIsTextInput = previousAction.type === 'input' || previousAction.type === 'change';
  const currentIsTextInput = action.type === 'input' || action.type === 'change';

  return (
    previousIsTextInput &&
    currentIsTextInput &&
    previousAction.targetKey === action.targetKey &&
    previousAction.pageUrl === action.pageUrl
  );
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

function notifyCaptureReady(): void {
  console.log(`${DEBUG_PREFIX} ready`, { url: window.location.href });

  const message: ContentScriptReadyMessage = {
    type: 'CONTENT_SCRIPT_READY',
    url: window.location.href,
  };

  chrome.runtime.sendMessage<ContentScriptReadyMessage, UserActionCaptureResponse>(message, (response) => {
    const runtimeError = chrome.runtime.lastError;

    if (runtimeError?.message) {
      console.warn(`${DEBUG_PREFIX} CONTENT_SCRIPT_READY failed`, runtimeError.message);
      return;
    }

    if (response?.ok && response.session?.isRecording) {
      void resumeActionCapture({
        type: 'RESUME_CAPTURE',
        sessionId: response.session.sessionId,
        tabId: response.session.activeRecordingTabId,
        currentUrl: response.session.currentUrl,
      }).catch((error: unknown) => {
        console.error(`${DEBUG_PREFIX} CONTENT_SCRIPT_READY resume failed`, error);
      });
    }
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

function getClickableElement(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  const clickable = target.closest<HTMLElement>(
    'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [contenteditable="true"]',
  );

  return clickable ?? (target instanceof HTMLElement ? target : undefined);
}

function getEditableElement(target: EventTarget | null): HTMLElement | undefined {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return target;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return target;
  }

  return undefined;
}

function getSafeElementValue(element: HTMLElement): string {
  if (isSensitiveElement(element)) {
    return '[REDACTED]';
  }

  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return element.checked ? 'checked' : 'not checked';
    }

    if (element.type === 'file') {
      return element.files && element.files.length > 0 ? '[FILE SELECTED]' : '[NO FILE SELECTED]';
    }

    return trimCapturedValue(element.value);
  }

  if (element instanceof HTMLTextAreaElement) {
    return trimCapturedValue(element.value);
  }

  if (element instanceof HTMLSelectElement) {
    const selectedOption = element.selectedOptions[0];
    return trimCapturedValue(selectedOption?.textContent || element.value);
  }

  return trimCapturedValue(element.textContent || '');
}

function isSensitiveElement(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'password') {
    return true;
  }

  const searchableValue = [
    element.getAttribute('name'),
    element.id,
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    element.getAttribute('autocomplete'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return SENSITIVE_FIELD_TOKENS.some((token) => searchableValue.includes(token));
}

function trimCapturedValue(value: string): string {
  const normalizedValue = normalizeWhitespace(value);

  if (!normalizedValue) {
    return 'blank';
  }

  return normalizedValue.length > MAX_CAPTURED_VALUE_LENGTH
    ? `${normalizedValue.slice(0, MAX_CAPTURED_VALUE_LENGTH)}...`
    : normalizedValue;
}

function describeElement(element: HTMLElement): RecordedActionTarget {
  const tagName = element.tagName.toLowerCase();

  return {
    tagName,
    selector: getReadableSelector(element),
    label: getReadableLabel(element),
    inputType: element instanceof HTMLInputElement ? element.type : undefined,
  };
}

function getReadableLabel(element: HTMLElement): string {
  const rawLabel =
    getAssociatedLabelText(element) ||
    element.getAttribute('aria-label') ||
    element.getAttribute('placeholder') ||
    getInteractiveText(element) ||
    element.getAttribute('name') ||
    element.id ||
    element.getAttribute('title') ||
    element.tagName.toLowerCase();
  const label = toTitleCase(normalizeWhitespace(rawLabel));

  if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) {
    return ensureSuffix(label, 'button');
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return ensureSuffix(label, 'field');
  }

  if (element instanceof HTMLButtonElement || element.getAttribute('role') === 'button') {
    return ensureSuffix(label, 'button');
  }

  if (element instanceof HTMLAnchorElement || element.getAttribute('role') === 'link') {
    return ensureSuffix(label, 'link');
  }

  if (element instanceof HTMLFormElement) {
    return ensureSuffix(label, 'form');
  }

  return label || `${element.tagName.toLowerCase()} element`;
}

function getAssociatedLabelText(element: HTMLElement): string | undefined {
  if (element.id) {
    const explicitLabel = document.querySelector<HTMLLabelElement>(`label[for="${escapeCssString(element.id)}"]`);

    if (explicitLabel?.textContent) {
      return explicitLabel.textContent;
    }
  }

  const wrappingLabel = element.closest('label');

  if (wrappingLabel?.textContent) {
    return wrappingLabel.textContent;
  }

  const labelledBy = element.getAttribute('aria-labelledby');

  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ');
  }

  return undefined;
}

function getInteractiveText(element: HTMLElement): string | undefined {
  if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) {
    return element.value;
  }

  if (element instanceof HTMLImageElement) {
    return element.alt;
  }

  return element.textContent || undefined;
}

function getReadableSelector(element: HTMLElement): string {
  if (element.id) {
    return `#${escapeCssIdentifier(element.id)}`;
  }

  const dataTestId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');

  if (dataTestId) {
    return `${element.tagName.toLowerCase()}[data-testid="${escapeCssString(dataTestId)}"]`;
  }

  const name = element.getAttribute('name');

  if (name) {
    return `${element.tagName.toLowerCase()}[name="${escapeCssString(name)}"]`;
  }

  const ariaLabel = element.getAttribute('aria-label');

  if (ariaLabel) {
    return `${element.tagName.toLowerCase()}[aria-label="${escapeCssString(ariaLabel)}"]`;
  }

  return getDomPath(element);
}

function getDomPath(element: HTMLElement): string {
  const segments: string[] = [];
  let currentElement: Element | null = element;

  while (currentElement && currentElement instanceof HTMLElement && currentElement !== document.body) {
    const tagName = currentElement.tagName.toLowerCase();
    const parent = currentElement.parentElement;

    if (!parent) {
      segments.unshift(tagName);
      break;
    }

    const siblings = Array.from(parent.children).filter((child) => child.tagName === currentElement?.tagName);
    const index = siblings.indexOf(currentElement) + 1;
    segments.unshift(siblings.length > 1 ? `${tagName}:nth-of-type(${index})` : tagName);
    currentElement = parent;
  }

  return segments.length ? segments.join(' > ') : element.tagName.toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toTitleCase(value: string): string {
  if (!value) {
    return value;
  }

  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ensureSuffix(value: string, suffix: string): string {
  if (!value) {
    return suffix;
  }

  return value.toLowerCase().endsWith(suffix) ? value : `${value} ${suffix}`;
}

function escapeCssIdentifier(value: string): string {
  if ('CSS' in window && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
  return isMessageType(message, 'PING') || isMessageType(message, 'PING_BUG_REPORT_GENERATOR');
}

function isGetPageContextMessage(message: unknown): message is GetPageContextMessage {
  return isMessageType(message, 'GET_PAGE_CONTEXT');
}

function isStartCaptureMessage(message: unknown): message is StartCaptureMessage {
  return isMessageType(message, 'START_CAPTURE') && typeof (message as StartCaptureMessage).sessionId === 'string';
}

function isResumeCaptureMessage(message: unknown): message is ResumeCaptureMessage {
  return isMessageType(message, 'RESUME_CAPTURE') && typeof (message as ResumeCaptureMessage).sessionId === 'string';
}

function isStopCaptureMessage(message: unknown): message is StopCaptureMessage {
  return isMessageType(message, 'STOP_CAPTURE');
}

function isMessageType(message: unknown, type: string): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === type
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
