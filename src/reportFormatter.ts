import type { BugReport, ConsoleEventRecord } from './types';

export function formatBugReportMarkdown(report: BugReport): string {
  return [
    'Title:',
    report.title,
    '',
    'Environment:',
    formatEnvironment(report),
    '',
    'Steps to Reproduce:',
    formatSteps(report.stepsToReproduce),
    '',
    'Expected Result:',
    report.expectedResult,
    '',
    'Actual Result:',
    report.actualResult,
    '',
    'Console Errors:',
    formatConsoleErrors(report.consoleErrors),
    '',
    'Network Errors:',
    formatNetworkErrors(report.networkErrors ?? []),
    '',
    'Additional Notes:',
    report.additionalNotes || report.description || 'None.',
  ].join('\n');
}

function formatSteps(steps: string[]): string {
  return steps.length ? steps.map((step, index) => `${index + 1}. ${step}`).join('\n') : '1. Add reproduction steps.';
}

function formatEnvironment(report: BugReport): string {
  const environment = report.environmentInformation;

  return [
    `- URL: ${report.currentUrl}`,
    `- Browser: ${environment.browserName}`,
    `- OS: ${environment.platform}`,
    `- Screen size: ${environment.screen.width} x ${environment.screen.height}`,
    `- Viewport: ${environment.viewport.width} x ${environment.viewport.height} @ ${environment.viewport.devicePixelRatio}x`,
    `- Page title: ${environment.pageTitle}`,
    `- User agent: ${environment.userAgent}`,
  ].join('\n');
}

function formatConsoleErrors(errors: ConsoleEventRecord[]): string {
  if (!errors.length) {
    return 'No console errors captured.';
  }

  return errors
    .map((error, index) => {
      const location = error.source ? ` (${error.source}${error.line ? `:${error.line}` : ''})` : '';
      const stack = error.stack ? `\n\`\`\`\n${error.stack}\n\`\`\`` : '';
      return `${index + 1}. [${error.level}] ${error.message}${location}\n   Time: ${error.timestamp}${stack}`;
    })
    .join('\n\n');
}

function formatNetworkErrors(errors: string[]): string {
  return errors.length ? errors.map((error, index) => `${index + 1}. ${error}`).join('\n') : 'No network errors captured.';
}
