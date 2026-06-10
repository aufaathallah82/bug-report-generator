export type ConsoleEventLevel = 'console.error' | 'runtime-error' | 'unhandled-rejection' | 'resource-error';

export interface ConsoleEventRecord {
  id: string;
  level: ConsoleEventLevel;
  message: string;
  timestamp: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  arguments?: string[];
}

export interface BrowserEnvironment {
  url: string;
  pageTitle: string;
  userAgent: string;
  browserName: string;
  platform: string;
  language: string;
  cookieEnabled: boolean;
  doNotTrack: string | null;
  timeZone: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
  };
  capturedAt: string;
}

export interface BugReportDraft {
  title: string;
  description: string;
  stepsToReproduce: string[];
  expectedResult: string;
  actualResult: string;
}

export interface BugReport {
  id: string;
  title: string;
  description: string;
  stepsToReproduce: string[];
  expectedResult: string;
  actualResult: string;
  environmentInformation: BrowserEnvironment;
  currentUrl: string;
  screenshotDataUrl?: string;
  consoleErrors: ConsoleEventRecord[];
  createdAt: string;
  warnings: string[];
}

export interface PageContextResponse {
  environment: BrowserEnvironment;
  consoleErrors: ConsoleEventRecord[];
}

export interface GenerateBugReportMessage {
  type: 'GENERATE_BUG_REPORT';
  draft: BugReportDraft;
}

export interface GetPageContextMessage {
  type: 'GET_PAGE_CONTEXT';
}

export interface PingContentScriptMessage {
  type: 'PING_BUG_REPORT_GENERATOR';
}

export interface GenerateBugReportResponse {
  ok: boolean;
  report?: BugReport;
  error?: string;
}

export const BUG_REPORTS_STORAGE_KEY = 'bugReportGenerator.reports';
export const MAX_STORED_REPORTS = 25;
