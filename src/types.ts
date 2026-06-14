export type ConsoleEventLevel = 'console.error' | 'runtime-error' | 'unhandled-rejection' | 'resource-error';
export type RecordedActionType = 'click' | 'input' | 'change' | 'submit' | 'navigation' | 'manual';

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

export interface RecordedActionTarget {
  tagName: string;
  selector: string;
  label: string;
  inputType?: string;
}

export interface RecordedUserAction {
  id: string;
  timestamp: string;
  type: RecordedActionType;
  target: RecordedActionTarget;
  targetKey: string;
  value?: string;
  pageUrl: string;
  text: string;
}

export interface UserActionCaptureSession {
  isRecording: boolean;
  contentIsRecording?: boolean;
  activeRecordingTabId: number | null;
  sessionId: string | null;
  currentSessionId?: string | null;
  recordedActions: RecordedUserAction[];
  startedAt: string | null;
  currentUrl: string | null;
  stoppedAt?: string;
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
  stepsToReproduce: string[];
  expectedResult: string;
  actualResult: string;
  additionalNotes: string;
}

export interface BugReport {
  id: string;
  title: string;
  description: string;
  stepsToReproduce: string[];
  expectedResult: string;
  actualResult: string;
  additionalNotes: string;
  environmentInformation: BrowserEnvironment;
  currentUrl: string;
  screenshotDataUrl?: string;
  consoleErrors: ConsoleEventRecord[];
  networkErrors: string[];
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

export interface StartCaptureMessage {
  type: 'START_CAPTURE';
  sessionId?: string;
  tabId?: number;
}

export interface StopCaptureMessage {
  type: 'STOP_CAPTURE';
  sessionId?: string;
}

export interface ResumeCaptureMessage {
  type: 'RESUME_CAPTURE';
  sessionId: string;
  tabId: number;
  currentUrl: string;
}

export interface GetUserActionCaptureStateMessage {
  type: 'GET_USER_ACTION_CAPTURE_STATE';
}

export interface GetRecordingStateMessage {
  type: 'GET_RECORDING_STATE';
}

export interface UpdateRecordedActionsMessage {
  type: 'UPDATE_RECORDED_ACTIONS';
  recordedActions: RecordedUserAction[];
}

export interface ContentScriptReadyMessage {
  type: 'CONTENT_SCRIPT_READY';
  url: string;
}

export interface ActionRecordedMessage {
  type: 'ACTION_RECORDED';
  sessionId: string;
  action: RecordedUserAction;
}

export interface NavigationDetectedMessage {
  type: 'NAVIGATION_DETECTED';
  sessionId: string;
  url: string;
}

export interface GetPageContextMessage {
  type: 'GET_PAGE_CONTEXT';
}

export interface PingContentScriptMessage {
  type: 'PING' | 'PING_BUG_REPORT_GENERATOR';
}

export interface GenerateBugReportResponse {
  ok: boolean;
  report?: BugReport;
  error?: string;
}

export interface UserActionCaptureResponse {
  ok: boolean;
  session?: UserActionCaptureSession;
  error?: string;
}

export const BUG_REPORTS_STORAGE_KEY = 'bugReportGenerator.reports';
export const RECORDING_STATE_KEY = 'bugReportGenerator.recordingState';
export const MAX_STORED_REPORTS = 25;
