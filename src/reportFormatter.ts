import type { BugReport, ConsoleEventRecord } from './types';

export function formatBugReportMarkdown(report: BugReport): string {
  return [
    `# ${report.title}`,
    '',
    '## Description',
    report.description,
    '',
    '## Steps to Reproduce',
    formatSteps(report.stepsToReproduce),
    '',
    '## Expected Result',
    report.expectedResult,
    '',
    '## Actual Result',
    report.actualResult,
    '',
    '## Environment Information',
    formatEnvironment(report),
    '',
    '## Console Errors',
    formatConsoleErrors(report.consoleErrors),
    '',
    '## Screenshot',
    report.screenshotDataUrl
      ? `Screenshot captured and stored locally with report ID \`${report.id}\`.`
      : 'No screenshot was captured.',
    '',
    '## Capture Warnings',
    report.warnings.length ? report.warnings.map((warning) => `- ${warning}`).join('\n') : 'None.',
  ].join('\n');
}

function formatSteps(steps: string[]): string {
  return steps.length ? steps.map((step, index) => `${index + 1}. ${step}`).join('\n') : '1. Add reproduction steps.';
}

function formatEnvironment(report: BugReport): string {
  const environment = report.environmentInformation;

  return [
    `- URL: ${report.currentUrl}`,
    `- Page title: ${environment.pageTitle}`,
    `- Browser: ${environment.browserName}`,
    `- User agent: ${environment.userAgent}`,
    `- Platform: ${environment.platform}`,
    `- Language: ${environment.language}`,
    `- Time zone: ${environment.timeZone}`,
    `- Viewport: ${environment.viewport.width} x ${environment.viewport.height} @ ${environment.viewport.devicePixelRatio}x`,
    `- Screen: ${environment.screen.width} x ${environment.screen.height}, ${environment.screen.colorDepth}-bit color`,
    `- Cookies enabled: ${environment.cookieEnabled ? 'Yes' : 'No'}`,
    `- Do Not Track: ${environment.doNotTrack || 'Not set'}`,
    `- Captured at: ${environment.capturedAt}`,
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
