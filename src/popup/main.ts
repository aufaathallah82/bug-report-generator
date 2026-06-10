import './styles.css';
import { formatBugReportMarkdown } from '../reportFormatter';
import type { BugReport, BugReportDraft, GenerateBugReportMessage, GenerateBugReportResponse } from '../types';
import { BUG_REPORTS_STORAGE_KEY } from '../types';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Popup root element was not found.');
}

let currentReport: BugReport | undefined;
let savedReports: BugReport[] = [];

app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">Local capture MVP</p>
      <h1>Bug Report Generator</h1>
      <p class="lede">Capture the active tab, screenshot, browser context, and console errors into a structured report.</p>
    </header>

    <section class="card form-card" aria-labelledby="report-form-title">
      <div class="section-heading">
        <h2 id="report-form-title">Report Draft</h2>
        <span class="local-pill">Local only</span>
      </div>

      <label>
        <span>Title</span>
        <input id="title" type="text" placeholder="Short issue summary" autocomplete="off" />
      </label>

      <label>
        <span>Description</span>
        <textarea id="description" rows="3" placeholder="What is wrong or confusing?"></textarea>
      </label>

      <label>
        <span>Steps to Reproduce</span>
        <textarea id="steps" rows="4" placeholder="One step per line"></textarea>
      </label>

      <label>
        <span>Expected Result</span>
        <textarea id="expected" rows="2" placeholder="What should happen?"></textarea>
      </label>

      <label>
        <span>Actual Result</span>
        <textarea id="actual" rows="2" placeholder="What happened instead?"></textarea>
      </label>

      <div class="actions">
        <button id="generate" class="primary" type="button">Generate Report</button>
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

const titleInput = getElement<HTMLInputElement>('title');
const descriptionInput = getElement<HTMLTextAreaElement>('description');
const stepsInput = getElement<HTMLTextAreaElement>('steps');
const expectedInput = getElement<HTMLTextAreaElement>('expected');
const actualInput = getElement<HTMLTextAreaElement>('actual');
const generateButton = getElement<HTMLButtonElement>('generate');
const clearButton = getElement<HTMLButtonElement>('clear');
const statusElement = getElement<HTMLParagraphElement>('status');
const reportElement = getElement<HTMLElement>('report');
const savedListElement = getElement<HTMLDivElement>('saved-list');

generateButton.addEventListener('click', () => {
  void generateReport();
});

clearButton.addEventListener('click', () => {
  void clearSavedReports();
});

void loadSavedReports();

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
    title: titleInput.value,
    description: descriptionInput.value,
    stepsToReproduce: stepsInput.value
      .split('\n')
      .map((step) => step.trim())
      .filter(Boolean),
    expectedResult: expectedInput.value,
    actualResult: actualInput.value,
  };
}

function renderReport(report: BugReport): void {
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
        <div><dt>Viewport</dt><dd>${report.environmentInformation.viewport.width} x ${report.environmentInformation.viewport.height}</dd></div>
        <div><dt>Console errors</dt><dd>${report.consoleErrors.length}</dd></div>
      </dl>
    </article>

    <div class="two-column">
      <section>
        <h3>Steps</h3>
        <ol>${report.stepsToReproduce.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      </section>
      <section>
        <h3>Environment</h3>
        <p class="compact-text">${escapeHtml(report.environmentInformation.userAgent)}</p>
      </section>
    </div>

    <section>
      <h3>Screenshot</h3>
      ${
        report.screenshotDataUrl
          ? `<img class="screenshot" src="${report.screenshotDataUrl}" alt="Captured screenshot of the current tab" />`
          : '<p class="compact-text">Screenshot unavailable for this page.</p>'
      }
    </section>

    <section>
      <h3>Console Errors</h3>
      ${renderConsoleErrors(report)}
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
  generateButton.disabled = isLoading;
  generateButton.textContent = isLoading ? 'Capturing...' : 'Generate Report';
}

function setStatus(message: string, tone: 'success' | 'error' | 'muted'): void {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
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
