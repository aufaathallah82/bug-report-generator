import './styles.css';
import { formatBugReportMarkdown } from '../reportFormatter';
import type {
  BugReport,
  BugReportDraft,
  GenerateBugReportMessage,
  GenerateBugReportResponse,
  RecordedActionType,
  RecordedUserAction,
  UpdateRecordedActionsMessage,
  UserActionCaptureResponse,
  UserActionCaptureSession,
} from '../types';
import { BUG_REPORTS_STORAGE_KEY, RECORDING_STATE_KEY } from '../types';

const DEBUG_PREFIX = '[BugReportGenerator][popup]';
const DEBUG_MODE = false;
const UNSUPPORTED_CAPTURE_PAGE_MESSAGE = 'This page cannot be captured. Please open a normal website tab.';
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Popup root element was not found.');
}

console.log(`${DEBUG_PREFIX} popup opened`);

let currentReport: BugReport | undefined;
let savedReports: BugReport[] = [];
let captureSession: UserActionCaptureSession | undefined;
let actionSteps: string[] = [];
let isRecording = false;
let isCaptureBusy = false;
let isCaptureStateLoading = true;

interface CaptureStateLoadResult {
  rawState: unknown;
  session: UserActionCaptureSession | undefined;
}

app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">Local capture</p>
      <h1>Bug Report Generator</h1>
      <p class="lede">Record browser actions, edit the reproduction timeline, and generate a structured local report.</p>
    </header>

    <section class="card capture-card" aria-labelledby="capture-title">
      <div class="section-heading">
        <h2 id="capture-title">Capture</h2>
        <span id="capture-pill" class="local-pill">Loading</span>
      </div>
      <div class="actions two-actions">
        <button id="start-capture" class="primary" type="button">Start Capture</button>
        <button id="stop-capture" class="secondary" type="button">Stop Capture</button>
      </div>
      <button id="log-recording-state" class="link-button" type="button">Log Recording State</button>
      <p id="capture-status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section class="card timeline-card" aria-labelledby="timeline-title">
      <div class="section-heading">
        <h2 id="timeline-title">Action Timeline</h2>
        <div class="heading-actions">
          <button id="refresh-timeline" class="link-button" type="button">Refresh timeline</button>
          <button id="add-step" class="link-button" type="button">Add step</button>
        </div>
      </div>
      <div id="timeline-list" class="timeline-list"></div>
    </section>

    <section class="card form-card" aria-labelledby="report-form-title">
      <div class="section-heading">
        <h2 id="report-form-title">Bug Context</h2>
        <span class="local-pill">Local only</span>
      </div>

      <label>
        <span>Bug Summary</span>
        <input id="summary" type="text" placeholder="Short issue summary" autocomplete="off" />
      </label>

      <label>
        <span>Expected Result</span>
        <textarea id="expected" rows="2" placeholder="What should happen?"></textarea>
      </label>

      <label>
        <span>Actual Result</span>
        <textarea id="actual" rows="2" placeholder="What happened instead?"></textarea>
      </label>

      <label>
        <span>Additional Notes</span>
        <textarea id="notes" rows="3" placeholder="Relevant data, accounts, screenshots, or constraints"></textarea>
      </label>

      <div class="actions">
        <button id="generate" class="primary" type="button">Generate Bug Report</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section id="report" class="card report-card is-empty" aria-live="polite">
      <div class="empty-state">Generate a report to preview captured details.</div>
    </section>

    <section class="card saved-card" aria-labelledby="saved-title">
      <div class="section-heading">
        <h2 id="saved-title">Saved Reports</h2>
        <button id="clear" class="link-button" type="button">Clear</button>
      </div>
      <div id="saved-list" class="saved-list"></div>
    </section>
  </main>
`;

const summaryInput = getElement<HTMLInputElement>('summary');
const expectedInput = getElement<HTMLTextAreaElement>('expected');
const actualInput = getElement<HTMLTextAreaElement>('actual');
const notesInput = getElement<HTMLTextAreaElement>('notes');
const startCaptureButton = getElement<HTMLButtonElement>('start-capture');
const stopCaptureButton = getElement<HTMLButtonElement>('stop-capture');
const logRecordingStateButton = getElement<HTMLButtonElement>('log-recording-state');
const refreshTimelineButton = getElement<HTMLButtonElement>('refresh-timeline');
const addStepButton = getElement<HTMLButtonElement>('add-step');
const capturePillElement = getElement<HTMLSpanElement>('capture-pill');
const captureStatusElement = getElement<HTMLParagraphElement>('capture-status');
const generateButton = getElement<HTMLButtonElement>('generate');
const clearButton = getElement<HTMLButtonElement>('clear');
const statusElement = getElement<HTMLParagraphElement>('status');
const reportElement = getElement<HTMLElement>('report');
const savedListElement = getElement<HTMLDivElement>('saved-list');
const timelineListElement = getElement<HTMLDivElement>('timeline-list');

startCaptureButton.addEventListener('click', () => {
  void startCapture();
});

stopCaptureButton.addEventListener('click', () => {
  void stopCapture();
});

logRecordingStateButton.addEventListener('click', () => {
  void logRecordingState();
});

refreshTimelineButton.addEventListener('click', () => {
  console.log(`${DEBUG_PREFIX} Refresh Timeline clicked`);
  void loadCaptureState('Timeline refreshed from local storage.');
});

addStepButton.addEventListener('click', () => {
  actionSteps.push('Manual step');
  renderTimeline(actionSteps.length - 1);
  void persistTimelineToStorage();
  setCaptureStatus('Manual step added.', 'muted');
});

generateButton.addEventListener('click', () => {
  void generateReport();
});

clearButton.addEventListener('click', () => {
  void clearSavedReports();
});

attachRecordingStorageListener();
void initializePopup();
updateCaptureControls();
setCaptureStatus('Loading capture state...', 'muted');

async function initializePopup(): Promise<void> {
  await Promise.all([loadSavedReports(), loadCaptureState()]);
}

async function startCapture(): Promise<void> {
  isCaptureStateLoading = false;
  setCaptureBusy(true);
  setCaptureStatus('Starting capture...', 'muted');
  console.log(`${DEBUG_PREFIX} Start clicked`);
  console.log(`${DEBUG_PREFIX} START_CAPTURE sent`);

  try {
    const response = await sendRuntimeMessage<{ type: 'START_CAPTURE' }, UserActionCaptureResponse>({
      type: 'START_CAPTURE',
    });

    if (!response?.ok || !response.session) {
      throw new Error(response?.error || 'Capture could not be started.');
    }

    captureSession = response.session;
    actionSteps = response.session.recordedActions.map(formatTimelineAction).filter(Boolean);
    isRecording = true;
    renderTimeline();
    updateCaptureControls();
    setCaptureStatus('Recording', 'success');
  } catch (error) {
    isRecording = false;
    updateCaptureControls();
    setCaptureStatus(getFriendlyCaptureError(error, 'Capture could not be started.'), 'error');
  } finally {
    setCaptureBusy(false);
  }
}

async function stopCapture(): Promise<void> {
  setCaptureBusy(true);
  setCaptureStatus('Stopping capture...', 'muted');
  console.log(`${DEBUG_PREFIX} Stop Capture clicked`);
  console.log(`${DEBUG_PREFIX} STOP_CAPTURE sent`);

  try {
    const response = await sendRuntimeMessage<{ type: 'STOP_CAPTURE' }, UserActionCaptureResponse>({
      type: 'STOP_CAPTURE',
    });

    if (!response?.ok || !response.session) {
      throw new Error(response?.error || 'Capture could not be stopped.');
    }

    await loadCaptureState();
    console.log(`${DEBUG_PREFIX} loaded stopped state`, {
      recordedActionsLength: actionSteps.length,
    });
    setCaptureStatus(`${actionSteps.length} step${actionSteps.length === 1 ? '' : 's'} ready to edit.`, 'success');
  } catch (error) {
    setCaptureStatus(getFriendlyCaptureError(error, 'Capture could not be stopped.'), 'error');
  } finally {
    setCaptureBusy(false);
  }
}

async function loadCaptureState(successMessage?: string): Promise<void> {
  try {
    const { rawState, session } = await getStoredCaptureState();
    applyLoadedCaptureState(session, rawState, 'load', successMessage);
  } catch (error) {
    isCaptureStateLoading = false;
    renderTimeline();
    updateCaptureControls();
    setCaptureStatus(error instanceof Error ? error.message : 'Capture state could not be loaded.', 'error');
  }
}

function attachRecordingStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    const recordingStateChange = changes[RECORDING_STATE_KEY];

    if (!recordingStateChange) {
      return;
    }

    const session = normalizeCaptureSession(recordingStateChange.newValue);

    console.log(`${DEBUG_PREFIX} recordingState changed`, {
      key: RECORDING_STATE_KEY,
      oldValue: recordingStateChange.oldValue,
      newValue: recordingStateChange.newValue,
    });
    applyLoadedCaptureState(session, recordingStateChange.newValue, 'storage-change');
    console.log(`${DEBUG_PREFIX} storage changed, timeline updated`, {
      recordedActionsLength: session?.recordedActions.length ?? 0,
      editableTimelineLength: actionSteps.length,
    });
  });
}

function applyLoadedCaptureState(
  session: UserActionCaptureSession | undefined,
  rawState: unknown,
  source: string,
  successMessage?: string,
): void {
  captureSession = session;
  isRecording = session?.isRecording === true;
  actionSteps = session?.recordedActions.map(formatTimelineAction).filter(Boolean) ?? [];
  isCaptureStateLoading = false;

  console.log(`${DEBUG_PREFIX} loaded recording state`, {
    source,
    key: RECORDING_STATE_KEY,
    rawState,
    isRecording,
    sessionId: captureSession?.sessionId,
    activeRecordingTabId: captureSession?.activeRecordingTabId,
    recordedActionsLength: captureSession?.recordedActions.length ?? 0,
    timelineLength: actionSteps.length,
  });
  console.log(`${DEBUG_PREFIX} isRecording:`, isRecording);
  console.log(`${DEBUG_PREFIX} recordedActions length:`, captureSession?.recordedActions.length ?? 0);

  renderTimeline();
  updateCaptureControls();

  if (successMessage) {
    setCaptureStatus(successMessage, 'success');
  } else if (isRecording) {
    setCaptureStatus('Recording', 'success');
  } else if (actionSteps.length > 0) {
    setCaptureStatus(`${actionSteps.length} saved step${actionSteps.length === 1 ? '' : 's'} ready to edit.`, 'muted');
  } else {
    setCaptureStatus('Capture is idle.', 'muted');
  }
}

async function logRecordingState(): Promise<void> {
  const { rawState, session } = await getStoredCaptureState();

  console.log(`${DEBUG_PREFIX} canonical recording state`, {
    key: RECORDING_STATE_KEY,
    rawState,
    isRecording: session?.isRecording,
    sessionId: session?.sessionId,
    activeRecordingTabId: session?.activeRecordingTabId,
    recordedActionsLength: session?.recordedActions.length ?? 0,
    currentUrl: session?.currentUrl,
  });
  applyLoadedCaptureState(session, rawState, 'log-button');
  setCaptureStatus('Recording state logged to popup console.', 'muted');
}

async function generateReport(): Promise<void> {
  setLoading(true);
  setStatus('Capturing active tab...', 'muted');

  try {
    const response = await sendRuntimeMessage<GenerateBugReportMessage, GenerateBugReportResponse>({
      type: 'GENERATE_BUG_REPORT',
      draft: readDraft(),
    });

    if (!response?.ok || !response.report) {
      throw new Error(response?.error || 'Report generation failed.');
    }

    currentReport = response.report;
    renderReport(response.report);
    await loadSavedReports();
    setStatus('Report generated and saved locally.', 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Report generation failed.', 'error');
  } finally {
    setLoading(false);
  }
}

async function copyReportMarkdown(report: BugReport): Promise<void> {
  try {
    await navigator.clipboard.writeText(formatBugReportMarkdown(report));
    setStatus('Markdown copied to clipboard.', 'success');
  } catch {
    setStatus('Clipboard access failed. The report is still saved locally.', 'error');
  }
}

async function loadSavedReports(): Promise<void> {
  savedReports = await getStoredReports();
  renderSavedReports();
}

async function clearSavedReports(): Promise<void> {
  await removeStorageValue(BUG_REPORTS_STORAGE_KEY);
  savedReports = [];
  currentReport = undefined;
  reportElement.className = 'card report-card is-empty';
  reportElement.innerHTML = '<div class="empty-state">Saved reports cleared. Generate a new report to preview captured details.</div>';
  renderSavedReports();
  setStatus('Saved reports cleared from local storage.', 'muted');
}

function readDraft(): BugReportDraft {
  return {
    title: summaryInput.value,
    stepsToReproduce: actionSteps.map((step) => step.trim()).filter(Boolean),
    expectedResult: expectedInput.value,
    actualResult: actualInput.value,
    additionalNotes: notesInput.value,
  };
}

function renderTimeline(focusIndex?: number): void {
  console.log(`${DEBUG_PREFIX} timeline loaded`, { steps: actionSteps.length, isRecording });
  console.log(`${DEBUG_PREFIX} rendered timeline length:`, actionSteps.length);

  if (!actionSteps.length) {
    timelineListElement.innerHTML = '<p class="compact-text">No editable steps yet.</p>';
    updateCaptureControls();
    return;
  }

  timelineListElement.innerHTML = actionSteps
    .map(
      (step, index) => `
        <article class="timeline-step">
          <span class="step-number">${index + 1}</span>
          <textarea class="step-editor" rows="2" data-step-index="${index}" ${isRecording ? 'disabled' : ''}>${escapeHtml(step)}</textarea>
          <div class="step-controls" aria-label="Step controls">
            <button class="icon-button move-up" type="button" data-step-index="${index}" aria-label="Move step up" ${isRecording ? 'disabled' : ''}>Up</button>
            <button class="icon-button move-down" type="button" data-step-index="${index}" aria-label="Move step down" ${isRecording ? 'disabled' : ''}>Down</button>
            <button class="icon-button delete-step" type="button" data-step-index="${index}" aria-label="Delete step" ${isRecording ? 'disabled' : ''}>Delete</button>
          </div>
        </article>
      `,
    )
    .join('');

  timelineListElement.querySelectorAll<HTMLTextAreaElement>('.step-editor').forEach((textarea) => {
    textarea.addEventListener('input', () => {
      const index = getStepIndex(textarea);
      actionSteps[index] = textarea.value;
      void persistTimelineToStorage();
    });
  });

  timelineListElement.querySelectorAll<HTMLButtonElement>('.delete-step').forEach((button) => {
    button.addEventListener('click', () => {
      const index = getStepIndex(button);
      actionSteps.splice(index, 1);
      renderTimeline(Math.min(index, actionSteps.length - 1));
      void persistTimelineToStorage();
    });
  });

  timelineListElement.querySelectorAll<HTMLButtonElement>('.move-up').forEach((button) => {
    button.disabled = button.disabled || Number(button.dataset.stepIndex) === 0;
    button.addEventListener('click', () => {
      const index = getStepIndex(button);

      if (index <= 0) {
        return;
      }

      swapSteps(index, index - 1);
      renderTimeline(index - 1);
      void persistTimelineToStorage();
    });
  });

  timelineListElement.querySelectorAll<HTMLButtonElement>('.move-down').forEach((button) => {
    button.disabled = button.disabled || Number(button.dataset.stepIndex) === actionSteps.length - 1;
    button.addEventListener('click', () => {
      const index = getStepIndex(button);

      if (index >= actionSteps.length - 1) {
        return;
      }

      swapSteps(index, index + 1);
      renderTimeline(index + 1);
      void persistTimelineToStorage();
    });
  });

  if (typeof focusIndex === 'number' && focusIndex >= 0) {
    timelineListElement.querySelector<HTMLTextAreaElement>(`.step-editor[data-step-index="${focusIndex}"]`)?.focus();
  }

  updateCaptureControls();
}

async function persistTimelineToStorage(): Promise<void> {
  if (!captureSession || isRecording) {
    return;
  }

  const nextActions = actionSteps.map((step, index) => {
    const existingAction = captureSession?.recordedActions[index];
    return existingAction ? { ...existingAction, text: step } : createManualAction(step);
  });
  captureSession = {
    ...captureSession,
    recordedActions: nextActions,
  };

  const response = await sendRuntimeMessage<UpdateRecordedActionsMessage, UserActionCaptureResponse>({
    type: 'UPDATE_RECORDED_ACTIONS',
    recordedActions: nextActions,
  });

  if (response?.ok && response.session) {
    captureSession = response.session;
  }
}

function createManualAction(text: string): RecordedUserAction {
  const pageUrl = captureSession?.currentUrl || 'Manual step';
  const id = crypto.randomUUID();

  return {
    id,
    timestamp: new Date().toISOString(),
    type: 'manual',
    pageUrl,
    targetKey: `manual:${id}`,
    target: {
      tagName: 'manual',
      selector: 'manual',
      label: 'manual step',
    },
    text,
  };
}

function renderReport(report: BugReport): void {
  const networkErrors = report.networkErrors ?? [];
  const additionalNotes = report.additionalNotes || report.description || 'None.';
  reportElement.className = 'card report-card';

  reportElement.innerHTML = `
    <div class="section-heading">
      <h2>Report Preview</h2>
      <span class="timestamp">${formatDate(report.createdAt)}</span>
    </div>

    <article class="preview-block">
      <h3>${escapeHtml(report.title)}</h3>
      <dl class="meta-grid">
        <div><dt>URL</dt><dd>${escapeHtml(report.currentUrl)}</dd></div>
        <div><dt>Browser</dt><dd>${escapeHtml(report.environmentInformation.browserName)}</dd></div>
        <div><dt>OS</dt><dd>${escapeHtml(report.environmentInformation.platform)}</dd></div>
        <div><dt>Screen</dt><dd>${report.environmentInformation.screen.width} x ${report.environmentInformation.screen.height}</dd></div>
      </dl>
    </article>

    <section>
      <h3>Steps to Reproduce</h3>
      <ol>${report.stepsToReproduce.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    </section>

    <div class="two-column">
      <section>
        <h3>Expected Result</h3>
        <p class="compact-text">${escapeHtml(report.expectedResult)}</p>
      </section>
      <section>
        <h3>Actual Result</h3>
        <p class="compact-text">${escapeHtml(report.actualResult)}</p>
      </section>
    </div>

    <section>
      <h3>Console Errors</h3>
      ${renderConsoleErrors(report)}
    </section>

    <section>
      <h3>Network Errors</h3>
      ${renderNetworkErrors(networkErrors)}
    </section>

    <section>
      <h3>Additional Notes</h3>
      <p class="compact-text">${escapeHtml(additionalNotes)}</p>
    </section>

    <section>
      <h3>Screenshot</h3>
      ${
        report.screenshotDataUrl
          ? `<img class="screenshot" src="${report.screenshotDataUrl}" alt="Captured screenshot of the current tab" />`
          : '<p class="compact-text">Screenshot unavailable for this page.</p>'
      }
    </section>

    <div class="preview-actions">
      <button id="preview-copy" class="secondary" type="button">Copy Markdown</button>
    </div>

    ${renderWarnings(report)}
  `;

  getElement<HTMLButtonElement>('preview-copy').addEventListener('click', () => {
    void copyReportMarkdown(report);
  });
}

function renderConsoleErrors(report: BugReport): string {
  if (!report.consoleErrors.length) {
    return '<p class="compact-text">No console errors captured.</p>';
  }

  return `<ul class="error-list">${report.consoleErrors
    .map(
      (error) => `
        <li>
          <span class="error-level">${escapeHtml(error.level)}</span>
          <p>${escapeHtml(error.message)}</p>
          <small>${escapeHtml(formatErrorLocation(error.source, error.line, error.column))}</small>
        </li>
      `,
    )
    .join('')}</ul>`;
}

function renderNetworkErrors(networkErrors: string[]): string {
  if (!networkErrors.length) {
    return '<p class="compact-text">No network errors captured.</p>';
  }

  return `<ul>${networkErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>`;
}

function renderWarnings(report: BugReport): string {
  if (!report.warnings.length) {
    return '';
  }

  return `
    <section class="warnings">
      <h3>Capture Warnings</h3>
      <ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>
    </section>
  `;
}

function renderSavedReports(): void {
  if (!savedReports.length) {
    savedListElement.innerHTML = '<p class="compact-text">No local reports yet.</p>';
    return;
  }

  savedListElement.innerHTML = savedReports
    .map(
      (report) => `
        <button class="saved-report" type="button" data-report-id="${report.id}">
          <span>${escapeHtml(report.title)}</span>
          <small>${formatDate(report.createdAt)}</small>
        </button>
      `,
    )
    .join('');

  savedListElement.querySelectorAll<HTMLButtonElement>('.saved-report').forEach((button) => {
    button.addEventListener('click', () => {
      const report = savedReports.find((candidate) => candidate.id === button.dataset.reportId);

      if (!report) {
        return;
      }

      currentReport = report;
      renderReport(report);
      void copyReportMarkdown(report);
    });
  });
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

async function getStoredCaptureSession(): Promise<UserActionCaptureSession | undefined> {
  const { session } = await getStoredCaptureState();
  return session;
}

async function getStoredCaptureState(): Promise<CaptureStateLoadResult> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({ [RECORDING_STATE_KEY]: undefined }, (items) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      const rawState = items[RECORDING_STATE_KEY];
      resolve({
        rawState,
        session: normalizeCaptureSession(rawState),
      });
    });
  });
}

async function removeStorageValue(key: string): Promise<void> {
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

async function sendRuntimeMessage<TMessage, TResponse>(message: TMessage): Promise<TResponse | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: TResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

function setLoading(isLoading: boolean): void {
  generateButton.disabled = isLoading || isRecording;
  generateButton.textContent = isLoading ? 'Capturing...' : 'Generate Bug Report';
  startCaptureButton.disabled = isLoading || isCaptureStateLoading || isCaptureBusy || isRecording;
  stopCaptureButton.disabled = isLoading || isCaptureStateLoading || isCaptureBusy || !isRecording;
}

function setCaptureBusy(isBusy: boolean): void {
  isCaptureBusy = isBusy;
  updateCaptureControls();
}

function updateCaptureControls(): void {
  startCaptureButton.disabled = isCaptureStateLoading || isCaptureBusy || isRecording;
  stopCaptureButton.disabled = isCaptureStateLoading || isCaptureBusy || !isRecording;
  generateButton.disabled = isCaptureStateLoading || isRecording;
  addStepButton.disabled = isCaptureStateLoading || isRecording;
  refreshTimelineButton.disabled = isCaptureStateLoading || isCaptureBusy;
  logRecordingStateButton.disabled = isCaptureStateLoading;
  capturePillElement.textContent = isCaptureStateLoading ? 'Loading' : isRecording ? 'Recording' : 'Idle';
  capturePillElement.dataset.state = isCaptureStateLoading ? 'loading' : isRecording ? 'recording' : 'idle';
}

function setStatus(message: string, tone: 'success' | 'error' | 'muted'): void {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
}

function setCaptureStatus(message: string, tone: 'success' | 'error' | 'muted'): void {
  captureStatusElement.textContent = message;
  captureStatusElement.dataset.tone = tone;
}

function swapSteps(firstIndex: number, secondIndex: number): void {
  const firstStep = actionSteps[firstIndex];
  actionSteps[firstIndex] = actionSteps[secondIndex];
  actionSteps[secondIndex] = firstStep;
}

function getStepIndex(element: HTMLElement): number {
  return Number(element.dataset.stepIndex || '0');
}

function formatTimelineAction(action: RecordedUserAction): string {
  const existingText = action.text?.trim();

  if (existingText) {
    return existingText;
  }

  const targetLabel = action.target.label || 'element';

  if (action.type === 'navigation') {
    return `Navigated to ${action.pageUrl}`;
  }

  if (action.type === 'click') {
    return `Clicked ${targetLabel}`;
  }

  if (action.type === 'submit') {
    return 'Submitted form';
  }

  if (action.type === 'manual') {
    return action.text;
  }

  if (!action.value) {
    return `Typed into ${targetLabel}`;
  }

  const valueText = action.value === '[REDACTED]' ? action.value : `"${action.value}"`;
  return `Typed ${valueText} into ${targetLabel}`;
}

function normalizeCaptureSession(value: unknown): UserActionCaptureSession | undefined {
  const candidate = toRecord(value);

  if (!candidate) {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const recordedActions = value.map(normalizeRecordedAction).filter(isRecordedUserAction);

    return recordedActions.length
      ? {
          isRecording: false,
          activeRecordingTabId: null,
          sessionId: null,
          recordedActions,
          startedAt: null,
          currentUrl: recordedActions[recordedActions.length - 1]?.pageUrl ?? null,
        }
      : undefined;
  }

  const sessionId = getString(candidate.sessionId) ?? getString(candidate.currentSessionId) ?? getString(candidate.id);
  const activeRecordingTabId =
    getNumber(candidate.activeRecordingTabId) ?? getNumber(candidate.currentTabId) ?? getNumber(candidate.tabId);
  const rawRecordedActions = Array.isArray(candidate.recordedActions)
    ? candidate.recordedActions
    : Array.isArray(candidate.actions)
      ? candidate.actions
      : [];
  const recordedActions = rawRecordedActions.map(normalizeRecordedAction).filter(isRecordedUserAction);
  const isRecording =
    candidate.isRecording === true || candidate.contentIsRecording === true || candidate.active === true;
  const hasKnownRecordingState =
    typeof candidate.isRecording === 'boolean' ||
    typeof candidate.contentIsRecording === 'boolean' ||
    typeof candidate.active === 'boolean';

  if (!hasKnownRecordingState && !sessionId && !recordedActions.length) {
    return undefined;
  }

  return {
    isRecording,
    activeRecordingTabId: activeRecordingTabId ?? null,
    sessionId: sessionId ?? null,
    recordedActions,
    startedAt: getString(candidate.startedAt) ?? null,
    currentUrl: getString(candidate.currentUrl) ?? getString(candidate.url) ?? recordedActions[recordedActions.length - 1]?.pageUrl ?? null,
    stoppedAt: getString(candidate.stoppedAt),
  };
}

function normalizeRecordedAction(value: unknown, index: number): RecordedUserAction | undefined {
  if (typeof value === 'string') {
    return createManualAction(value);
  }

  const candidate = toRecord(value);

  if (!candidate) {
    return undefined;
  }

  const type = normalizeActionType(getString(candidate.type) ?? getString(candidate.actionType));
  const target = normalizeActionTarget(candidate.target ?? candidate.triggerElement ?? candidate.element, type);
  const pageUrl =
    getString(candidate.pageUrl) ??
    getString(candidate.url) ??
    getString(candidate.href) ??
    captureSession?.currentUrl ??
    'Unknown page';
  const id = getString(candidate.id) ?? `recorded-action-${index}-${Date.now()}`;
  const valueText = getString(candidate.value) ?? getString(candidate.inputValue) ?? getString(candidate.textValue);
  const actionWithoutText: RecordedUserAction = {
    id,
    timestamp: getString(candidate.timestamp) ?? new Date().toISOString(),
    type,
    target,
    targetKey: getString(candidate.targetKey) ?? `${pageUrl}:${target.selector}`,
    value: valueText,
    pageUrl,
    text: '',
  };

  return {
    ...actionWithoutText,
    text: getString(candidate.text) ?? getString(candidate.description) ?? formatTimelineAction(actionWithoutText),
  };
}

function normalizeActionType(value: string | undefined): RecordedActionType {
  const normalizedValue = (value || '').toLowerCase();

  if (normalizedValue.includes('navigation') || normalizedValue.includes('navigate')) {
    return 'navigation';
  }

  if (normalizedValue.includes('input') || normalizedValue.includes('type')) {
    return 'input';
  }

  if (normalizedValue.includes('change')) {
    return 'change';
  }

  if (normalizedValue.includes('submit')) {
    return 'submit';
  }

  if (normalizedValue.includes('manual')) {
    return 'manual';
  }

  return 'click';
}

function normalizeActionTarget(value: unknown, actionType: RecordedActionType): RecordedUserAction['target'] {
  if (typeof value === 'string') {
    return {
      tagName: 'element',
      selector: value,
      label: value,
    };
  }

  const candidate = toRecord(value);
  const fallbackLabel = actionType === 'navigation' ? 'page' : 'element';

  if (!candidate) {
    return {
      tagName: actionType === 'navigation' ? 'document' : 'element',
      selector: actionType === 'navigation' ? 'document' : fallbackLabel,
      label: fallbackLabel,
    };
  }

  const label =
    getString(candidate.label) ??
    getString(candidate.name) ??
    getString(candidate.accessibleName) ??
    getString(candidate.text) ??
    getString(candidate.displayName) ??
    fallbackLabel;

  return {
    tagName: getString(candidate.tagName) ?? getString(candidate.tag) ?? 'element',
    selector:
      getString(candidate.selector) ??
      getString(candidate.cssSelector) ??
      getString(candidate.preferredSelector) ??
      label,
    label,
    inputType: getString(candidate.inputType) ?? getString(candidate.type),
  };
}

function isRecordedUserAction(value: RecordedUserAction | undefined): value is RecordedUserAction {
  return Boolean(value);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getFriendlyCaptureError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';

  if (DEBUG_MODE && message) {
    return message;
  }

  if (message.includes(UNSUPPORTED_CAPTURE_PAGE_MESSAGE)) {
    return UNSUPPORTED_CAPTURE_PAGE_MESSAGE;
  }

  if (
    message.includes('Could not establish connection') ||
    message.includes('Receiving end does not exist') ||
    message.includes('Cannot access') ||
    message.includes('chrome://') ||
    message.includes('extensions gallery') ||
    message.includes('Cannot script')
  ) {
    return 'Capture could not start. Please refresh this tab or open a normal website tab.';
  }

  return message || fallback;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatErrorLocation(source: string | undefined, line: number | undefined, column: number | undefined): string {
  if (!source) {
    return 'No source location';
  }

  const lineColumn = line ? `:${line}${column ? `:${column}` : ''}` : '';
  return `${source}${lineColumn}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };

    return entities[character];
  });
}

function getElement<TElement extends HTMLElement>(id: string): TElement {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }

  return element as TElement;
}
